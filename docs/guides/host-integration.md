# Host integration

How to wire `@mshindi-labs/google` into an application. Examples use `pg`, Next.js
(App Router) and Express; adapt the route code to your framework.

## 1. Install and migrate

```sh
npm i @mshindi-labs/google pg
npm i @googleapis/gmail nodemailer html-to-text   # Gmail sending peers
```

Run the migrations once, in order, and record the `id` of each one you applied:

```ts
import { getMigrations } from "@mshindi-labs/google/postgres";

for (const m of getMigrations({ schema: "public", tablePrefix: "google_" })) {
  await pool.query(m.sql);
}
```

If you use a non-public schema, create it first (`create schema ...`); the migration
does not. For database-enforced tenant isolation see [postgres-rls.md](./postgres-rls.md).

## 2. Create the instance

```ts
import { Pool } from "pg";
import { createGoogle } from "@mshindi-labs/google/core";
import { createGmail } from "@mshindi-labs/google/gmail";
import { createPostgresStore } from "@mshindi-labs/google/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const google = createGoogle({
  store: createPostgresStore({
    query: (sql, params) => pool.query(sql, params),
  }),
  keyProvider, // see section 5
  callbackUrl: "https://app.example.com/api/google/callback",
  onEvent: (e) => audit.write(e), // optional; failures never break a send
  redactRecipients: false, // true hashes recipient addresses in events
});
export const gmail = createGmail(google);
```

- `callbackUrl` must be HTTPS (http is accepted only for `localhost`, `127.0.0.1`
  and `[::1]`). Every tenant registers this same URL in its Google client.
- Create the instance once per process. The access-token cache lives in it.
- `createPostgresStore` takes any `query(sql, params) => Promise<{ rows }>`. A `pg`
  `Pool` or `Client` works as is. With row-level security, give it the query function
  of a connection that has `app.tenant_id` set.
- Using Prisma or TypeORM? Wrap the client with `fromPrisma` or `fromTypeOrm`; see
  [orm-integration.md](./orm-integration.md).

## 3. Configure a tenant and start consent

```ts
await google.clients.configure({ tenantId, actorId, clientId, clientSecret });
// changing clientId marks the tenant's connections revoked ('client_changed')

const { url } = await google.oauth.createAuthUrl({
  tenantId,
  actorId,
  services: ["gmail"],
  intendedEmail: "careers@example.com", // recommended: reject the wrong account
  // connectionId: "...",               // add scopes to an existing connection
});
// redirect the admin to `url`
```

`createAuthUrl` throws `OAuthClientNotConfiguredError` if the tenant has no client.
`intendedEmail` is compared case-insensitively. One `hostedDomain` per tenant can be
passed to `clients.configure`; the ID token's `hd` claim must match it.

## 4. The callback route

Both frameworks do the same: read `code`, `state` and `error` from the query string,
call `handleCallback`, map errors to a page. The state is consumed even when the call
fails, so a refresh of the callback URL yields `InvalidOAuthStateError`.

**Row-level security:** if you enabled RLS, set `app.tenant_id` on the connection the
store uses from the signed-in admin's session **before** calling `handleCallback`.
The tenant is not known from the URL; see [postgres-rls.md](./postgres-rls.md).

### Next.js (App Router)

```ts
// app/api/google/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GoogleLibError } from "@mshindi-labs/google/core";
import { google } from "@/lib/google";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    await google.oauth.handleCallback({
      code: q.get("code") ?? undefined,
      state: q.get("state") ?? undefined,
      error: q.get("error") ?? undefined,
    });
    return NextResponse.redirect(
      new URL("/settings/google?connected=1", req.url),
    );
  } catch (err) {
    const code = err instanceof GoogleLibError ? err.code : "unknown";
    return NextResponse.redirect(
      new URL(`/settings/google?error=${code}`, req.url),
    );
  }
}
```

### Express

