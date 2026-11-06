# `@mshindi-labs/google` — Design Spec

**Status:** Draft v1 · **Date:** 2026-11-05 · **Owner:** Mshindi Labs

A server-side TypeScript library that lets multi-tenant apps (HRMS, ATS, …) send email
through each tenant's **own** Google Workspace accounts via the Gmail API, with no SMTP
and no per-tenant secrets in environment variables. Calendar and Sheets join later as
further services on the same foundation.

---

## 1. Goals and non-goals

### Goals

1. Each tenant brings its own Google OAuth client (client ID + secret), stored in the
   host app's database.
2. The library generates a consent URL; a tenant user (e.g. `careers@sunculture.io`)
   authorizes; the library stores an encrypted refresh token for that account.
3. Host code sends mail with one call, referencing only IDs — never secrets.
4. Strict tenant isolation: one tenant can never read, use, or overwrite another
   tenant's credentials, even with a buggy host or tampered DB rows.
5. Database-agnostic core; Postgres adapter first.
6. One package that grows to Calendar and Sheets without redesign.

### Non-goals (v1)

- SMTP, IMAP, or reading/modifying inboxes.
- A platform-owned shared OAuth client, or Workspace domain-wide delegation.
- Gmail "send as" aliases.
- Template rendering (host renders HTML/text).
- A built-in job queue (documented pattern only).
- App-level authorization ("may recruiter X send as careers@?") — host decides.
- Browser/edge runtimes. Node ≥ 18 only.

---

## 2. Invariants

Every module must hold these. Breaking one is a bug, not a trade-off.

| #   | Invariant                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Client secrets, refresh tokens, and PKCE verifiers are never stored, logged, thrown, emitted, or returned in plaintext.                                                                                                          |
| I2  | Every read of tenant-owned data takes `tenantId` and fails closed on mismatch. The only exception is the operator tools `rewrapAll` / `verifyAll` (§5.4), which never return plaintext and run under a separate privileged role. |
| I3  | Ciphertext is cryptographically bound to its tenant, record, and field (AAD). Moving a ciphertext to another row makes it undecryptable.                                                                                         |
| I4  | The OAuth callback derives tenant, actor, and intent **only** from server-stored state.                                                                                                                                          |
| I5  | The redirect URI is fixed at construction time; never taken from request input.                                                                                                                                                  |
| I6  | Access tokens live in process memory only.                                                                                                                                                                                       |
| I7  | A send is attempted at most once unless the failure provably happened before Google received it, or Google answered `429`.                                                                                                       |
| I8  | One `(tenantId, organizerEmail, idempotencyKey)` yields at most one calendar event, and its invitations are sent once.                                                                                                           |
| I9  | Only calendar events stamped `mshindiGoogle: "v1"` with the same `mshindiTenant` are read or changed.                                                                                                                            |

---

## 3. Package layout

Single npm package, subpath exports, same tooling as `gsheets` (tsup, ESM + CJS,
semantic-release, commitlint, prettier).

```
@mshindi-labs/google
├── /core       createGoogle, OAuth flow, crypto, store + key-provider interfaces, errors, events
├── /gmail      createGmail(google) → send()
├── /postgres   createPostgresStore(query), migrations
├── /testing    InMemoryStore, LocalKeyProvider, CaptureTransport
├── /calendar   createCalendar(google) → availability, suggestSlots, create/update/cancel/getEvent
└── /sheets     (later — gsheets migrates here)
```

**Dependencies**

| Package                                     | Kind          | Used by                                     |
| ------------------------------------------- | ------------- | ------------------------------------------- |
| `google-auth-library`                       | dependency    | core (OAuth2 client, ID token verification) |
| `@googleapis/gmail`                         | optional peer | `/gmail`                                    |
| `nodemailer` (MailComposer only)            | optional peer | `/gmail`                                    |
| `html-to-text`                              | optional peer | `/gmail` (plain-text fallback)              |
| `@googleapis/calendar` (`>=14.0.0 <21.0.0`) | optional peer | `/calendar`                                 |
| `@googleapis/sheets`                        | optional peer | later                                       |

