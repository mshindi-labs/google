import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresStore,
  fromTypeOrm,
  type Query,
} from "../../src/postgres/index.js";
import { runStoreContractTests } from "../../src/testing/index.js";
import { startPgSocket, TRUNCATE_ALL } from "./pg-socket.js";

// Real TypeORM (Postgres driver over `pg`) against PGlite via pglite-socket.
let pg: Awaited<ReturnType<typeof startPgSocket>>;
let ds: DataSource;

beforeAll(async () => {
  pg = await startPgSocket();
  ds = new DataSource({ type: "postgres", url: pg.url, ssl: false });
  await ds.initialize();
}, 60_000);

afterAll(async () => {
  await ds?.destroy();
  await pg?.stop();
});

const fresh = async (): Promise<void> => {
  await ds.query(TRUNCATE_ALL);
};

runStoreContractTests(
  "PostgresStore via TypeORM (DataSource)",
  async () => {
    await fresh();
    return createPostgresStore({ query: fromTypeOrm(ds) });
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
const HASH = new Uint8Array(32).fill(7);
const HEX = Buffer.from(HASH).toString("hex");

async function seed(query: Query) {
  const store = createPostgresStore({ query });
  await store.upsertOAuthClient(
    {
      tenantId: "t1",
      clientId: "cid",
      clientSecret: ev("s1"),
      secretHint: "h",
      hostedDomain: null,
      createdBy: "a",
      createdAt: T0,
      updatedBy: "a",
      updatedAt: T0,
    },
    { revokeConnections: false },
  );
  await store.insertOAuthState({
    stateHash: HASH,
    tenantId: "t1",
    actorId: "a",
    intendedEmail: null,
    connectionId: null,
    scopes: ["s"],
    codeVerifier: ev("v"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  return store;
}

describe("PostgresStore via TypeORM (pinned QueryRunner)", () => {
  it("uses the caller's runner (same session) and leaves it open", async () => {
    await fresh();
    const runner = ds.createQueryRunner();
    try {
      await runner.query("select set_config('app.tenant', 't1', false)");
      const store = await seed(fromTypeOrm(runner));
      expect((await store.getOAuthClient("t1"))!.clientId).toBe("cid");
      const r = await fromTypeOrm(runner)<{ t: string }>(
        "select current_setting('app.tenant') as t",
        [],
      );
      expect(r.rows).toEqual([{ t: "t1" }]);
      expect(runner.isReleased).toBe(false);
      const state = await store.consumeOAuthState(HEX, T0);
      expect(state!.stateHash).toEqual(HASH);
      expect(await store.consumeOAuthState(HEX, T0)).toBeNull();
    } finally {
      await runner.release();
    }
  });
});

// Why the structured result matters: `dataSource.query(sql, params)` returns
// `[rows, affectedCount]` for UPDATE and DELETE on TypeORM's Postgres driver.
describe("naive TypeORM wrapper (regression)", () => {
  const naive: Query = (async (sql: string, params: unknown[]) => ({
    rows: await ds.query(sql, params),
  })) as Query;

  it("a failed compare-and-swap reports success", async () => {
    await fresh();
    const store = await seed(naive);
    const replaced = await store.replaceEncryptedValue(
      {
        tenantId: "t1",
        record: "oauth_client",
        recordId: "t1",
        field: "client_secret",
        value: ev("stale"),
      },
      ev("new"),
    );
    expect(replaced).toBe(true); // wrong: the stored value was "s1"
    const viaWrapper = await createPostgresStore({
      query: fromTypeOrm(ds),
    }).replaceEncryptedValue(
      {
        tenantId: "t1",
        record: "oauth_client",
        recordId: "t1",
        field: "client_secret",
        value: ev("stale"),
      },
      ev("new"),
    );
    expect(viaWrapper).toBe(false);
  });

  it("an already-consumed OAuth state is not reported as missing", async () => {
    await fresh();
    const store = await seed(naive);
    const first = await store.consumeOAuthState(HEX, T0);
    const second = await store.consumeOAuthState(HEX, T0);
    // The first "state" is the rows array, not a row; the replay is non-null.
    expect(first!.stateHash).not.toEqual(HASH);
    expect(second).not.toBeNull();
  });
});
