import type { EncryptedValue } from "../core/crypto/envelope.js";
import type { GoogleEvent } from "../core/events.js";
import type { CredentialStore } from "../core/store.js";
import type {
  ConnectionRecord,
  ConnectionStatus,
  EncryptedValueRef,
  OAuthClientRecord,
  OAuthStateRecord,
} from "../core/types.js";
import { InvalidConfigError } from "../core/errors.js";
import { resolveNames } from "./migrations.js";

export type Query = <T = Record<string, unknown>>(
  sql: string,
  params: unknown[],
) => Promise<{ rows: T[] }>;

export type PostgresStoreOptions = {
  query: Query;
  schema?: string;
  tablePrefix?: string;
};

type Row = Record<string, unknown>;

const toDate = (v: unknown): Date =>
  v instanceof Date ? v : new Date(v as string);
const toDateOrNull = (v: unknown): Date | null =>
  v == null ? null : toDate(v);
const toEv = (v: unknown): EncryptedValue =>
  (typeof v === "string" ? JSON.parse(v) : v) as EncryptedValue;
const toEvOrNull = (v: unknown): EncryptedValue | null =>
  v == null ? null : toEv(v);
const toBytes = (v: unknown): Uint8Array => {
  if (typeof v === "string") {
    // pg hex text form, e.g. "\x0a0b"
    const h = v.startsWith("\\x") ? v.slice(2) : v;
    return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  }
  return new Uint8Array(v as ArrayLike<number>);
};
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);
const isHex = (v: string): boolean => /^([0-9a-f]{2})*$/i.test(v);
const json = (v: unknown): string => JSON.stringify(v);

const mapClient = (r: Row): OAuthClientRecord => ({
  tenantId: r.tenant_id as string,
  clientId: r.client_id as string,
  clientSecret: toEv(r.client_secret),
  secretHint: r.secret_hint as string,
  hostedDomain: (r.hosted_domain as string | null) ?? null,
  createdBy: r.created_by as string,
  createdAt: toDate(r.created_at),
  updatedBy: r.updated_by as string,
  updatedAt: toDate(r.updated_at),
});

const mapConnection = (r: Row): ConnectionRecord => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  googleSub: r.google_sub as string,
  email: r.email as string,
  displayName: (r.display_name as string | null) ?? null,
  scopes: r.scopes as string[],
  refreshToken: toEvOrNull(r.refresh_token),
  status: r.status as ConnectionStatus,
  statusReason: (r.status_reason as string | null) ?? null,
  connectedBy: r.connected_by as string,
  connectedAt: toDate(r.connected_at),
  updatedAt: toDate(r.updated_at),
  lastUsedAt: toDateOrNull(r.last_used_at),
});

const mapState = (r: Row): OAuthStateRecord => ({
  stateHash: toBytes(r.state_hash),
  tenantId: r.tenant_id as string,
  actorId: r.actor_id as string,
  intendedEmail: (r.intended_email as string | null) ?? null,
  connectionId: (r.connection_id as string | null) ?? null,
  scopes: r.scopes as string[],
  codeVerifier: toEv(r.code_verifier),
  expiresAt: toDate(r.expires_at),
});