Importing `/gmail` without its peers throws a clear install-instructions error.

**Migration of `@mshindi-labs/gsheets`:** after `/sheets` lands, publish a final
`gsheets` release that re-exports from `@mshindi-labs/google/sheets` and is marked
`npm deprecate`.

---

## 4. Domain model

```
Tenant (host-owned, opaque string id)
 └── GoogleOAuthClient           0..1 per tenant
      └── GoogleConnection       0..n — one Google account authorized inside the tenant
           └── granted scopes    grows via incremental authorization
GoogleOAuthState                 short-lived, one per in-flight consent
GoogleAuditEvent                 optional persistence of emitted events
```

### 4.1 `GoogleOAuthClient`

| Field                                              | Notes                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `tenantId`                                         | PK                                                               |
| `clientId`                                         | Validated: ends with `.apps.googleusercontent.com`               |
| `clientSecret`                                     | `EncryptedValue` — write-only                                    |
| `secretHint`                                       | Last 4 chars, for UI display                                     |
| `hostedDomain`                                     | Optional Workspace domain, sent as `hd` and enforced on callback |
| `createdBy`, `createdAt`, `updatedBy`, `updatedAt` | Audit                                                            |

Rules:

- Re-saving with the **same** `clientId` re-encrypts the secret; connections stay active.
- Saving a **different** `clientId` marks every connection in the tenant `revoked`
  (reason `client_changed`) in the same transaction. Refresh tokens are bound to the
  client that issued them.

### 4.2 `GoogleConnection`

| Field                                                   | Notes                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `id`                                                    | UUID, generated by the library (needed before encryption for AAD)   |
| `tenantId`                                              |                                                                     |
| `googleSub`                                             | Stable Google account ID from the ID token. Unique with `tenantId`. |
| `email`                                                 | Verified email from the ID token, lower-cased                       |
| `displayName`                                           | Optional default From name                                          |
| `scopes`                                                | Granted scope set (from token response)                             |
| `refreshToken`                                          | `EncryptedValue`                                                    |
| `status`                                                | `active` · `revoked` · `error`                                      |
| `statusReason`                                          | e.g. `invalid_grant`, `client_changed`, `disconnected`              |
| `connectedBy`, `connectedAt`, `updatedAt`, `lastUsedAt` | Audit                                                               |

Re-authorizing the same Google account in the same tenant updates the existing row
(new token, merged scopes, status back to `active`) rather than creating a duplicate.

### 4.3 `GoogleOAuthState`

| Field                 | Notes                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| `stateHash`           | SHA-256 of the random state value (PK). The raw value only exists in the URL. |
| `tenantId`, `actorId` | Who started the flow                                                          |
| `intendedEmail`       | Optional; enforced on callback                                                |
| `connectionId`        | Set when adding scopes to an existing connection                              |
| `scopes`              | Requested scopes                                                              |
| `codeVerifier`        | `EncryptedValue` (PKCE)                                                       |
| `expiresAt`           | `now + 10 min`                                                                |

---

## 5. Encryption

### 5.1 Scheme

Envelope encryption, per value:

1. Generate a random 256-bit data encryption key (DEK).
2. Encrypt plaintext with AES-256-GCM, random 96-bit IV, with AAD (5.2).
3. Wrap the DEK with the key encryption key (KEK) via `KeyProvider.wrap`.
4. Store the envelope; discard the plaintext DEK.

```ts
type EncryptedValue = {
  v: 1; // format version
  kid: string; // KEK id + version, e.g. "gcp-kms:projects/.../cryptoKeyVersions/3"
  wdek: string; // wrapped DEK, base64url
  iv: string; // base64url
  ct: string; // ciphertext, base64url
  tag: string; // GCM auth tag, base64url
};
```

Stored as `jsonb` in Postgres.

