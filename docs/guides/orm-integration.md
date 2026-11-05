# Using Prisma or TypeORM

`createPostgresStore` takes a driver-agnostic `query(sql, params) => Promise<{ rows }>`.
If your app already talks to Postgres through Prisma or TypeORM, wrap the client you
have with `fromPrisma` or `fromTypeOrm` from `@mshindi-labs/google/postgres`. Neither
ORM is a dependency of this library; the wrappers only call the methods named below.

The library owns its four tables (`google_oauth_clients`, `google_connections`,
`google_oauth_states`, `google_audit_events`). Create them with `getMigrations()` through
your ORM's migration tool, and read and write them only through the library. Rows hold
envelope-encrypted values bound to their tenant, record and field; writing them through
ORM models bypasses those checks and can make values undecryptable.

## Prisma

Tested with Prisma 7 (the `prisma-client` generator with `@prisma/adapter-pg`). The
wrapper uses only `$queryRawUnsafe`, which every current Prisma version has.

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { createPostgresStore, fromPrisma } from "@mshindi-labs/google/postgres";

// Prisma 7: the client needs a driver adapter.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const store = createPostgresStore({ query: fromPrisma(prisma) });
```

`fromPrisma` calls `prisma.$queryRawUnsafe(sql, ...params)`. Despite the name, the
library's statements use positional `$1, $2…` placeholders and Prisma sends the values
separately from the SQL, so nothing is interpolated. On Postgres, `$queryRawUnsafe`
returns `[]` for statements without `RETURNING`, so one method serves every statement.
An interactive-transaction client works the same way: `fromPrisma(tx)`.

### Schema

If you want the tables visible in `schema.prisma` (for example so `prisma migrate dev`
does not see them as drift), add these models. They match the library's migration exactly
(column types, defaults, the unique key, the indexes and the cascading foreign key), so
`prisma migrate diff` against a migrated database is empty. The `status` check constraint
cannot be expressed in Prisma; it lives in the migration SQL.

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}

/// Owned by @mshindi-labs/google. Read and write through the library only.
model GoogleOAuthClient {
  tenantId     String             @id @map("tenant_id")
  clientId     String             @map("client_id")
  clientSecret Json               @map("client_secret")
  secretHint   String             @map("secret_hint")
  hostedDomain String?            @map("hosted_domain")
  createdBy    String             @map("created_by")
  createdAt    DateTime           @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedBy    String             @map("updated_by")
  updatedAt    DateTime           @default(now()) @map("updated_at") @db.Timestamptz(6)
  connections  GoogleConnection[]

  @@map("google_oauth_clients")
}

/// Owned by @mshindi-labs/google. Read and write through the library only.
model GoogleConnection {
  id           String            @id @db.Uuid
  tenantId     String            @map("tenant_id")
  googleSub    String            @map("google_sub")
  email        String
  displayName  String?           @map("display_name")
  scopes       String[]
  refreshToken Json?             @map("refresh_token")
  status       String
  statusReason String?           @map("status_reason")
  connectedBy  String            @map("connected_by")
  connectedAt  DateTime          @default(now()) @map("connected_at") @db.Timestamptz(6)
  updatedAt    DateTime          @default(now()) @map("updated_at") @db.Timestamptz(6)
  lastUsedAt   DateTime?         @map("last_used_at") @db.Timestamptz(6)
  client       GoogleOAuthClient @relation(fields: [tenantId], references: [tenantId], onDelete: Cascade, onUpdate: NoAction)

  @@unique([tenantId, googleSub])
  @@index([tenantId])
  @@map("google_connections")
}

/// Owned by @mshindi-labs/google. Read and write through the library only.
model GoogleOAuthState {
  stateHash     Bytes    @id @map("state_hash")
  tenantId      String   @map("tenant_id")
  actorId       String   @map("actor_id")
  intendedEmail String?  @map("intended_email")
  connectionId  String?  @map("connection_id") @db.Uuid
  scopes        String[]
  codeVerifier  Json     @map("code_verifier")
  expiresAt     DateTime @map("expires_at") @db.Timestamptz(6)

  @@index([expiresAt])
  @@map("google_oauth_states")
}

/// Owned by @mshindi-labs/google. Read and write through the library only.
model GoogleAuditEvent {
  id           BigInt   @id @default(autoincrement())
  tenantId     String   @map("tenant_id")
  type         String
  actorId      String?  @map("actor_id")
  connectionId String?  @map("connection_id") @db.Uuid
  payload      Json
  occurredAt   DateTime @default(now()) @map("occurred_at") @db.Timestamptz(6)

  @@index([tenantId, occurredAt(sort: Desc)])
  @@map("google_audit_events")
}
```

