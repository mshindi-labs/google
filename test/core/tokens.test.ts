import { beforeEach, describe, expect, it } from "vitest";
import {
  ConnectionNotFoundError,
  ConnectionRevokedError,
} from "../../src/core/errors.js";
import { createGoogle } from "../../src/core/create-google.js";
import { internals } from "../../src/core/create-google.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { FakeGoogleOAuth } from "../../src/testing/fake-google-oauth.js";
import { InMemoryStore } from "../../src/testing/in-memory-store.js";
import { LocalKeyProvider } from "../../src/testing/local-key-provider.js";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const cfg = {
  actorId: "admin1",
  clientId: CLIENT_ID,
  clientSecret: "GOCSPX-abcdx7Qa",
};
const careers = {
  sub: "s1",
  email: "careers@sunculture.io",
  hd: "sunculture.io",
};

let store: InMemoryStore;
let fake: FakeGoogleOAuth;
let events: GoogleEvent[];
let warnings: string[];
let clock: Date;
let g: ReturnType<typeof createGoogle>;
const now = () => clock;

const connect = async (tenantId = "t1") => {
  const { url } = await g.oauth.createAuthUrl({
    tenantId,
    actorId: "u1",
    services: ["gmail"],
  });
  const { code, state } = fake.consent(url, careers);
  return g.oauth.handleCallback({ code, state });
};

beforeEach(async () => {
  store = new InMemoryStore();
  clock = new Date("2026-01-01T00:00:00Z");
  fake = new FakeGoogleOAuth({ now });
  events = [];
  warnings = [];
  g = createGoogle({
    store,
    keyProvider: new LocalKeyProvider(),
    callbackUrl: "https://hrms.io/cb",
    oauthGateway: fake,
    onEvent: (e) => {
      events.push(e);
    },
    logger: { warn: (m) => warnings.push(m), error: () => {} },
    now,
  });
  await g.clients.configure({ ...cfg, tenantId: "t1" });
  events.length = 0;
});

const refreshCalls = () =>
  fake.calls.filter((c) => c.method === "refreshAccessToken").length;
const tokens = () => g[internals].tokens;