### 5.2 Associated data (binds ciphertext to its place)

```
mshindi-google/v1|tenant=<tenantId>|record=<oauth_client|connection|oauth_state>:<id>|field=<name>
```

Decryption with any other AAD fails (GCM tag mismatch) → `CredentialIntegrityError`.
The same string is passed to KMS as encryption context / AAD where supported.

### 5.3 `KeyProvider`

```ts
interface KeyProvider {
  readonly currentKeyId: string;
  wrap(
    dek: Uint8Array,
    aad: string,
  ): Promise<{ kid: string; wdek: Uint8Array }>;
  unwrap(kid: string, wdek: Uint8Array, aad: string): Promise<Uint8Array>;
}
```

Shipped implementations:

| Provider                                                      | Use                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GcpKmsKeyProvider`                                           | Recommended production. Uses workload identity → zero secrets in env.                          |
| `AwsKmsKeyProvider`                                           | Production on AWS.                                                                             |
| `StaticKeyProvider({ keys: { [kid]: Uint8Array }, current })` | Small deploys; master key(s) from env or a secret manager. Supports several keys for rotation. |
| `LocalKeyProvider` (`/testing`)                               | Dev/test. Throws if `NODE_ENV === 'production'` unless `allowInProduction: true`.              |

KMS providers make one KMS call per unwrap. Because access tokens are cached (§7), a
connection's refresh token is decrypted at most about once an hour per process, so no
DEK cache is needed in v1.

### 5.4 Rotation and integrity tools

```ts
rewrapAll(opts: { store, keyProvider, fromKeyId?: string, batchSize?: number }):
  Promise<{ rewrapped: number; failed: Array<{ record: string; error: string }> }>;

verifyAll(opts: { store, keyProvider }):
  Promise<{ ok: number; failed: Array<{ record: string; error: string }> }>;
```

`rewrapAll` unwraps each DEK with its old `kid` and re-wraps it under `currentKeyId`.
The secret ciphertext itself is untouched. `verifyAll` performs a full decrypt of every
value and reports tampered, moved, or orphaned records. Both are idempotent and resumable.

---

## 6. OAuth flow

### 6.1 Construction

```ts
import { createGoogle } from "@mshindi-labs/google/core";

const google = createGoogle({
  store, // CredentialStore
  keyProvider, // KeyProvider
  callbackUrl: "https://hrms.example.com/api/google/callback", // fixed, HTTPS required outside localhost
  onEvent: (e) => audit.write(e), // optional
  logger, // optional; receives redacted messages only
});
```

Every tenant registers the **same** `callbackUrl` as an authorized redirect URI in its
Google client.

### 6.2 Configure a tenant's client

```ts
await google.clients.configure({
  tenantId,
  actorId,
  clientId,
  clientSecret,
  hostedDomain: "sunculture.io", // optional
});

await google.clients.get(tenantId);
// → { clientId, secretHint: 'x7Qa', hostedDomain, updatedAt } — never the secret
```

### 6.3 Start consent

```ts
const { url, expiresAt } = await google.oauth.createAuthUrl({
  tenantId,
  actorId,
  services: ["gmail"], // → scopes via the service registry
  intendedEmail: "careers@sunculture.io", // optional but recommended
  connectionId, // optional: add scopes to an existing connection
});
```

The library:

1. Loads the tenant's client (fails with `OAuthClientNotConfiguredError` if absent).
2. Resolves scopes: `openid email` + each service's scopes.
3. Generates `state` (32 random bytes, base64url) and PKCE `code_verifier`.
4. Stores `GoogleOAuthState` (hashed state, encrypted verifier, 10-minute TTL).
5. Builds the URL with: `response_type=code`, `access_type=offline`,
   `prompt=consent`, `include_granted_scopes=true`, `code_challenge_method=S256`,
   `login_hint=<intendedEmail>`, `hd=<hostedDomain>`, fixed `redirect_uri`.

**Service scope registry (v1):**

| Service    | Scopes                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| (always)   | `openid`, `email`                                                                                                   |
| `gmail`    | `https://www.googleapis.com/auth/gmail.send`                                                                        |
| `calendar` | `https://www.googleapis.com/auth/calendar.events.owned`, `https://www.googleapis.com/auth/calendar.events.freebusy` |

