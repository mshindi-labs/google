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

import { buildAad, decryptValue } from "../../src/core/crypto/envelope.js";

describe("connections api", () => {
  it("list returns views with no refreshToken key", async () => {
    const { connection } = await connect();
    await connect("t1");
    const list = await g.connections.list("t1");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("refreshToken");
    expect(list[0]?.id).toBe(connection.id);
    expect(await g.connections.list("t2")).toEqual([]);
  });

  it("get with the wrong tenant → ConnectionNotFoundError", async () => {
    const { connection } = await connect();
    const v = await g.connections.get("t1", connection.id);
    expect(v).not.toHaveProperty("refreshToken");
    await expect(g.connections.get("t2", connection.id)).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it("setDisplayName sanitizes, nulls blanks, and rejects the wrong tenant", async () => {
    const { connection } = await connect();
    clock = new Date("2026-01-02T00:00:00Z");
    const v = await g.connections.setDisplayName({
      tenantId: "t1",
      connectionId: connection.id,
      displayName: "SunCulture Careers",
    });
    expect(v.displayName).toBe("SunCulture Careers");
    expect(v.updatedAt).toEqual(clock);
    expect(v).not.toHaveProperty("refreshToken");
    expect(
      (
        await g.connections.setDisplayName({
          tenantId: "t1",
          connectionId: connection.id,
          displayName: "  ",
        })
      ).displayName,
    ).toBeNull();
    expect(
      (
        await g.connections.setDisplayName({
          tenantId: "t1",
          connectionId: connection.id,
          displayName: " A\u0000B\u0085C\r\nD ",
        })
      ).displayName,
    ).toBe("ABCD");
    expect(
      (
        await g.connections.setDisplayName({
          tenantId: "t1",
          connectionId: connection.id,
          displayName: "x".repeat(150),
        })
      ).displayName,
    ).toHaveLength(100);
    expect(
      (await g.connections.get("t1", connection.id)).displayName,
    ).toHaveLength(100);
    await expect(
      g.connections.setDisplayName({
        tenantId: "t2",
        connectionId: connection.id,
        displayName: "x",
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("disconnect revokes at Google, nulls the token, marks revoked, emits ok", async () => {
    const { connection } = await connect();
    const before = await store.getConnection("t1", connection.id);
    const rt = await decryptValue(
      before!.refreshToken!,
      buildAad({
        tenantId: "t1",
        record: "connection",
        recordId: connection.id,
        field: "refresh_token",
      }),
      g[internals].keyProvider,
    );
    events.length = 0;
    await g.connections.disconnect({
      tenantId: "t1",
      connectionId: connection.id,
      actorId: "admin1",
    });
    expect(fake.revoked).toContain(rt);
    const after = await store.getConnection("t1", connection.id);
    expect(after?.refreshToken).toBeNull();
    expect(after?.status).toBe("revoked");
    expect(after?.statusReason).toBe("disconnected");
    expect(events).toEqual([
      {
        type: "connection.disconnected",
        tenantId: "t1",
        actorId: "admin1",
        connectionId: connection.id,
        googleRevoke: "ok",
        at: clock,
      },
    ]);
    await expect(
      g[internals].tokens.getAccessToken("t1", connection.id),
    ).rejects.toMatchObject({ reason: "disconnected" });
  });

  it("disconnect still succeeds locally when Google revoke fails", async () => {
    const { connection } = await connect();
    fake.failRevoke(true);
    events.length = 0;
    await g.connections.disconnect({
      tenantId: "t1",
      connectionId: connection.id,
      actorId: "admin1",
    });
    const after = await store.getConnection("t1", connection.id);
    expect(after?.refreshToken).toBeNull();
    expect(after?.statusReason).toBe("disconnected");
    expect(events[0]).toMatchObject({
      type: "connection.disconnected",
      googleRevoke: "failed",
    });
    expect(warnings).toEqual(["google token revoke failed"]);
  });

  it("disconnect with no refresh token skips Google and reports ok; wrong tenant is not found", async () => {
    const { connection } = await connect();
    await g.connections.disconnect({
      tenantId: "t1",
      connectionId: connection.id,
      actorId: "a",
    });
    const calls = fake.calls.length;
    events.length = 0;
    await g.connections.disconnect({
      tenantId: "t1",
      connectionId: connection.id,
      actorId: "a",
    });
    expect(fake.calls.length).toBe(calls);
    expect(events[0]).toMatchObject({ googleRevoke: "ok" });
    await expect(
      g.connections.disconnect({
        tenantId: "t2",
        connectionId: connection.id,
        actorId: "a",
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("disconnect with an undecryptable token still nulls it and reports failed", async () => {
    const { connection } = await connect();
    const rec = await store.getConnection("t1", connection.id);
    await store.upsertConnection({
      ...rec!,
      refreshToken: { ...rec!.refreshToken!, ct: "AAAA" },
    });
    events.length = 0;
    await g.connections.disconnect({
      tenantId: "t1",
      connectionId: connection.id,
      actorId: "a",
    });
    expect(
      (await store.getConnection("t1", connection.id))?.refreshToken,
    ).toBeNull();
    expect(events[0]).toMatchObject({ googleRevoke: "failed" });
  });
});
