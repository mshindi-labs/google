# Postgres row-level security (optional)

The Postgres adapter always scopes queries by `tenant_id`. Row-level security (RLS) adds
a second, database-enforced layer: even a buggy query cannot read another tenant's rows.

The examples assume the defaults: schema `public`, table prefix `google_`. If you use a
non-public schema, the host must create it (`create schema ...`) before running the
migration; the migration does not create schemas.

## 1. Enable RLS and add policies

Policies compare `tenant_id` with the `app.tenant_id` setting. Passing `true` as the
second argument of `current_setting` returns `NULL` (or `''` on a pooled session where the
setting was previously set and reset) instead of raising an error when the setting is
missing. Neither value equals a real tenant id, so an unset tenant matches no rows.

```sql
alter table google_oauth_clients enable row level security;
alter table google_connections   enable row level security;
alter table google_oauth_states  enable row level security;
alter table google_audit_events  enable row level security;

-- Recommended: apply the policies to the table owner too. Skip these four statements
-- only if the application connects as a separate, non-owner role.
alter table google_oauth_clients force row level security;
alter table google_connections   force row level security;
alter table google_oauth_states  force row level security;
alter table google_audit_events  force row level security;

create policy tenant_isolation on google_oauth_clients
  using      (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

create policy tenant_isolation on google_connections
  using      (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

create policy tenant_isolation on google_oauth_states
  using      (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

create policy tenant_isolation on google_audit_events
  using      (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
```

## 2. Set the tenant on the connection you hand to the store

Check out one connection per request, set `app.tenant_id` on it, give that connection's
`query` to `createPostgresStore`, and reset the setting before releasing it.

Do not wrap library calls in a transaction that rolls back on error. Several flows
legitimately throw after a successful write (for example `handleCallback` consumes the
OAuth state, then may throw `UnexpectedAccountError`, `MissingScopeError` or
`OAuthConsentDeniedError`); a rollback would restore the consumed state and let it be
replayed. A long transaction would also stay open across the Google HTTP calls. Use a
session-level setting instead (`set_config(..., false)`):

```ts
const client = await pool.connect();
try {
  await client.query("select set_config('app.tenant_id', $1, false)", [
    tenantId,
  ]);
  const store = createPostgresStore({
    query: (sql, params) => client.query(sql, params),
  });
  // ... use the store / google instance built on it ...
} finally {
  await client.query("select set_config('app.tenant_id', '', false)");
  client.release();
}
```

If you prefer transactions, use `set local` / `set_config(..., true)` inside one, and
commit (not roll back) when the library throws.

### The OAuth callback

`handleCallback` consumes the state, loads the tenant's OAuth client, upserts the
connection and writes audit events. Every one of these needs `app.tenant_id`, and it
cannot change part-way through. So the host sets `app.tenant_id` from its own session
(the signed-in admin's tenant) before calling `handleCallback`, like any other request.

A useful side effect: a `state` that belongs to another tenant is invisible under that
setting, so it consumes as `null` and the callback fails with `InvalidOAuthStateError`.

## 3. A role for rotation tools

Key rotation (`rewrapAll`) and `purgeExpiredStates()` walk every tenant, so they must run
as a role that bypasses RLS. Use it for those jobs only, never for request handling or the
OAuth callback:

```sql
create role google_ops login password '...' bypassrls;  -- set a real secret via your secret manager
grant usage on schema public to google_ops;
grant select, insert, update, delete on
  google_oauth_clients, google_connections, google_oauth_states, google_audit_events
  to google_ops;
grant usage, select on sequence google_audit_events_id_seq to google_ops;
```

## 4. Verify

```sql
begin;
select set_config('app.tenant_id', 'tenant-a', true);
select count(*) from google_connections;   -- counts tenant-a rows only
rollback;

select count(*) from google_connections;   -- returns 0: no tenant set, so no rows match
```
