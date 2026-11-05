# Postgres row-level security (optional)

The Postgres adapter always scopes queries by `tenant_id`. Row-level security (RLS) adds
a second, database-enforced layer: even a buggy query cannot read another tenant's rows.

The examples assume the defaults: schema `public`, table prefix `google_`.

## 1. Enable RLS and add policies

Policies compare `tenant_id` with the `app.tenant_id` setting. Passing `true` as the
second argument of `current_setting` returns `NULL` instead of raising an error when the
setting is missing, so an unset tenant matches no rows.

```sql
alter table google_oauth_clients enable row level security;
alter table google_connections   enable row level security;
alter table google_oauth_states  enable row level security;
alter table google_audit_events  enable row level security;

-- Also apply the policies to the table owner.
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

## 2. Set the tenant per transaction

Set `app.tenant_id` with `set local` inside a transaction, so it cannot leak to the next
user of a pooled connection. `set local` does not accept bind parameters; use
`set_config(..., true)`, which is the parameterized equivalent:

```sql
begin;
select set_config('app.tenant_id', $1, true);  -- same as: set local app.tenant_id = '...'
-- ... run the store's queries on this same connection ...
commit;
```

With `pg`, check out one client, run the `begin` / `set_config`, and pass that client's
`query` to `createPostgresStore` for the duration of the request:

```ts
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("select set_config('app.tenant_id', $1, true)", [
    tenantId,
  ]);
  const store = createPostgresStore({
    query: (sql, params) => client.query(sql, params),
  });
  // ... use the store ...
  await client.query("commit");
} catch (e) {
  await client.query("rollback");
  throw e;
} finally {
  client.release();
}
```

Notes:

- Because the policies apply to every statement, `consumeOAuthState` needs the tenant
  setting too. The OAuth callback only learns the tenant from the state row itself, so
  run that single call through the `google_ops` role (below), or resolve the tenant from
  your own session before the callback.
- `FORCE ROW LEVEL SECURITY` is optional. Without it, the table owner bypasses RLS.
  Use a separate, non-owner application role if you leave it off.

## 3. A role for operations tools

Key rotation (`rewrapAll`, Task 14 tools) and `purgeExpiredStates()` walk every tenant, so
they must run as a role that bypasses RLS:

```sql
create role google_ops login password '...' bypassrls;  -- set a real secret via your secret manager
grant usage on schema public to google_ops;
grant select, insert, update, delete on
  google_oauth_clients, google_connections, google_oauth_states, google_audit_events
  to google_ops;
grant usage, select on sequence google_audit_events_id_seq to google_ops;
```

Give this role to the rotation job only. Do not use it for request handling.

## 4. Verify

```sql
begin;
select set_config('app.tenant_id', 'tenant-a', true);
select count(*) from google_connections;   -- only tenant-a rows
rollback;

select count(*) from google_connections;   -- 0 rows: no tenant set
```