```ts
app.get("/api/google/callback", async (req, res) => {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  try {
    await google.oauth.handleCallback({
      code: str(req.query.code),
      state: str(req.query.state),
      error: str(req.query.error),
    });
    res.redirect("/settings/google?connected=1");
  } catch (err) {
    const code = err instanceof GoogleLibError ? err.code : "unknown";
    res.redirect(`/settings/google?error=${code}`);
  }
});
```

Redirecting with only the error `code` keeps secrets out of URLs and logs. Error
messages are safe to show to admins, but never contain codes, tokens or secrets.

## 5. Choosing a KeyProvider

| Provider                               | Use when                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GcpKmsKeyProvider({ keyName })`       | You run on Google Cloud. `keyName` is the full Cloud KMS crypto key resource name (`projects/.../cryptoKeys/...`). Needs `@google-cloud/kms`. |
| `AwsKmsKeyProvider({ keyId })`         | You run on AWS. Needs `@aws-sdk/client-kms`.                                                                                                  |
| `StaticKeyProvider({ keys, current })` | You manage a 32-byte key yourself (secret manager, env var). Supports several keys for rotation.                                              |
| `LocalKeyProvider` (from `/testing`)   | Local development and tests only. Refuses `NODE_ENV=production`.                                                                              |

Prefer KMS in production: the key encryption key then never leaves the KMS. With
`StaticKeyProvider`, keep the keys outside the database and out of source control.
A provider outage surfaces as `KeyProviderUnavailableError`, which is safe to retry.

Rotation: add the new key to the provider, make it `current`, then run
`rewrapAll({ store, keyProvider })` (idempotent and resumable; `fromKeyId` narrows it) and
`verifyAll(...)` to prove every value still decrypts. Run both with a role that can
see all tenants.

## 6. Scheduling `purgeExpiredStates`

OAuth states expire after 10 minutes, but expired rows stay until you delete them.
Schedule a job (cron, pg-boss, your platform scheduler) hourly or daily:

```ts
const removed = await google.oauth.purgeExpiredStates(); // number of rows deleted
```

With RLS, this must run as a role that bypasses it.

## 7. Sending

```ts
const { messageId, threadId } = await gmail.send({
  tenantId,
  connectionId,
  actorId,
  fromName: "SunCulture Careers",
  to: ["jane@applicant.com", { name: "Wanjirũ", address: "w@applicant.com" }],
  subject: "Your application ✅",
  html: "<p>Hello</p>", // text is generated from html if omitted
  headers: { "X-Hrms-Application-Id": "app_123" },
});
```

Rules the library enforces:

- A string address must be a bare address (`jane@example.com`). For a display name,
  use `{ name, address }`; a string like `Jane <jane@example.com>` is rejected.
- Non-ASCII names and subjects are fine (RFC 2047 encoded).
- Custom headers must match `X-...`; reserved headers are rejected.
- `thread.threadId` is validated as an ASCII Gmail id; `inReplyTo` and `references`
  as ASCII message ids.
- Attachments total at most 25 MiB (`MessageTooLargeError`, before any network call).
  Messages over 5 MiB use Gmail's media upload path automatically.
- Retries: up to 3 attempts with full-jitter backoff, only for failures that provably
  did not reach Gmail's send. If `Retry-After` is longer than the 8 second backoff
  cap, `RateLimitedError` is thrown immediately (with `retryAfterMs`) so your queue can
  reschedule. A send whose outcome is unknown is **never** retried (next section).

## 8. Mapping errors to UI messages

Every library error extends `GoogleLibError` with a stable `code`.

| `code`                        | Class                                     | Suggested message                                                              |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `oauth_client_not_configured` | `OAuthClientNotConfiguredError`           | "Add your Google client ID and secret first."                                  |
| `invalid_oauth_state`         | `InvalidOAuthStateError`                  | "This sign-in link expired or was already used. Start again."                  |
| `oauth_consent_denied`        | `OAuthConsentDeniedError`                 | "Google access was not granted."                                               |
| `unexpected_account`          | `UnexpectedAccountError`                  | "You signed in with a different account than expected."                        |
| `no_refresh_token`            | `NoRefreshTokenError`                     | "Google did not grant offline access. Try connecting again."                   |
| `missing_scope`               | `MissingScopeError` (`required`)          | "Permission to send email is missing. Reconnect and tick every box."           |
| `connection_not_found`        | `ConnectionNotFoundError`                 | "That mailbox is not connected."                                               |
| `connection_revoked`          | `ConnectionRevokedError` (`reason`)       | "The mailbox was disconnected or its access was removed. Reconnect it."        |
| `credential_integrity`        | `CredentialIntegrityError`                | "Stored credentials could not be verified. Contact support." (alert your team) |
| `key_provider_unavailable`    | `KeyProviderUnavailableError`             | "Temporarily unavailable. Try again shortly."                                  |
| `invalid_message`             | `InvalidMessageError` (`field`)           | "The email has an invalid <field>."                                            |
| `message_too_large`           | `MessageTooLargeError` (`bytes`, `limit`) | "Attachments are too large (25 MB maximum)."                                   |
| `rate_limited`                | `RateLimitedError` (`retryAfterMs`)       | "Sending too fast. Retrying later."                                            |
| `daily_quota_exceeded`        | `DailyQuotaExceededError`                 | "Daily sending limit reached for this mailbox."                                |
| `send_outcome_unknown`        | `SendOutcomeUnknownError`                 | "Delivery could not be confirmed. Check the mailbox's Sent folder."            |
| `google_api`                  | `GoogleApiError` (`status`, `reason`)     | "Google returned an error. Try again later."                                   |
| `missing_peer_dependency`     | `MissingPeerDependencyError`              | Deployment bug; the message names the `npm i` command.                         |
| `invalid_config`              | `InvalidConfigError`                      | Deployment or input bug (for example a malformed client ID).                   |

`SendOutcomeUnknownError` means the request may have reached Gmail (a timeout or reset
after the request was written, or a 5xx). **Do not auto-retry it**: that can email an
applicant twice. Send it to manual review.

## 9. Events

`onEvent` receives `GoogleEvent` values: `oauth_client.configured|rotated`,
`connection.created|scopes_added|revoked|disconnected`, `message.sent|failed`. Events
carry no bodies, tokens or secrets. If your store implements `insertAuditEvent`
(the Postgres adapter does) events are also persisted.

## 10. Writing your own store adapter

Implement `CredentialStore` and pass `runStoreContractTests` from
`@mshindi-labs/google/testing` for your adapter. Two points are easy to miss:

- Every method that takes a `tenantId` must filter on it.
- `replaceEncryptedValue(ref, value)` is **compare-and-swap**: replace only if the stored
  value still equals `ref.value` (and the tenant matches), and return `true` when it did,
  `false` otherwise. `rewrapAll` relies on this so a concurrent write is never overwritten
  with a stale re-wrap.
- `setConnectionDisplayName` and `disconnectConnection` must be single targeted updates.
  `setConnectionDisplayName` changes only `displayName` and `updatedAt` (never `status`
  or the refresh token), so a concurrent `client_changed` revoke is never undone.
  `disconnectConnection` sets the refresh token to null, `status = 'revoked'`,
  `statusReason = 'disconnected'` and `updatedAt`. Both return `false` when the row is
  not in that tenant.

## 11. Testing your integration

```ts
import {
  InMemoryStore,
  LocalKeyProvider,
  CaptureTransport,
  FakeGoogleOAuth,
} from "@mshindi-labs/google/testing";

const transport = new CaptureTransport();
const google = createGoogle({
  store: new InMemoryStore(),
  keyProvider: new LocalKeyProvider(),
  callbackUrl: "http://localhost:3000/api/google/callback",
  oauthGateway: new FakeGoogleOAuth(),
});
const gmail = createGmail(google, { transport });
// ... run your flow, then inspect transport.messages / transport.find(...)
```

`CaptureTransport` needs the `mailparser` peer. These helpers are exported only from
`/testing`.
