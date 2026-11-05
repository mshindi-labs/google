import { beforeEach, describe, expect, it } from "vitest";
import { InvalidConfigError } from "../../src/core/errors.js";
import { buildAad, decryptValue } from "../../src/core/crypto/envelope.js";
import { createGoogle } from "../../src/core/create-google.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { InMemoryStore } from "../../src/testing/in-memory-store.js";
import { LocalKeyProvider } from "../../src/testing/local-key-provider.js";
import type { ConnectionRecord } from "../../src/core/types.js";

const c = {
  tenantId: "t1",
  actorId: "admin1",
  clientId: "123-abc.apps.googleusercontent.com",
  clientSecret: "GOCSPX-abcdx7Qa",
};

let store: InMemoryStore;
let kp: LocalKeyProvider;
let events: GoogleEvent[];
let g: ReturnType<typeof createGoogle>;
let clock: Date;

const conn = (): ConnectionRecord => ({
  id: "conn1",
  tenantId: "t1",
  googleSub: "sub1",
  email: "a@x.io",
  displayName: null,
  scopes: ["openid"],
  refreshToken: null,
  status: "active",
  statusReason: null,
  connectedBy: "admin1",
  connectedAt: new Date(0),
  updatedAt: new Date(0),
  lastUsedAt: null,
});

beforeEach(() => {
  store = new InMemoryStore();
  kp = new LocalKeyProvider();
  events = [];
  clock = new Date("2026-01-01T00:00:00Z");
  g = createGoogle({
    store,
    keyProvider: kp,
    callbackUrl: "https://hrms.io/cb",
    onEvent: (e) => {
      events.push(e);
    },
    now: () => clock,
  });
});

describe("clients.configure / get", () => {
  it("returns null for an unconfigured tenant", async () =>
    expect(await g.clients.get("nope")).toBeNull());

  it.each(["abc", "x.apps.googleusercontent.com.evil.com", ""])(
    "rejects malformed client id %j",
    async (clientId) =>
      await expect(
        g.clients.configure({ ...c, clientId }),
      ).rejects.toBeInstanceOf(InvalidConfigError),
  );

  it.each(["", "has space", "tab\tin", "new\nline"])(
    "rejects invalid secret %j",
    async (clientSecret) =>
      await expect(
        g.clients.configure({ ...c, clientSecret }),
      ).rejects.toBeInstanceOf(InvalidConfigError),
  );

  it.each([{ tenantId: "" }, { actorId: "" }])(
    "rejects empty ids %j",
    async (o) =>
      await expect(g.clients.configure({ ...c, ...o })).rejects.toBeInstanceOf(
        InvalidConfigError,
      ),
  );

  it("never returns the secret; hint is last 4", async () => {
    await g.clients.configure(c);
    const v = await g.clients.get("t1");
    expect(v).toEqual({
      clientId: c.clientId,
      secretHint: "x7Qa",
      hostedDomain: null,
      updatedAt: clock,
    });
    expect(JSON.stringify(await store.getOAuthClient("t1"))).not.toContain(
      "GOCSPX-abcdx7Qa",
    );
    expect(JSON.stringify(events)).not.toContain("GOCSPX");
  });

  it("first configure emits oauth_client.configured", async () => {
    await g.clients.configure(c);
    expect(events).toEqual([
      {
        type: "oauth_client.configured",
        tenantId: "t1",
        actorId: "admin1",
        clientIdChanged: false,
        at: clock,
      },
    ]);
  });

  it("same clientId rotation keeps connections active and emits oauth_client.rotated {clientIdChanged:false}", async () => {
    await g.clients.configure(c);
    await store.upsertConnection(conn());
    events.length = 0;
    clock = new Date("2026-02-01T00:00:00Z");
    await g.clients.configure({
      ...c,
      actorId: "admin2",
      clientSecret: "newsecret9999",
    });
    expect((await store.getConnection("t1", "conn1"))!.status).toBe("active");
    expect(events).toMatchObject([
      {
        type: "oauth_client.rotated",
        actorId: "admin2",
        clientIdChanged: false,
      },
    ]);
    const rec = (await store.getOAuthClient("t1"))!;
    expect(rec.createdBy).toBe("admin1");
    expect(rec.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(rec.updatedBy).toBe("admin2");
    expect(rec.updatedAt).toEqual(clock);
    expect(rec.secretHint).toBe("9999");
  });

  it("new clientId revokes tenant connections (client_changed) and emits {clientIdChanged:true}", async () => {
    await g.clients.configure(c);
    await store.upsertConnection(conn());
    events.length = 0;
    await g.clients.configure({
      ...c,
      clientId: "999-zzz.apps.googleusercontent.com",
    });
    const after = (await store.getConnection("t1", "conn1"))!;
    expect(after.status).toBe("revoked");
    expect(after.statusReason).toBe("client_changed");
    expect(events).toMatchObject([
      { type: "oauth_client.rotated", clientIdChanged: true },
    ]);
  });

  it("normalizes hostedDomain to lowercase", async () => {
    await g.clients.configure({ ...c, hostedDomain: " SunCulture.IO " });
    expect((await g.clients.get("t1"))!.hostedDomain).toBe("sunculture.io");
  });

  it("treats empty hostedDomain as null", async () => {
    await g.clients.configure({ ...c, hostedDomain: "  " });
    expect((await g.clients.get("t1"))!.hostedDomain).toBeNull();
  });

  it("encrypts the secret bound to the oauth_client AAD", async () => {
    await g.clients.configure(c);
    const rec = (await store.getOAuthClient("t1"))!;
    const aad = buildAad({
      tenantId: "t1",
      record: "oauth_client",
      recordId: "t1",
      field: "client_secret",
    });
    expect(await decryptValue(rec.clientSecret, aad, kp)).toBe(c.clientSecret);
    await expect(
      decryptValue(
        rec.clientSecret,
        buildAad({
          tenantId: "t2",
          record: "oauth_client",
          recordId: "t2",
          field: "client_secret",
        }),
        kp,
      ),
    ).rejects.toThrow();
  });
});