### 6.4 Handle callback

```ts
// host route: GET /api/google/callback
const result = await google.oauth.handleCallback({
  code: req.query.code,
  state: req.query.state,
  error: req.query.error,
});
// → { connection: ConnectionView, tenantId, actorId, created: boolean }
```

Steps (any failure → typed error, the state is consumed regardless):

1. **Consume state atomically**: delete-and-return by `sha256(state)` where not expired.
   Missing or expired → `InvalidOAuthStateError`.
2. If `error` is present (e.g. `access_denied`) → `OAuthConsentDeniedError`.
3. Load the tenant's client using `tenantId` **from the state row**.
4. Exchange `code` with the decrypted PKCE verifier and fixed `redirect_uri`.
5. Verify the ID token (`google-auth-library` `verifyIdToken`): signature, `aud` =
   tenant client ID, `iss`, `exp`, `email_verified === true`.
6. If `hostedDomain` is set: the ID token's `hd` claim must equal it.
7. If `intendedEmail` is set: the normalized email must equal it →
   otherwise `UnexpectedAccountError` (the new token is revoked at Google immediately).
8. Check that the granted scopes include every requested service scope. The user may
   untick boxes on the consent screen → `MissingScopeError` (token revoked).
9. No `refresh_token` returned → `NoRefreshTokenError` (should not happen with
   `prompt=consent`, but handled).
10. Upsert the connection by `(tenantId, googleSub)`, encrypt the refresh token, merge scopes.
11. Emit `connection.created` or `connection.scopes_added`.

The host maps errors to a user-facing page. Error messages never contain codes, tokens,
or secrets.

### 6.5 Connections API

```ts
google.connections.list(tenantId): Promise<ConnectionView[]>;
google.connections.get(tenantId, connectionId): Promise<ConnectionView>;
google.connections.disconnect({ tenantId, connectionId, actorId }): Promise<void>;
```

`ConnectionView` contains no ciphertext. `disconnect` calls
`https://oauth2.googleapis.com/revoke`, then deletes the encrypted token and sets
`status=revoked, statusReason=disconnected`. If revocation at Google fails, the local
token is still deleted and the event records `googleRevoke: 'failed'`.

---

## 7. Token lifecycle

- **Access tokens**: kept in an in-process LRU keyed by `connectionId`, until 60 s
  before expiry. Never persisted.
- **Refresh**: on a cache miss, decrypt the refresh token, refresh via
  `google-auth-library`, cache the access token, update `lastUsedAt`. Concurrent
  callers for the same connection share one in-flight refresh (single-flight).
- **No cross-instance lock**: Google refresh tokens do not rotate on use, so parallel
  refreshes on different instances are safe.
- **`invalid_grant`** (user revoked, admin removed app, password reset under certain
  policies, 6 months unused, the OAuth client was deleted): mark the connection `revoked`
  with reason `invalid_grant`, evict the cache, emit `connection.revoked`, throw
  `ConnectionRevokedError`. No retry.
- **Known Google limits to document for tenants**:
  - A client in _Testing_ publishing status issues refresh tokens that expire after
    7 days. Use _Internal_ (Workspace) or publish the app.
  - Google caps live refresh tokens per account per client. Reconnecting many times
    silently invalidates the oldest ones.

---

## 8. Gmail service

### 8.1 API

