create table "{{schema}}"."{{prefix}}oauth_clients" (
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

create table "{{schema}}"."{{prefix}}connections" (
  id              uuid primary key,
  tenant_id       text not null references "{{schema}}"."{{prefix}}oauth_clients"(tenant_id) on delete cascade,
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
create index on "{{schema}}"."{{prefix}}connections" (tenant_id);

create table "{{schema}}"."{{prefix}}oauth_states" (
  state_hash      bytea primary key,
  tenant_id       text not null,
  actor_id        text not null,
  intended_email  text,
  connection_id   uuid,
  scopes          text[] not null,
  code_verifier   jsonb not null,
  expires_at      timestamptz not null
);
create index on "{{schema}}"."{{prefix}}oauth_states" (expires_at);

create table "{{schema}}"."{{prefix}}audit_events" (
  id              bigserial primary key,
  tenant_id       text not null,
  type            text not null,
  actor_id        text,
  connection_id   uuid,
  payload         jsonb not null,
  occurred_at     timestamptz not null default now()
);
create index on "{{schema}}"."{{prefix}}audit_events" (tenant_id, occurred_at desc);
