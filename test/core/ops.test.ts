import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoogle } from "../../src/core/create-google.js";
import { buildAad, decryptValue } from "../../src/core/crypto/envelope.js";
import { StaticKeyProvider } from "../../src/core/crypto/static-key-provider.js";
import { rewrapAll, verifyAll } from "../../src/core/ops.js";
import { FakeGoogleOAuth } from "../../src/testing/fake-google-oauth.js";
import { InMemoryStore } from "../../src/testing/in-memory-store.js";

const SECRET = "GOCSPX-abcdx7Qa";
const keyA = randomBytes(32);
const keyB = randomBytes(32);
const keyC = randomBytes(32);

let store: InMemoryStore;
let fake: FakeGoogleOAuth;
let connIds: Record<string, string>;
const clock = new Date("2026-01-01T00:00:00Z");

const kpA = new StaticKeyProvider({ keys: { a: keyA }, current: "a" });
const kpB = new StaticKeyProvider({ keys: { a: keyA, b: keyB }, current: "b" });
const kpBOnly = new StaticKeyProvider({ keys: { b: keyB }, current: "b" });
const kpC = new StaticKeyProvider({
  keys: { a: keyA, b: keyB, c: keyC },
  current: "c",
});

const kids = async () => {
  const out: string[] = [];
  for await (const r of store.iterateEncryptedValues(10)) out.push(r.value.kid);
  return out;
};

beforeEach(async () => {
  store = new InMemoryStore();
  fake = new FakeGoogleOAuth({ now: () => clock });
  const g = createGoogle({
    store,
    keyProvider: kpA,
    callbackUrl: "https://hrms.io/cb",
    oauthGateway: fake,
    now: () => clock,
  });
  connIds = {};
  for (const t of ["t1", "t2"]) {
    await g.clients.configure({
      tenantId: t,
      actorId: "admin1",
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: SECRET,
    });
    const { url } = await g.oauth.createAuthUrl({
      tenantId: t,
      actorId: "u1",
      services: ["gmail"],
    });
    const { code, state } = fake.consent(url, {
      sub: `sub-${t}`,
      email: `${t}@example.com`,
    });
    const r = await g.oauth.handleCallback({ code, state });
    connIds[t] = r.connection.id;
  }
  // one pending oauth_state row
  await g.oauth.createAuthUrl({
    tenantId: "t1",
    actorId: "u1",
    services: ["gmail"],
  });
});

describe("rewrapAll", () => {
  it("rewraps everything to the current key, and data still decrypts with only the new key", async () => {
    const before = await kids();
    expect(before.length).toBe(5);
    expect(new Set(before)).toEqual(new Set(["static:a"]));

    const r = await rewrapAll({ store, keyProvider: kpB });
    expect(r).toEqual({ rewrapped: 5, skipped: 0, failed: [] });
    expect(new Set(await kids())).toEqual(new Set(["static:b"]));

    const v = await verifyAll({ store, keyProvider: kpBOnly });
    expect(v).toEqual({ ok: 5, failed: [] });

    const conn = await store.getConnection("t1", connIds["t1"]!);
    const plain = await decryptValue(
      conn!.refreshToken!,
      buildAad({
        tenantId: "t1",
        record: "connection",
        recordId: connIds["t1"]!,
        field: "refresh_token",
      }),
      kpBOnly,
    );
    expect(plain.length).toBeGreaterThan(0);
  });

  it("is idempotent: second run rewraps 0, skips all", async () => {
    await rewrapAll({ store, keyProvider: kpB });
    const r = await rewrapAll({ store, keyProvider: kpB, batchSize: 2 });
    expect(r).toEqual({ rewrapped: 0, skipped: 5, failed: [] });
  });

  it("fromKeyId limits scope", async () => {
    await rewrapAll({ store, keyProvider: kpB });
    const r = await rewrapAll({
      store,
      keyProvider: kpC,
      fromKeyId: "static:a",
    });
    expect(r).toEqual({ rewrapped: 0, skipped: 5, failed: [] });
    const r2 = await rewrapAll({
      store,
      keyProvider: kpC,
      fromKeyId: "static:b",
    });
    expect(r2).toEqual({ rewrapped: 5, skipped: 0, failed: [] });
    expect(new Set(await kids())).toEqual(new Set(["static:c"]));
  });

  it("records failures by code and continues the run", async () => {
    // provider that cannot unwrap key a
    const r = await rewrapAll({ store, keyProvider: kpBOnly });
    expect(r.rewrapped).toBe(0);
    expect(r.failed).toHaveLength(5);
    expect(r.failed.every((f) => f.error === "credential_integrity")).toBe(
      true,
    );
    expect(r.failed.map((f) => f.record)).toContain(
      `connection:${connIds["t1"]}.refresh_token`,
    );
    expect(r.failed.map((f) => f.record)).toContain(
      "oauth_client:t1.client_secret",
    );
  });

  it("counts a compare-and-swap miss as skipped, not failed", async () => {
    const orig = store.replaceEncryptedValue.bind(store);
    store.replaceEncryptedValue = async () => false;
    const r = await rewrapAll({ store, keyProvider: kpB });
    store.replaceEncryptedValue = orig;
    expect(r).toEqual({ rewrapped: 0, skipped: 5, failed: [] });
  });
});

describe("verifyAll", () => {
  it("reports ok for healthy data", async () => {
    expect(await verifyAll({ store, keyProvider: kpA })).toEqual({
      ok: 5,
      failed: [],
    });
  });

  it("reports a ciphertext moved between tenants", async () => {
    const t1 = await store.getConnection("t1", connIds["t1"]!);
    const t2 = await store.getConnection("t2", connIds["t2"]!);
    await store.upsertConnection({ ...t2!, refreshToken: t1!.refreshToken });
    const r = await verifyAll({ store, keyProvider: kpA, batchSize: 3 });
    expect(r.ok).toBe(4);
    expect(r.failed).toEqual([
      {
        record: `connection:${connIds["t2"]}.refresh_token`,
        error: "credential_integrity",
      },
    ]);
  });

  it("verifyAll output contains no plaintext", async () => {
    const t1 = await store.getConnection("t1", connIds["t1"]!);
    const t2 = await store.getConnection("t2", connIds["t2"]!);
    await store.upsertConnection({ ...t2!, refreshToken: t1!.refreshToken });
    const plain = await decryptValue(
      t1!.refreshToken!,
      buildAad({
        tenantId: "t1",
        record: "connection",
        recordId: connIds["t1"]!,
        field: "refresh_token",
      }),
      kpA,
    );
    const out = JSON.stringify([
      await verifyAll({ store, keyProvider: kpA }),
      await rewrapAll({ store, keyProvider: kpBOnly }),
    ]);
    expect(out).not.toContain(plain);
    expect(out).not.toContain(SECRET);
  });
});