```ts
import { createGmail } from "@mshindi-labs/google/gmail";

const gmail = createGmail(google, {
  blockedAttachmentExtensions: ["exe", "bat", "js"], // optional
  transport, // optional; default = Gmail API
});

const { messageId, threadId } = await gmail.send({
  tenantId,
  connectionId,
  actorId, // for audit
  fromName: "SunCulture Careers", // optional; overrides connection.displayName
  to: ["jane@applicant.com"], // string | { name, address }, also cc/bcc
  cc,
  bcc,
  replyTo: "recruiter@sunculture.io",
  subject: "Your application",
  html: "<p>…</p>",
  text: "…", // optional; generated from html if omitted
  attachments: [
    { filename: "offer.pdf", content: buffer, contentType: "application/pdf" },
  ],
  headers: { "X-Hrms-Application-Id": "app_123" },
  thread: { threadId, inReplyTo, references }, // optional: reply in an existing thread
});
```

### 8.2 Send pipeline

1. Load the connection with `tenantId` (I2). Not `active` → `ConnectionRevokedError`.
2. Check the scope `gmail.send` is granted → otherwise `MissingScopeError` (the host can
   call `createAuthUrl({ connectionId, services: ['gmail'] })`).
3. **Validate input**:
   - Every header value and address: reject CR, LF, and NUL → `InvalidMessageError`.
   - Addresses parsed and validated. At least one recipient across to/cc/bcc.
   - Custom headers must match `^X-[A-Za-z0-9-]+$`. Reserved headers (`From`, `Sender`,
     `Bcc`, `Return-Path`, `DKIM-*`, `Received`, …) are rejected.
   - `fromName` sanitized (control characters stripped, length capped).
   - Attachment filenames: basename only, control characters and path separators
     removed, extension checked against the blocklist.
4. **Build MIME** with Nodemailer `MailComposer`. `From` is always
   `"<fromName>" <connection.email>`. `text` is generated with `html-to-text` if missing.
5. **Size check**: total encoded size over Gmail's limit (25 MB attachments) →
   `MessageTooLargeError` before any network call.
6. **Send**: `users.messages.send` with `userId: 'me'`. Messages over 5 MB use the
   media upload endpoint; smaller ones use the base64url `raw` field. `threadId` is
   passed when replying.
7. Emit `message.sent` (or `message.failed`), update `lastUsedAt`.

### 8.3 Retries (I7)

| Condition                                                                            | Behavior                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Connection error before the request was written (DNS, `ECONNREFUSED`, TLS handshake) | Retry, max 3, exponential backoff with full jitter                        |
| HTTP `429` / `403 rateLimitExceeded` / `userRateLimitExceeded`                       | Retry, max 3, honor `Retry-After`; then `RateLimitedError { retryAfter }` |
| `403 dailyLimitExceeded` / sending-limit errors                                      | `DailyQuotaExceededError`, no retry                                       |
| `401` after one forced token refresh                                                 | `ConnectionRevokedError` path (§7)                                        |
| Timeout or reset **after** the request was sent, `5xx`                               | **No retry** → `SendOutcomeUnknownError` (the message may have been sent) |
| `400` invalid recipient / message                                                    | `InvalidMessageError`                                                     |

### 8.4 Bulk sends (documented pattern, not library code)

The docs show a `pg-boss` queue: one job per recipient, with an idempotency key such as
`ats:rejection:<applicationId>`. The worker records `messageId` against the key and
skips the job if it already has one. `SendOutcomeUnknownError` routes the job to manual
review instead of retrying. Per-connection concurrency of 1–2 stays under Gmail's
per-user rate limits.

---

## 9. Store interface

