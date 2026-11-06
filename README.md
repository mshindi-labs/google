# @mshindi-labs/google

Multi-tenant Google API utilities for TypeScript. Each tenant brings its own Google
OAuth client; tokens are envelope-encrypted at rest; it sends email through Gmail and books
interviews on Google Calendar.

```sh
npm i @mshindi-labs/google @googleapis/gmail nodemailer html-to-text
```

## Quick start

```ts
import { Pool } from "pg";
import { createGoogle, StaticKeyProvider } from "@mshindi-labs/google/core";
import { createGmail } from "@mshindi-labs/google/gmail";
import { createPostgresStore } from "@mshindi-labs/google/postgres";

const pool = new Pool(); // run getMigrations() from /postgres once
const google = createGoogle({
  store: createPostgresStore({ query: (sql, p) => pool.query(sql, p) }),
  keyProvider: new StaticKeyProvider({
    keys: { v1: Buffer.from(process.env.GOOGLE_KEK!, "base64") }, // 32 bytes
    current: "v1",
  }),
  callbackUrl: "https://app.example.com/api/google/callback",
});

// 1. The tenant admin pastes their OAuth client ID and secret.
await google.clients.configure({ tenantId, actorId, clientId, clientSecret });

// 2. Send them to Google's consent screen; handle the redirect back.
const { url } = await google.oauth.createAuthUrl({
  tenantId,
  actorId,
  services: ["gmail"],
  intendedEmail: "careers@example.com",
});
const { connection } = await google.oauth.handleCallback({
  code,
  state,
  error,
});

// 3. Send mail as that mailbox.
const gmail = createGmail(google);
await gmail.send({
  tenantId,
  actorId,
  connectionId: connection.id,
  to: ["jane@applicant.com"],
  subject: "Your application",
  html: "<p>Hello</p>",
});
```

Entry points: `/core`, `/gmail`, `/calendar`, `/postgres`, `/testing` (there is no root import).
Optional peers (`@googleapis/gmail`, `@googleapis/calendar`, `nodemailer`, `html-to-text`, KMS clients) are
loaded on first use; a missing one throws `MissingPeerDependencyError` with the
`npm i` command to run.

Every library error extends `GoogleLibError` and carries a stable `code` (for example
`connection_revoked`). Match errors on `err.code`, not `instanceof`: if your app loads
the ESM build of one entry point and the CommonJS build of another, each build has its
own error classes and `instanceof` can be false for a genuine library error.

## Guides

- [Tenant setup](docs/guides/tenant-setup.md): for a tenant admin creating the Google OAuth client.
- [Host integration](docs/guides/host-integration.md): wiring, routes, error messages, key providers.
- [Calendar scheduling](docs/guides/calendar-scheduling.md): idempotent interview booking, reschedule, cancel, free/busy.
- [Bulk sending](docs/guides/bulk-sending.md): a queue pattern that never double-sends.
- [Prisma and TypeORM](docs/guides/orm-integration.md): plugging an ORM into the Postgres store.
- [Postgres row-level security](docs/guides/postgres-rls.md): optional database-enforced tenant isolation.
- [Design spec](docs/SPEC.md): invariants, flows, threat model.

## Security model

- **Envelope encryption.** Client secrets and refresh tokens are AES-256-GCM encrypted
  with per-value keys, wrapped by a `KeyProvider` (KMS in production). The key
  encryption key never lives in the database.
- **Bound ciphertext.** Each value's tenant, record and field are authenticated data, so
  a ciphertext copied to another tenant or column fails to decrypt.
- **Hardened OAuth.** Single-use hashed `state` bound to tenant and actor, PKCE S256, a
  fixed HTTPS redirect URI, and ID token checks (audience, verified email, hosted
  domain, intended account).
- **Least privilege.** Only `openid email`, `gmail.send` and, for Calendar, `calendar.events.owned` and
  `calendar.events.freebusy`. Tokens are revoked at
  Google on a wrong-account or partial-scope consent, and when a tenant disconnects.
- **No secrets in output.** Errors, events and logs are redacted; events never carry
  bodies, tokens or secrets, and recipients can be hashed (`redactRecipients`).

## Requirements

Node 18 or newer. ESM and CommonJS are both supported. MIT licensed.