The models assume the defaults (schema `public`, prefix `google_`). With a custom
`tablePrefix`, change each `@@map`; with a custom schema, use Prisma's `multiSchema`
support and `@@schema`.

Do not use these models to write rows, and keep them out of seed scripts. Reading them
(for example to list a tenant's mailboxes) is fine but `listConnections` is the
supported API.

### Migration

Give each library migration its own Prisma migration, so Prisma's history records the
tables and later library migrations apply once, in order. For `0001_init`, create an
empty migration and paste only that migration's SQL into it:

```sh
npx prisma migrate dev --create-only --name google_0001_init
```

```ts
// print the SQL to paste into prisma/migrations/<timestamp>_google_0001_init/migration.sql
import { getMigrations } from "@mshindi-labs/google/postgres";
const m = getMigrations().find((m) => m.id === "0001_init")!;
console.log(m.sql);
```

Then run `npx prisma migrate dev`. When a library release adds a migration (for example
`0002_…`), create a new Prisma migration for it the same way, with only that id's SQL.
Never paste the whole `getMigrations()` list into a new migration: the earlier statements
would fail on tables that already exist. If you would rather not track the tables in Prisma,
run `getMigrations()` yourself (see [host integration](./host-integration.md)) and use
`npx prisma db pull` to bring the models into `schema.prisma` afterwards.

## TypeORM

TypeORM 0.3 or newer with the `postgres` driver (tested with TypeORM 1.1). Older
versions have no structured query result; the wrapper throws `InvalidConfigError` on them.

```ts
import { DataSource } from "typeorm";
import {
  createPostgresStore,
  fromTypeOrm,
} from "@mshindi-labs/google/postgres";

export const dataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
});
await dataSource.initialize();

const store = createPostgresStore({ query: fromTypeOrm(dataSource) });
```

Given a `DataSource`, the wrapper creates a `QueryRunner` for each statement and releases
it afterwards. Given a `QueryRunner`, it uses that runner and never releases it. Anything
with a `release` method counts as a `QueryRunner`, even if it also has
`createQueryRunner`. Inside `dataSource.transaction(async (manager) => …)`, pass
`fromTypeOrm(manager.queryRunner!)` so the library's statements join that transaction
(and read the RLS guide on rollbacks first).

### Migration

Do not define entities for these tables and do not let `synchronize: true` manage them:
TypeORM would try to alter or drop columns it does not know about. Create them with one
TypeORM migration per library migration id, each running only that id's SQL:

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";
import { getMigrations } from "@mshindi-labs/google/postgres";

export class GoogleInit1767225600000 implements MigrationInterface {
  name = "GoogleInit1767225600000";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const m of getMigrations().filter((m) => m.id === "0001_init")) {
      await queryRunner.query(m.sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists
      google_audit_events, google_oauth_states, google_connections, google_oauth_clients`);
  }
}
```

When a library release adds a migration (for example `0002_…`), add a new TypeORM
migration that filters on that id. Do not edit `GoogleInit…` to run more of the list:
TypeORM records it as already run.

If you pass `schema` or `tablePrefix` to `createPostgresStore`, pass the same options to
`getMigrations()` and adjust the table names in `down`.

### Pinning a connection (row-level security)

With [row-level security](./postgres-rls.md), every statement must run on the connection
that has `app.tenant_id` set. Check out a `QueryRunner`, set the tenant, and pass the
runner itself:

```ts
const runner = dataSource.createQueryRunner();
try {
  await runner.query("select set_config('app.tenant_id', $1, false)", [
    tenantId,
  ]);
  const store = createPostgresStore({ query: fromTypeOrm(runner) });
  // ... use the store / google instance built on it ...
} finally {
  try {
    await runner.query("select set_config('app.tenant_id', '', false)");
  } finally {
    await runner.release(); // runs even if the reset fails
  }
}
```

### Row-level security with Prisma

Prisma does not let you pin a pooled connection outside a transaction, so a session
setting is not reachable. The only way to set `app.tenant_id` for the library's
statements is `set_config(..., true)` inside an interactive transaction,
`prisma.$transaction(async (tx) => …)` with `fromPrisma(tx)`. That has two hazards:

- **Timeouts.** An interactive transaction is rolled back when it runs longer than
  `timeout` (default 5000 ms) or waits longer than `maxWait` (default 2000 ms) for a
  connection. The OAuth callback makes Google HTTP calls (token exchange, ID token
  checks) inside the flow, so the default timeout can expire mid-flow. The rollback
  un-consumes the OAuth state, which can then be replayed.
- **Rollback on throw.** Prisma also rolls back when the callback throws, and several
  library flows legitimately throw after a successful write (see the
  [RLS guide](./postgres-rls.md)). That also restores a consumed OAuth state.

For RLS, prefer a plain `pg` client (see the RLS guide) or a pinned TypeORM `QueryRunner`
as above, both of which use a session setting with no transaction. If you use Prisma
anyway, size the timeouts for the whole flow, and return the error instead of throwing
so the transaction commits:

```ts
const result = await prisma.$transaction(
  async (tx) => {
    await tx.$queryRawUnsafe(
      "select set_config('app.tenant_id', $1, true)",
      tenantId,
    );
    const google = createGoogle({
      store: createPostgresStore({ query: fromPrisma(tx) }),
      ...opts,
    });
    try {
      return { ok: await google.oauth.handleCallback({ code, state, error }) };
    } catch (err) {
      return { err }; // commit, so the consumed state stays consumed
    }
  },
  { timeout: 30_000, maxWait: 5_000 }, // longer than the slowest Google round trip
);
if ("err" in result) throw result.err;
```

Even then, a timeout still rolls back and allows a replay of that state. Treat this setup
as weaker than session pinning.

### Why the wrapper asks for a structured result

`fromTypeOrm` always calls `query(sql, params, true)` and returns `result.records`. Plain
`dataSource.query(sql, params)` on TypeORM's Postgres driver returns the rows for a
SELECT or INSERT, but `[rows, affectedCount]` for an UPDATE or DELETE. A wrapper that
passed that through as `rows` would see two "rows" for every UPDATE or DELETE, even one
that matched nothing. The store relies on `DELETE … RETURNING` to consume an OAuth state
exactly once, and on `UPDATE … RETURNING` for compare-and-swap during key rotation, so a
replayed OAuth state would be accepted and a lost rotation race would report success.
The library's tests run the store contract through a naive wrapper to show this.

## Errors and logging

ORM errors propagate as the same object. Statement parameters can contain ciphertext and
OAuth state hashes; they are not plaintext secrets, but keep them out of logs anyway:

- TypeORM's `QueryFailedError` carries the statement and its `parameters`.
  `fromTypeOrm` clears `parameters` on the error before rethrowing it, so `instanceof`,
  `code`, `constraint` and `message` still work. It cannot stop TypeORM's own logger:
  TypeORM logs a failed query before it throws, and with `logging: true`, `["error"]` or
  `["query"]` the log line includes `-- PARAMETERS: [...]`. Keep `logging` off for the
  connection the library uses, or give it a custom `logger` that drops parameters.
- Prisma's raw-query errors (`P2010`) do not include parameters. Keep Prisma's `query`
  log level off in production for the same reason.