```ts
interface CredentialStore {
  // OAuth clients
  getOAuthClient(tenantId: string): Promise<OAuthClientRecord | null>;
  upsertOAuthClient(
    rec: OAuthClientRecord,
    opts: { revokeConnections: boolean },
  ): Promise<void>;

  // Connections
  getConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null>;
  findConnectionBySub(
    tenantId: string,
    googleSub: string,
  ): Promise<ConnectionRecord | null>;
  listConnections(tenantId: string): Promise<ConnectionRecord[]>;
  upsertConnection(rec: ConnectionRecord): Promise<void>;
  updateConnectionStatus(
    tenantId: string,
    connectionId: string,
    status: ConnectionStatus,
    reason: string,
  ): Promise<void>;
  touchConnection(
    tenantId: string,
    connectionId: string,
    at: Date,
  ): Promise<void>;

  // OAuth state
  insertOAuthState(rec: OAuthStateRecord): Promise<void>;
  consumeOAuthState(
    stateHash: string,
    now: Date,
  ): Promise<OAuthStateRecord | null>; // atomic
  deleteExpiredOAuthStates(now: Date): Promise<number>;

  // Key rotation
  iterateEncryptedValues(batchSize: number): AsyncIterable<EncryptedValueRef>;
  replaceEncryptedValue(
    ref: EncryptedValueRef,
    value: EncryptedValue,
  ): Promise<void>;

  // Optional audit persistence
  insertAuditEvent?(event: GoogleEvent): Promise<void>;
}
```

Every method that takes `tenantId` must include it in its `WHERE` clause. The library
also re-checks `record.tenantId === tenantId` after every read (belt and braces).

A shared contract test suite (`runStoreContractTests(makeStore)`) in `/testing` must
pass for every adapter, including the in-memory one.

---

## 10. Postgres adapter

```ts
import { createPostgresStore, migrations } from "@mshindi-labs/google/postgres";

type Query = <T = unknown>(
  sql: string,
  params: unknown[],
) => Promise<{ rows: T[] }>;

const store = createPostgresStore({
  query: (sql, params) => pool.query(sql, params), // pg; wrappers for postgres.js / Drizzle / Prisma in docs
  schema: "public", // optional
  tablePrefix: "google_", // optional
});
```

All SQL is parameterized. Identifiers (schema, prefix) are validated against
`^[a-z_][a-z0-9_]*$` at construction.

### 10.1 Migration `0001_init.sql`

```sql
create table google_oauth_clients (
  tenant_id       text primary key,
  client_id       text not null,
  client_secret   jsonb not null,
  secret_hint     text not null,
  hosted_domain   text,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_by      text not null,
  updated_at      timestamptz not null default now()
);

create table google_connections (
  id              uuid primary key,
  tenant_id       text not null references google_oauth_clients(tenant_id) on delete cascade,
  google_sub      text not null,
  email           text not null,
  display_name    text,
  scopes          text[] not null,
  refresh_token   jsonb,                       -- null after disconnect
  status          text not null check (status in ('active','revoked','error')),
  status_reason   text,
  connected_by    text not null,
  connected_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  unique (tenant_id, google_sub)
);
create index on google_connections (tenant_id);

create table google_oauth_states (
  state_hash      bytea primary key,
  tenant_id       text not null,
  actor_id        text not null,
  intended_email  text,
  connection_id   uuid,
  scopes          text[] not null,
  code_verifier   jsonb not null,
  expires_at      timestamptz not null
);
create index on google_oauth_states (expires_at);

create table google_audit_events (
  id              bigserial primary key,
  tenant_id       text not null,
  type            text not null,
  actor_id        text,
  connection_id   uuid,
  payload         jsonb not null,
  occurred_at     timestamptz not null default now()
);
create index on google_audit_events (tenant_id, occurred_at desc);
```

Consume state atomically:

```sql
delete from google_oauth_states
where state_hash = $1 and expires_at > $2
returning *;
```

### 10.2 Optional row-level security (docs)

Policies on each table: `tenant_id = current_setting('app.tenant_id')`. The host sets
`app.tenant_id` per transaction. Key rotation (`rewrapAll`) runs as a separate role with
`BYPASSRLS`.

---

## 11. Events and audit

