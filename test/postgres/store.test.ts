import { PGlite } from "@electric-sql/pglite";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InvalidConfigError } from "../../src/core/errors.js";
import { getMigrations } from "../../src/postgres/migrations.js";
import { createPostgresStore, type Query } from "../../src/postgres/index.js";
import { runStoreContractTests } from "../../src/testing/index.js";

const open: PGlite[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

type Dump = Awaited<ReturnType<PGlite["dumpDataDir"]>>;

// Booting PGlite is slow; migrate once per options and load a copy per test.
const templates = new Map<string, Promise<Dump>>();
async function migratedTemplate(opts?: {
  schema?: string;
  tablePrefix?: string;
}): Promise<Dump> {
  const key = JSON.stringify(opts ?? {});
  if (!templates.has(key)) {
    templates.set(
      key,
      (async () => {
        const pg = await PGlite.create();
        if (opts?.schema) await pg.exec(`create schema "${opts.schema}"`);
        for (const m of getMigrations(opts)) await pg.exec(m.sql);
        const dump = await pg.dumpDataDir("none");
        await pg.close();
        return dump;
      })(),
    );
  }
  return templates.get(key)!;
}

const CUSTOM = { schema: "mail", tablePrefix: "gx_" };
beforeAll(async () => {
  await Promise.all([migratedTemplate(), migratedTemplate(CUSTOM)]);
}, 120_000);

async function freshDb(opts?: { schema?: string; tablePrefix?: string }) {
  const pg = await PGlite.create({ loadDataDir: await migratedTemplate(opts) });
  open.push(pg);
  const query: Query = (sql, params) =>
    pg.query(sql, params) as Promise<{ rows: never[] }>;
  return { pg, query };
}

runStoreContractTests(
  "PostgresStore",
  async () => {
    const { query } = await freshDb();
    return createPostgresStore({ query });
  },
  { describe, it, expect, beforeEach },
);

const ev = (ct: string) => ({
  v: 1 as const,
  kid: "k",
  wdek: "AA",
  iv: "AA",
  ct,
  tag: "AA",
});
const T0 = new Date("2026-01-01T00:00:00.000Z");
const client = (tenantId: string) => ({
  tenantId,
  clientId: "cid",
  clientSecret: ev("s"),
  secretHint: "h",
  hostedDomain: null,
  createdBy: "a",
  createdAt: T0,
  updatedBy: "a",
  updatedAt: T0,
});

describe("PostgresStore extras", () => {
  it("runs with a custom schema and prefix", async () => {
    const o = CUSTOM;
    const { query } = await freshDb(o);
    const store = createPostgresStore({ query, ...o });
    await store.upsertOAuthClient(client("t1"), { revokeConnections: false });
    expect((await store.getOAuthClient("t1"))!.clientId).toBe("cid");
  });

  it("rejects unsafe identifiers", () => {
    const query: Query = async () => ({ rows: [] });
    expect(() =>
      createPostgresStore({ query, schema: "public; drop" }),
    ).toThrow(InvalidConfigError);
    expect(() => createPostgresStore({ query, tablePrefix: "A-b" })).toThrow(
      InvalidConfigError,
    );
  });

  it("client_changed revoke is atomic in one statement", async () => {
    const { query } = await freshDb();
    const spy = vi.fn(query) as unknown as Query;
    const store = createPostgresStore({ query: spy });
    await store.upsertOAuthClient(client("t1"), { revokeConnections: false });
    (spy as unknown as ReturnType<typeof vi.fn>).mockClear();
    await store.upsertOAuthClient(client("t1"), { revokeConnections: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stores encrypted values as jsonb, not text", async () => {
    const { query } = await freshDb();
    const store = createPostgresStore({ query });
    await store.upsertOAuthClient(client("t1"), { revokeConnections: false });
    const r = await query<{ t: string }>(
      "select jsonb_typeof(client_secret) as t from google_oauth_clients",
      [],
    );
    expect(r.rows[0]!.t).toBe("object");
  });

  it("writes audit events with payload minus column fields", async () => {
    const { query } = await freshDb();
    const store = createPostgresStore({ query });
    await store.insertAuditEvent!({
      type: "connection.revoked",
      tenantId: "t1",
      connectionId: "00000000-0000-4000-8000-000000000001",
      reason: "x",
      at: T0,
    });
    const r = await query<{
      type: string;
      payload: Record<string, unknown>;
      actor_id: string | null;
    }>("select type, actor_id, payload from google_audit_events", []);
    expect(r.rows[0]!.type).toBe("connection.revoked");
    expect(r.rows[0]!.actor_id).toBeNull();
    expect(r.rows[0]!.payload).toEqual({ reason: "x", at: T0.toISOString() });
  });

  it("rejects non-UUID connection ids on state and audit inserts", async () => {
    const { query } = await freshDb();
    const store = createPostgresStore({ query });
    await expect(
      store.insertOAuthState({
        stateHash: new Uint8Array(32).fill(1),
        tenantId: "t1",
        actorId: "a",
        intendedEmail: null,
        connectionId: "nope",
        scopes: [],
        codeVerifier: ev("x"),
        expiresAt: T0,
      }),
    ).rejects.toThrow(InvalidConfigError);
    await expect(
      store.insertAuditEvent!({
        type: "connection.revoked",
        tenantId: "t1",
        connectionId: "nope",
        reason: "x",
        at: T0,
      }),
    ).rejects.toThrow(InvalidConfigError);
  });
});