describe("token manager", () => {
  it("caches the access token until 60s before expiry", async () => {
    const { connection } = await connect();
    const t = tokens();
    t.evict(connection.id); // drop the primed token so the first call refreshes
    const first = await t.getAccessToken("t1", connection.id);
    const second = await t.getAccessToken("t1", connection.id);
    expect(second.accessToken).toBe(first.accessToken);
    expect(refreshCalls()).toBe(1);
    clock = new Date(clock.getTime() + 3_600_000 - 59_000);
    const third = await t.getAccessToken("t1", connection.id);
    expect(third.accessToken).not.toBe(first.accessToken);
    expect(refreshCalls()).toBe(2);
  });

  it("uses the token primed by the callback without calling Google", async () => {
    const { connection } = await connect();
    await tokens().getAccessToken("t1", connection.id);
    expect(refreshCalls()).toBe(0);
  });

  it("single-flights concurrent refreshes", async () => {
    const { connection } = await connect();
    tokens().evict(connection.id);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        tokens().getAccessToken("t1", connection.id),
      ),
    );
    expect(refreshCalls()).toBe(1);
    expect(new Set(rs.map((r) => r.accessToken)).size).toBe(1);
    expect(
      (await store.getConnection("t1", connection.id))?.lastUsedAt,
    ).toEqual(clock);
  });

  it("forceRefresh bypasses the cache", async () => {
    const { connection } = await connect();
    const a = await tokens().getAccessToken("t1", connection.id);
    const b = await tokens().getAccessToken("t1", connection.id, {
      forceRefresh: true,
    });
    expect(refreshCalls()).toBe(1);
    expect(b.accessToken).not.toBe(a.accessToken);
  });

  it("invalid_grant marks revoked, emits, throws, and later calls fail without hitting Google", async () => {
    const { connection } = await connect();
    const rec = await store.getConnection("t1", connection.id);
    const { decryptValue, buildAad } =
      await import("../../src/core/crypto/envelope.js");
    const rt = await decryptValue(
      rec!.refreshToken!,
      buildAad({
        tenantId: "t1",
        record: "connection",
        recordId: connection.id,
        field: "refresh_token",
      }),
      g[internals].keyProvider,
    );
    fake.failRefresh(rt, "invalid_grant");
    await expect(
      tokens().getAccessToken("t1", connection.id, { forceRefresh: true }),
    ).rejects.toMatchObject({
      code: "connection_revoked",
      reason: "invalid_grant",
    });
    const after = await store.getConnection("t1", connection.id);
    expect(after?.status).toBe("revoked");
    expect(after?.statusReason).toBe("invalid_grant");
    expect(events).toContainEqual({
      type: "connection.revoked",
      tenantId: "t1",
      connectionId: connection.id,
      reason: "invalid_grant",
      at: clock,
    });
    const before = refreshCalls();
    await expect(
      tokens().getAccessToken("t1", connection.id),
    ).rejects.toBeInstanceOf(ConnectionRevokedError);
    expect(refreshCalls()).toBe(before);
  });

  it("client id change makes the next call fail even with a cached token", async () => {
    const { connection } = await connect();
    await tokens().getAccessToken("t1", connection.id); // cached
    await g.clients.configure({
      ...cfg,
      tenantId: "t1",
      clientId: "999-new.apps.googleusercontent.com",
    });
    await expect(
      tokens().getAccessToken("t1", connection.id),
    ).rejects.toMatchObject({
      code: "connection_revoked",
      reason: "client_changed",
    });
  });

  it("wrong tenant → ConnectionNotFoundError", async () => {
    const { connection } = await connect();
    await expect(
      tokens().getAccessToken("t2", connection.id),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(tokens().getAccessToken("t1", "nope")).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it("never persists access tokens", async () => {
    const { connection } = await connect();
    const r = await tokens().getAccessToken("t1", connection.id, {
      forceRefresh: true,
    });
    const dump = JSON.stringify([
      await store.listConnections("t1"),
      await store.getOAuthClient("t1"),
      events,
    ]);
    expect(dump).not.toContain(r.accessToken);
    expect(dump).not.toContain("ya29.");
  });

  it("does not cache a refresh that was evicted while in flight", async () => {
    const { connection } = await connect();
    const { createTokenManager } = await import("../../src/core/tokens.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const reached = new Promise<void>((r) => (started = r));
    const slow: typeof fake = Object.create(fake);
    slow.refreshAccessToken = async (p) => {
      started();
      await gate;
      return fake.refreshAccessToken(p);
    };
    const t = createTokenManager({
      store,
      keyProvider: g[internals].keyProvider,
      gateway: slow,
      emit: g[internals].emit,
      now,
    });
    const p = t.getAccessToken("t1", connection.id);
    await reached;
    t.evict(connection.id); // while the refresh is pending
    release();
    await p;
    await t.getAccessToken("t1", connection.id);
    expect(refreshCalls()).toBe(2);
  });

  it("evictTenant drops that tenant's entries", async () => {
    const { connection } = await connect();
    tokens().evictTenant("t1");
    await tokens().getAccessToken("t1", connection.id);
    expect(refreshCalls()).toBe(1);
  });
});

describe("token cache LRU", () => {
  it("evicts the least recently used entry beyond maxEntries", async () => {
    const { createTokenManager } = await import("../../src/core/tokens.js");
    const ids: string[] = [];
    for (const sub of ["s1", "s2", "s3"]) {
      const { url } = await g.oauth.createAuthUrl({
        tenantId: "t1",
        actorId: "u1",
        services: ["gmail"],
      });
      const c = fake.consent(url, {
        sub,
        email: `${sub}@sunculture.io`,
        hd: "sunculture.io",
      });
      ids.push((await g.oauth.handleCallback(c)).connection.id);
    }
    const t = createTokenManager({
      store,
      keyProvider: g[internals].keyProvider,
      gateway: fake,
      emit: g[internals].emit,
      now,
      maxEntries: 2,
    });
    const far = new Date(clock.getTime() + 3_600_000);
    t.prime("t1", ids[0]!, "A", far);
    t.prime("t1", ids[1]!, "B", far);
    await t.getAccessToken("t1", ids[0]!); // touch A: B is now the oldest
    t.prime("t1", ids[2]!, "C", far); // evicts B
    expect((await t.getAccessToken("t1", ids[0]!)).accessToken).toBe("A");
    expect((await t.getAccessToken("t1", ids[2]!)).accessToken).toBe("C");
    expect(refreshCalls()).toBe(0);
    expect((await t.getAccessToken("t1", ids[1]!)).accessToken).not.toBe("B");
    expect(refreshCalls()).toBe(1);
  });
});