```ts
type GoogleEvent =
  | {
      type: "oauth_client.configured" | "oauth_client.rotated";
      tenantId;
      actorId;
      clientIdChanged: boolean;
      at;
    }
  | {
      type: "connection.created" | "connection.scopes_added";
      tenantId;
      actorId;
      connectionId;
      email;
      scopes;
      at;
    }
  | { type: "connection.revoked"; tenantId; connectionId; reason; at }
  | {
      type: "connection.disconnected";
      tenantId;
      actorId;
      connectionId;
      googleRevoke: "ok" | "failed";
      at;
    }
  | {
      type: "message.sent";
      tenantId;
      actorId;
      connectionId;
      messageId;
      threadId;
      to;
      cc;
      bcc;
      subject;
      attachmentCount;
      at;
    }
  | {
      type: "message.failed";
      tenantId;
      actorId;
      connectionId;
      errorCode;
      to;
      cc;
      bcc;
      subject;
      at;
    }
  | {
      type: "calendar_event.created" | "calendar_event.cancelled";
      tenantId;
      actorId;
      connectionId;
      eventId;
      attendees;
      title;
      start;
      end;
      at;
    }
  | {
      type: "calendar_event.updated";
      tenantId;
      actorId;
      connectionId;
      eventId;
      attendees;
      title;
      start;
      end;
      changed;
      at;
    }
  | {
      type: "calendar_event.failed";
      tenantId;
      actorId;
      connectionId;
      operation: "create" | "update" | "cancel";
      errorCode;
      at;
    };
```

- No message bodies, attachment contents, tokens, codes, or secrets in any event.
- `redactRecipients: true` (global or per-send) replaces addresses with
  `sha256(lowercase(address))`; for calendar events this applies to `attendees`.
- Calendar reads (`getEvent`, `getAvailability`, `suggestSlots`) and input validation
  errors raised before the token fetch emit nothing. In a crash or lost-response corner
  combined with concurrency, `calendar_event.created` may be emitted twice or not at all;
  invitations are still sent once (I8).
- `onEvent` failures are caught and logged; they never fail a send. If the store has
  `insertAuditEvent`, events are also written there.

---

## 12. Errors

All errors extend `GoogleLibError { code: string; tenantId?; connectionId? }`.
Messages are safe to show to admins and never include secret material; `cause` is
redacted before attaching.

| Code                          | Class                                          |
| ----------------------------- | ---------------------------------------------- |
| `oauth_client_not_configured` | `OAuthClientNotConfiguredError`                |
| `invalid_oauth_state`         | `InvalidOAuthStateError`                       |
| `oauth_consent_denied`        | `OAuthConsentDeniedError`                      |
| `unexpected_account`          | `UnexpectedAccountError`                       |
| `no_refresh_token`            | `NoRefreshTokenError`                          |
| `missing_scope`               | `MissingScopeError { required: string[] }`     |
| `connection_not_found`        | `ConnectionNotFoundError`                      |
| `connection_revoked`          | `ConnectionRevokedError { reason }`            |
| `credential_integrity`        | `CredentialIntegrityError`                     |
| `invalid_message`             | `InvalidMessageError { field }`                |
| `message_too_large`           | `MessageTooLargeError { bytes, limit }`        |
| `rate_limited`                | `RateLimitedError { retryAfter }`              |
| `daily_quota_exceeded`        | `DailyQuotaExceededError`                      |
| `send_outcome_unknown`        | `SendOutcomeUnknownError`                      |
| `invalid_event`               | `InvalidEventError { field }`                  |
| `event_not_found`             | `EventNotFoundError`                           |
| `event_not_managed`           | `EventNotManagedError`                         |
| `event_cancelled`             | `EventCancelledError`                          |
| `event_conflict`              | `EventConflictError`                           |
| `conferencing_unavailable`    | `ConferencingUnavailableError`                 |
| `google_api`                  | `GoogleApiError { status, reason }` (fallback) |

---

## 13. Testing

### `/testing` exports

- `InMemoryStore` — full `CredentialStore`.
- `LocalKeyProvider` — random or fixed key; refuses production unless overridden.
- `CaptureTransport` — `gmail.send` builds real MIME and stores
  `{ raw, parsed: { from, to, subject, html, text, attachments } }` in memory; exposes
  `messages`, `clear()`, `find(predicate)`. Use it in host tests and on staging.
