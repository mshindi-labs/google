# Bulk sending

The library sends one message per call and does not queue. For batches (for example
rejection emails to every applicant of a closed job), put a queue in front of it. This
guide uses [pg-boss](https://github.com/timgit/pg-boss); any queue with per-key
concurrency and a dead-letter or manual-review path works.

The goals: **never email someone twice**, stay under Gmail's per-user rate limits, and
leave anything ambiguous for a human.

## The pattern

1. Enqueue **one job per recipient**, carrying an **idempotency key**.
2. The worker **claims** the key (`pending` → `sending`) in one conditional update
   before sending, and skips the job if the claim returns no row. Two copies of the
   same job can never both send.
3. After a successful send it records the Gmail `messageId` and `sent`. That write is
   not retried by the queue: if it fails, the row goes to `review`.
4. Errors are branched by kind (table below). `SendOutcomeUnknownError` goes to
   **manual review** and is never retried; permanent errors are marked `failed`.
5. Run **1 to 2 concurrent sends per connection**.

## Idempotency key

Build the key from the business fact, not from the job id:
`ats:rejection:<applicationId>`. The same application can then never receive the same
rejection twice, even if it is enqueued twice by a bug or a retry of the enqueueing code.

```sql
create table email_sends (
  idempotency_key text primary key,
  message_id      text,
  status          text not null default 'pending', -- pending | sending | sent | review | failed
  error_code      text,
  updated_at      timestamptz not null default now()
);
```

## Worker

The worker matches errors on `err.code` rather than `instanceof` (see the README: with
mixed ESM/CommonJS loading, `instanceof` is unreliable).

```ts
import PgBoss from "pg-boss";
import type { RateLimitedError } from "@mshindi-labs/google/core";

// `db`, `gmail`, `logger`, `applicantAddress` and `renderRejection` are your app's.
type RejectionJob = {
  key: string;
  applicationId: string;
  tenantId: string;
  connectionId: string;
};

const QUEUE = "rejection-email";
const boss = new PgBoss(process.env.DATABASE_URL!);
await boss.start();
await boss.createQueue(QUEUE);

// Enqueue: one job per recipient. singletonKey de-duplicates queued jobs.
export async function enqueueRejection(app: Application) {
  const key = `ats:rejection:${app.id}`;
  await db.query(
    "insert into email_sends (idempotency_key) values ($1) on conflict do nothing",
    [key],
  );
  await boss.send(
    QUEUE,
    {
      key,
      applicationId: app.id,
      tenantId: app.tenantId,
      connectionId: app.connectionId,
    },
    { singletonKey: key, retryLimit: 5, retryBackoff: true },
  );
}

const setStatus = (
  key: string,
  status: string,
  errorCode: string | null = null,
) =>
  db.query(
    "update email_sends set status = $2, error_code = $3, updated_at = now() where idempotency_key = $1",
    [key, status, errorCode],
  );

// Give the key back so a later job can claim it, then schedule that job.
async function requeue(job: PgBoss.Job<RejectionJob>, delaySeconds: number) {
  await setStatus(job.data.key, "pending");
  await boss.send(QUEUE, job.data, {
    startAfter: Math.max(1, Math.ceil(delaySeconds)),
    singletonKey: `${job.data.key}:retry:${Date.now()}`,
    retryLimit: 5,
    retryBackoff: true,
  });
}

await boss.work<RejectionJob>(
  QUEUE,
  // Keep this worker's concurrency at 1-2 (see "Concurrency" below).
  async ([job]) => {
    const { key, applicationId, tenantId, connectionId } = job.data;

    // 1. Claim. Only one job can move the key from pending to sending.
    const claimed = await db.query(
      "update email_sends set status = 'sending', updated_at = now() where idempotency_key = $1 and status = 'pending' returning 1",
      [key],
    );
    if (claimed.rowCount === 0) return; // sent, in review, failed, or another job has it

    // 2. Send. Every outcome below is decided here; nothing falls through to a retry
    //    that could send twice.
    let messageId: string;
    try {
      ({ messageId } = await gmail.send({
        tenantId,
        connectionId,
        actorId: "system:ats",
        to: [await applicantAddress(applicationId)],
        subject: "Your application",
        html: await renderRejection(applicationId),
        headers: { "X-Ats-Idempotency-Key": key },
      }));
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      switch (code) {
        case "send_outcome_unknown":
          // It may or may not have been delivered. Do NOT retry: a human checks the
          // mailbox's Sent folder, then marks it sent or sets it back to pending.
          await setStatus(key, "review", code);
          return; // complete the job so the queue does not retry it
        case "rate_limited": {
          // Long Retry-After values are not slept on inside send(); honour them here.
          const ms = (err as RateLimitedError).retryAfterMs ?? 60_000;
          await requeue(job, ms / 1000);
          return;
        }
        case "daily_quota_exceeded":
          await requeue(job, 24 * 60 * 60); // try again tomorrow
          return;
        case "connection_revoked":
        case "missing_scope":
        case "connection_not_found":
        case "invalid_message":
        case "message_too_large":
          // Permanent: retrying cannot succeed. Revoked/scope/not-found also mean the
          // admin must reconnect; alert and stop the batch for that connection.
          await setStatus(key, "failed", code);
          return;
        default:
          // key_provider_unavailable, google_api, or a failure before send() was
          // reached (rendering, address lookup): nothing was sent, so release the
          // key and let the queue retry the job with backoff.
          await setStatus(key, "pending", code ?? "unknown");
          throw err;
      }
    }

    // 3. Record the result. This is outside the retrying path: the message is sent,
    //    so a failure here must never lead to another send.
    try {
      await db.query(
        "update email_sends set message_id = $2, status = 'sent', error_code = null, updated_at = now() where idempotency_key = $1",
        [key, messageId],
      );
    } catch (writeErr) {
      logger.error(
        { key, messageId, writeErr },
        "sent, but recording it failed",
      );
      await setStatus(key, "review", "record_failed").catch(() => {
        // Still 'sending': the stale-row sweep below sends it to review.
      });
    }
  },
);
```

### Stale `sending` rows

A row stays `sending` if the worker crashed between the claim and the final write (or
if the `review` fallback write failed too). The message may or may not have gone out, so
treat these exactly like `SendOutcomeUnknownError`: **manual review, never an automatic
retry**. Sweep them periodically, using a cutoff well above your longest send:

```sql
update email_sends set status = 'review', error_code = 'stale_sending', updated_at = now()
where status = 'sending' and updated_at < now() - interval '15 minutes';
```

## What to retry and what not to

| Error                                                                    | Queue action                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `SendOutcomeUnknownError`                                                | Mark `review`, complete the job. Never auto-retry.                              |
| `RateLimitedError`                                                       | Release the key, re-queue with `startAfter` = `retryAfterMs` (default 60 s).    |
| `DailyQuotaExceededError`                                                | Release the key, re-queue for tomorrow.                                         |
| `ConnectionRevokedError`, `MissingScopeError`, `ConnectionNotFoundError` | Mark `failed`. Stop the batch; the admin must reconnect. Do not retry.          |
| `InvalidMessageError`, `MessageTooLargeError`                            | Mark `failed`: permanent for that recipient. Do not retry.                      |
| `KeyProviderUnavailableError`, `GoogleApiError`                          | Release the key and let the queue retry with backoff (the send did not happen). |

A large `Retry-After` is not slept on inside `send`: if Google asks for longer than the
8 second backoff cap, `RateLimitedError` is thrown immediately with `retryAfterMs`, and
the worker above re-queues the job with that delay.

## Concurrency

Gmail rate-limits per user (per mailbox), not per client. Keep **1 to 2 concurrent
sends per connection**. Set the worker's concurrency option
(its name depends on your pg-boss version) to 1 or 2. If several processes or queues can
send from the same mailbox, give each connection its own queue or a lock so the total
stays at 1 to 2. A tenant with several mailboxes can send from them
in parallel.

## Checklist

- One job per recipient; key like `ats:rejection:<applicationId>`.
- Claim the key (`pending` → `sending`) before sending; skip the job if the claim fails.
- Record `messageId` outside the retry path; if that write fails, mark `review`.
- `SendOutcomeUnknownError` and stale `sending` rows lead to manual review, never a retry.
- Permanent errors (revoked, missing scope, invalid message) are marked `failed`, not retried.
- 1 to 2 concurrent sends per connection.
- Pass `redactRecipients: true` (globally or per send) if your audit sink must not store addresses.
