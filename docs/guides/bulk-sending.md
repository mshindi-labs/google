# Bulk sending

The library sends one message per call and does not queue. For batches (for example
rejection emails to every applicant of a closed job), put a queue in front of it. This
guide uses [pg-boss](https://github.com/timgit/pg-boss); any queue with per-key
concurrency and a dead-letter or manual-review path works.

The goals: **never email someone twice**, stay under Gmail's per-user rate limits, and
leave anything ambiguous for a human.

## The pattern

1. Enqueue **one job per recipient**, carrying an **idempotency key**.
2. The worker records the Gmail `messageId` against the key and skips any job whose key
   already has a `messageId`.
3. `SendOutcomeUnknownError` goes to **manual review**; it is never retried.
4. Run **1 to 2 concurrent sends per connection**.

## Idempotency key

Build the key from the business fact, not from the job id:
`ats:rejection:<applicationId>`. The same application can then never receive the same
rejection twice, even if it is enqueued twice by a bug or a retry of the enqueueing code.

```sql
create table email_sends (
  idempotency_key text primary key,
  message_id      text,
  status          text not null default 'pending', -- pending | sent | review
  updated_at      timestamptz not null default now()
);
```

## Worker

```ts
import PgBoss from "pg-boss";
import {
  GoogleLibError,
  RateLimitedError,
  SendOutcomeUnknownError,
} from "@mshindi-labs/google/core";

const boss = new PgBoss(process.env.DATABASE_URL!);
await boss.start();
await boss.createQueue("rejection-email");

// Enqueue: one job per recipient. singletonKey de-duplicates queued jobs.
export async function enqueueRejection(app: Application) {
  const key = `ats:rejection:${app.id}`;
  await db.query(
    "insert into email_sends (idempotency_key) values ($1) on conflict do nothing",
    [key],
  );
  await boss.send(
    "rejection-email",
    {
      key,
      applicationId: app.id,
      tenantId: app.tenantId,
      connectionId: app.connectionId,
    },
    { singletonKey: key, retryLimit: 5, retryBackoff: true },
  );
}

await boss.work(
  "rejection-email",
  // Keep this worker's concurrency at 1-2 (see "Concurrency" below).
  async ([job]) => {
    const { key, applicationId, tenantId, connectionId } = job.data;

    const row = await db.one(
      "select * from email_sends where idempotency_key = $1",
      [key],
    );
    if (row.message_id || row.status === "review") return; // already handled

    try {
      const { messageId } = await gmail.send({
        tenantId,
        connectionId,
        actorId: "system:ats",
        to: [await applicantAddress(applicationId)],
        subject: "Your application",
        html: await renderRejection(applicationId),
        headers: { "X-Ats-Idempotency-Key": key },
      });
      await db.query(
        "update email_sends set message_id = $2, status = 'sent', updated_at = now() where idempotency_key = $1",
        [key, messageId],
      );
    } catch (err) {
      if (err instanceof SendOutcomeUnknownError) {
        // It may or may not have been delivered. Do NOT retry: a human checks the
        // mailbox's Sent folder, then marks it sent or re-queues it.
        await db.query(
          "update email_sends set status = 'review', updated_at = now() where idempotency_key = $1",
          [key],
        );
        return; // complete the job so the queue does not retry it
      }
      throw err; // other errors: let the queue retry with backoff (see below)
    }
  },
);
```

## What to retry and what not to

| Error                                                                    | Queue action                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `SendOutcomeUnknownError`                                                | Mark `review`, complete the job. Never auto-retry.                                  |
| `RateLimitedError`                                                       | Re-queue after `retryAfterMs` (see below). The library already retried short waits. |
| `DailyQuotaExceededError`                                                | Pause that connection's jobs until tomorrow.                                        |
| `ConnectionRevokedError`, `MissingScopeError`, `ConnectionNotFoundError` | Stop the batch; the admin must reconnect. Do not retry.                             |
| `InvalidMessageError`, `MessageTooLargeError`                            | Permanent for that recipient. Mark failed.                                          |
| `KeyProviderUnavailableError`, `GoogleApiError`                          | Safe to retry with backoff (the send did not reach Gmail).                          |

A large `Retry-After` is not slept on inside `send`: if Google asks for longer than the
8 second backoff cap, `RateLimitedError` is thrown immediately with `retryAfterMs`. Use
it to delay the job:

```ts
if (err instanceof RateLimitedError && err.retryAfterMs !== null) {
  await boss.send("rejection-email", job.data, {
    startAfter: Math.ceil(err.retryAfterMs / 1000),
    singletonKey: `${key}:retry:${Date.now()}`,
  });
  return;
}
```

## Concurrency

Gmail rate-limits per user (per mailbox), not per client. Keep **1 to 2 concurrent
sends per connection**. Set the worker's concurrency option
(its name depends on your pg-boss version) to 1 or 2. If several processes or queues can
send from the same mailbox, give each connection its own queue or a lock so the total
stays at 1 to 2. A tenant with several mailboxes can send from them
in parallel.

## Checklist

- One job per recipient; key like `ats:rejection:<applicationId>`.
- Record `messageId` against the key; skip jobs that already have one.
- `SendOutcomeUnknownError` leads to manual review, never a retry.
- 1 to 2 concurrent sends per connection.
- Pass `redactRecipients: true` (globally or per send) if your audit sink must not store addresses.