- `runStoreContractTests(makeStore)`.
- `FakeGoogleOAuth` — local stand-in for the token, revoke, and certificate endpoints
  for end-to-end flow tests.

### Required library test coverage

- Crypto: round-trip; tampered `ct`/`tag`/`iv`/`wdek` fails; ciphertext moved to another
  tenant, record, or field fails; key rotation round-trip.
- OAuth: state single-use, expiry, replay, cross-tenant; PKCE verifier mismatch;
  ID token `aud`/`email_verified`/`hd`/intended-email checks; partial scope grant.
- Token: single-flight refresh; `invalid_grant` → revoked + event; cache expiry.
- MIME: header injection attempts (CR/LF in name, subject, address, filename, custom
  header); reserved header rejection; generated text part; size limit.
- Retries: each row of the table in §8.3.
- Redaction: no secret appears in any thrown error, event, or logger call (fuzzed with
  known secret strings).
- Postgres adapter against a real Postgres (Testcontainers) in CI.

---

## 14. Threat model summary

| Threat                                                           | Mitigation                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| DB dump / backup leak                                            | Envelope encryption; KEK outside the DB (KMS)                                           |
| SQL injection or DB write access swapping tokens between tenants | AAD binding (I3), tenant re-check (I2), optional RLS                                    |
| CSRF / login-CSRF on OAuth callback                              | Server-side single-use hashed state bound to actor and tenant (I4)                      |
| Authorization code interception                                  | PKCE S256, fixed HTTPS redirect URI (I5)                                                |
| Wrong account connected (personal Gmail instead of `careers@`)   | ID token verification + `intendedEmail` + `hd` checks; the token is revoked on mismatch |
| Over-privileged tokens                                           | `gmail.send` + `openid email` only; scope check per service                             |
| Email header injection via applicant data                        | CR/LF rejection, header allowlist, MailComposer                                         |
| Secrets in logs or error trackers                                | Redaction layer; tested by fuzz (§13)                                                   |
| Duplicate emails to applicants                                   | I7 retry rules; idempotency-key queue pattern                                           |
| Ex-employee's mailbox still sending                              | `invalid_grant` → revoked; admin `disconnect()`; audit trail                            |
| Compromised host server                                          | Out of scope: it can call `send` legitimately. Limited by KMS IAM and audit.            |

---

## 15. Delivery phases

1. **Core**: crypto, `KeyProvider`s, store interface, `InMemoryStore`, errors, events.
2. **OAuth**: clients, `createAuthUrl`, `handleCallback`, connections, token cache.
3. **Gmail**: validation, MIME, send, retries, `CaptureTransport`.
4. **Postgres**: adapter, migration, contract tests in CI, RLS docs.
5. **Ops**: `rewrapAll`, `verifyAll`, state cleanup, the pg-boss docs example.
6. **Docs**: tenant setup guide (create a GCP project → OAuth client "Internal" → add
   redirect URI → paste ID/secret), host integration guide (Next.js + Express examples).
7. **Calendar**: `/calendar` (availability, slot suggestions, idempotent create with
   Google Meet, reschedule, cancel, RSVP status). Done; see
   `docs/guides/calendar-scheduling.md` and
   `docs/superpowers/specs/2026-11-05-calendar-design.md`.
8. **Later**: `/sheets` migration from `gsheets`, more DB adapters.

---

## 16. Open items

- **Allowed domains per tenant**: should the tenant client config allow several Workspace
  domains (e.g. a group with two domains) instead of one `hostedDomain`?
- **State cleanup**: is a host-scheduled `deleteExpiredOAuthStates` call enough, or
  should the library clean up opportunistically on each `createAuthUrl`?
- **Audit retention**: should the library offer a retention helper for
  `google_audit_events`, or leave that to the host?
- **Licensing**: MIT, like `gsheets`?