export function createPostgresStore(
  opts: PostgresStoreOptions,
): CredentialStore {
  const { schema, prefix } = resolveNames(opts);
  const q = opts.query;
  const tbl = (name: string): string => `"${schema}"."${prefix}${name}"`;
  const CLIENTS = tbl("oauth_clients");
  const CONNS = tbl("connections");
  const STATES = tbl("oauth_states");
  const AUDIT = tbl("audit_events");

  const one = async (sql: string, params: unknown[]): Promise<Row | null> =>
    (await q<Row>(sql, params)).rows[0] ?? null;

  const upsertClientSql = (returning: string): string => `insert into ${CLIENTS}
      (tenant_id, client_id, client_secret, secret_hint, hosted_domain,
       created_by, created_at, updated_by, updated_at)
    values ($1, $2, $3::jsonb, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz)
    on conflict (tenant_id) do update set
      client_id = excluded.client_id,
      client_secret = excluded.client_secret,
      secret_hint = excluded.secret_hint,
      hosted_domain = excluded.hosted_domain,
      created_by = excluded.created_by,
      created_at = excluded.created_at,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
    ${returning}`;

  const clientParams = (rec: OAuthClientRecord): unknown[] => [
    rec.tenantId,
    rec.clientId,
    json(rec.clientSecret),
    rec.secretHint,
    rec.hostedDomain,
    rec.createdBy,
    rec.createdAt.toISOString(),
    rec.updatedBy,
    rec.updatedAt.toISOString(),
  ];

  return {
    async getOAuthClient(tenantId) {
      const r = await one(`select * from ${CLIENTS} where tenant_id = $1`, [
        tenantId,
      ]);
      return r ? mapClient(r) : null;
    },

    async upsertOAuthClient(rec, o) {
      if (!o.revokeConnections) {
        await q(upsertClientSql(""), clientParams(rec));
        return;
      }
      // One statement: upsert + revoke are atomic without a transaction API.
      await q(
        `with up as (${upsertClientSql("returning tenant_id")})
         update ${CONNS} set status = 'revoked', status_reason = 'client_changed',
           updated_at = $9::timestamptz
         where tenant_id in (select tenant_id from up)`,
        clientParams(rec),
      );
    },

    async getConnection(tenantId, connectionId) {
      if (!isUuid(connectionId)) return null;
      const r = await one(
        `select * from ${CONNS} where tenant_id = $1 and id = $2::uuid`,
        [tenantId, connectionId],
      );
      return r ? mapConnection(r) : null;
    },

    async findConnectionBySub(tenantId, googleSub) {
      const r = await one(
        `select * from ${CONNS} where tenant_id = $1 and google_sub = $2`,
        [tenantId, googleSub],
      );
      return r ? mapConnection(r) : null;
    },

    async listConnections(tenantId) {
      const { rows } = await q<Row>(
        `select * from ${CONNS} where tenant_id = $1 order by connected_at, id`,
        [tenantId],
      );
      return rows.map(mapConnection);
    },

    async upsertConnection(rec) {
      if (!isUuid(rec.id)) {
        throw new InvalidConfigError("connection id must be a UUID");
      }
      const r = await one(
        `insert into ${CONNS}
           (id, tenant_id, google_sub, email, display_name, scopes, refresh_token,
            status, status_reason, connected_by, connected_at, updated_at, last_used_at)
         values ($1::uuid, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, $9, $10,
                 $11::timestamptz, $12::timestamptz, $13::timestamptz)
         on conflict (id) do update set
           google_sub = excluded.google_sub,
           email = excluded.email,
           display_name = excluded.display_name,
           scopes = excluded.scopes,
           refresh_token = excluded.refresh_token,
           status = excluded.status,
           status_reason = excluded.status_reason,
           connected_by = excluded.connected_by,
           connected_at = excluded.connected_at,
           updated_at = excluded.updated_at,
           last_used_at = excluded.last_used_at
         where ${CONNS}.tenant_id = excluded.tenant_id
         returning id`,
        [
          rec.id,
          rec.tenantId,
          rec.googleSub,
          rec.email,
          rec.displayName,
          rec.scopes,
          rec.refreshToken ? json(rec.refreshToken) : null,
          rec.status,
          rec.statusReason,
          rec.connectedBy,
          rec.connectedAt.toISOString(),
          rec.updatedAt.toISOString(),
          rec.lastUsedAt ? rec.lastUsedAt.toISOString() : null,
        ],
      );
      if (!r) {
        throw new Error("connection id belongs to a different tenant");
      }
    },

    async updateConnectionStatus(tenantId, connectionId, status, reason) {
      if (!isUuid(connectionId)) return;
      await q(
        `update ${CONNS} set status = $3, status_reason = $4
         where tenant_id = $1 and id = $2::uuid`,
        [tenantId, connectionId, status, reason],
      );
    },

    async touchConnection(tenantId, connectionId, at) {
      if (!isUuid(connectionId)) return;
      await q(
        `update ${CONNS} set last_used_at = $3::timestamptz
         where tenant_id = $1 and id = $2::uuid`,
        [tenantId, connectionId, at.toISOString()],
      );
    },

    async insertOAuthState(rec) {
      if (rec.connectionId != null && !isUuid(rec.connectionId)) {
        throw new InvalidConfigError("connectionId must be a UUID");
      }
      await q(
        `insert into ${STATES}
           (state_hash, tenant_id, actor_id, intended_email, connection_id,
            scopes, code_verifier, expires_at)
         values (decode($1, 'hex'), $2, $3, $4, $5::uuid, $6::text[], $7::jsonb,
                 $8::timestamptz)`,
        [
          toHex(rec.stateHash),
          rec.tenantId,
          rec.actorId,
          rec.intendedEmail,
          rec.connectionId,
          rec.scopes,
          json(rec.codeVerifier),
          rec.expiresAt.toISOString(),
        ],
      );
    },

    async consumeOAuthState(stateHash, now) {
      if (!isHex(stateHash)) return null;
      const r = await one(
        `delete from ${STATES}
         where state_hash = decode($1, 'hex') and expires_at > $2::timestamptz
         returning *`,
        [stateHash.toLowerCase(), now.toISOString()],
      );
      return r ? mapState(r) : null;
    },

    async deleteExpiredOAuthStates(now) {
      const { rows } = await q<Row>(
        `with d as (delete from ${STATES} where expires_at <= $1::timestamptz returning 1)
         select count(*)::int as n from d`,
        [now.toISOString()],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async *iterateEncryptedValues(batchSize) {
      const size = Math.max(1, Math.floor(batchSize));
      // Keyset pagination per table in a fixed order; replacements never move keys.
      let last: string | null = null;
      for (;;) {
        const { rows } = await q<Row>(
          `select tenant_id, client_secret from ${CLIENTS}
           where ($1::text is null or tenant_id > $1) order by tenant_id limit $2`,
          [last, size],
        );
        for (const r of rows) {
          yield {
            tenantId: r.tenant_id as string,
            record: "oauth_client",
            recordId: r.tenant_id as string,
            field: "client_secret",
            value: toEv(r.client_secret),
          } satisfies EncryptedValueRef;
        }
        if (rows.length < size) break;
        last = rows[rows.length - 1]!.tenant_id as string;
      }
      last = null;
      for (;;) {
        const { rows } = await q<Row>(
          `select id::text as id, tenant_id, refresh_token from ${CONNS}
           where refresh_token is not null and ($1::uuid is null or id > $1::uuid)
           order by id limit $2`,
          [last, size],
        );
        for (const r of rows) {
          yield {
            tenantId: r.tenant_id as string,
            record: "connection",
            recordId: r.id as string,
            field: "refresh_token",
            value: toEv(r.refresh_token),
          } satisfies EncryptedValueRef;
        }
        if (rows.length < size) break;
        last = rows[rows.length - 1]!.id as string;
      }
      last = null;
      for (;;) {
        const { rows } = await q<Row>(
          `select encode(state_hash, 'hex') as h, tenant_id, code_verifier from ${STATES}
           where ($1::text is null or state_hash > decode($1, 'hex'))
           order by state_hash limit $2`,
          [last, size],
        );
        for (const r of rows) {
          yield {
            tenantId: r.tenant_id as string,
            record: "oauth_state",
            recordId: r.h as string,
            field: "code_verifier",
            value: toEv(r.code_verifier),
          } satisfies EncryptedValueRef;
        }
        if (rows.length < size) break;
        last = rows[rows.length - 1]!.h as string;
      }
    },

    async replaceEncryptedValue(ref, value) {
      // Compare-and-swap: only replaces if the stored value still equals ref.value.
      const v = json(value);
      const old = json(ref.value);
      let sql: string;
      let params: unknown[];
      if (ref.record === "oauth_client" && ref.field === "client_secret") {
        sql = `update ${CLIENTS} set client_secret = $3::jsonb
           where tenant_id = $1 and tenant_id = $2 and client_secret = $4::jsonb
           returning 1`;
        params = [ref.tenantId, ref.recordId, v, old];
      } else if (ref.record === "connection" && ref.field === "refresh_token") {
        if (!isUuid(ref.recordId)) return false;
        sql = `update ${CONNS} set refresh_token = $3::jsonb
           where tenant_id = $1 and id = $2::uuid and refresh_token = $4::jsonb
           returning 1`;
        params = [ref.tenantId, ref.recordId, v, old];
      } else if (
        ref.record === "oauth_state" &&
        ref.field === "code_verifier"
      ) {
        if (!isHex(ref.recordId)) return false;
        sql = `update ${STATES} set code_verifier = $3::jsonb
           where tenant_id = $1 and state_hash = decode($2, 'hex')
             and code_verifier = $4::jsonb
           returning 1`;
        params = [ref.tenantId, ref.recordId.toLowerCase(), v, old];
      } else {
        throw new Error(`unknown encrypted field ${ref.record}/${ref.field}`);
      }
      return (await q<Row>(sql, params)).rows.length > 0;
    },

    async insertAuditEvent(event: GoogleEvent) {
      const {
        type,
        tenantId,
        actorId: _actorId,
        connectionId: _connectionId,
        ...payload
      } = event as GoogleEvent & { actorId?: string; connectionId?: string };
      if ("connectionId" in event && !isUuid(event.connectionId)) {
        throw new InvalidConfigError("connectionId must be a UUID");
      }
      await q(
        `insert into ${AUDIT}
           (tenant_id, type, actor_id, connection_id, payload, occurred_at)
         values ($1, $2, $3, $4::uuid, $5::jsonb, $6::timestamptz)`,
        [
          tenantId,
          type,
          "actorId" in event ? event.actorId : null,
          "connectionId" in event ? event.connectionId : null,
          json(payload),
          event.at.toISOString(),
        ],
      );
    },
  };
}
