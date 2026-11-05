import { beforeEach, describe, expect, it } from "vitest";
import {
  ConnectionNotFoundError,
  InvalidConfigError,
  OAuthClientNotConfiguredError,
} from "../../../src/core/errors.js";
import { createGoogle } from "../../../src/core/create-google.js";
import type { GoogleEvent } from "../../../src/core/events.js";
import { sha256 } from "../../../src/core/oauth/pkce.js";
import { FakeGoogleOAuth } from "../../../src/testing/fake-google-oauth.js";
import { InMemoryStore } from "../../../src/testing/in-memory-store.js";
import { LocalKeyProvider } from "../../../src/testing/local-key-provider.js";
import type { ConnectionRecord } from "../../../src/core/types.js";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const CALLBACK = "https://hrms.io/cb";
const cfg = {
  actorId: "admin1",
  clientId: CLIENT_ID,
  clientSecret: "GOCSPX-abcdx7Qa",
};

let store: InMemoryStore;
let events: GoogleEvent[];
let clock: Date;
let g: ReturnType<typeof createGoogle>;
const now = () => clock;

const conn = (tenantId: string, id: string, status = "active" as const) =>
  ({
    id,
    tenantId,
    googleSub: `sub-${id}`,
    email: "a@x.io",
    displayName: null,
    scopes: ["openid"],
    refreshToken: null,
    status,
    statusReason: null,
    connectedBy: "admin1",
    connectedAt: new Date(0),
    updatedAt: new Date(0),
    lastUsedAt: null,
  }) satisfies ConnectionRecord;

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

beforeEach(async () => {
  store = new InMemoryStore();
  events = [];
  clock = new Date("2026-01-01T00:00:00Z");
  g = createGoogle({
    store,
    keyProvider: new LocalKeyProvider(),
    callbackUrl: CALLBACK,
    onEvent: (e) => {
      events.push(e);
    },
    now,
  });
  await g.clients.configure({
    ...cfg,
    tenantId: "t1",
    hostedDomain: "sunculture.io",
  });
  await g.clients.configure({ ...cfg, tenantId: "t2" });
  events.length = 0;
});

describe("oauth.createAuthUrl", () => {
  it("throws OAuthClientNotConfiguredError for unconfigured tenant", async () =>
    await expect(
      g.oauth.createAuthUrl({
        tenantId: "nope",
        actorId: "u",
        services: ["gmail"],
      }),
    ).rejects.toBeInstanceOf(OAuthClientNotConfiguredError));

  it("rejects empty services", async () =>
    await expect(
      g.oauth.createAuthUrl({ tenantId: "t1", actorId: "u", services: [] }),
    ).rejects.toBeInstanceOf(InvalidConfigError));

  it("rejects unknown services", async () =>
    await expect(
      g.oauth.createAuthUrl({
        tenantId: "t1",
        actorId: "u",
        services: ["drive" as never],
      }),
    ).rejects.toBeInstanceOf(InvalidConfigError));

  it.each([{ tenantId: "" }, { actorId: "" }])(
    "rejects empty ids %j",
    async (o) =>
      await expect(
        g.oauth.createAuthUrl({
          tenantId: "t1",
          actorId: "u",
          services: ["gmail"],
          ...o,
        }),
      ).rejects.toBeInstanceOf(InvalidConfigError),
  );

  it("builds the URL with every required param", async () => {
    const { url, expiresAt } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
      intendedEmail: " Careers@SunCulture.io ",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
      scope: "openid email https://www.googleapis.com/auth/gmail.send",
      login_hint: "careers@sunculture.io",
      hd: "sunculture.io",
    });
    expect(u.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(u.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(expiresAt.getTime() - now().getTime()).toBe(600_000);
  });

  it("stores only the state hash and an encrypted verifier, and emits no event", async () => {
    const { url, expiresAt } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
      intendedEmail: " Careers@SunCulture.io ",
    });
    const state = stateOf(url);
    const rec = await store.consumeOAuthState(hex(sha256(state)), now());
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      tenantId: "t1",
      actorId: "u1",
      intendedEmail: "careers@sunculture.io",
      connectionId: null,
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
      expiresAt,
    });
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain(state);
    expect(events).toEqual([]);
  });

  it("omits hd when tenant has no hostedDomain and login_hint when no intendedEmail", async () => {
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t2",
      actorId: "u",
      services: ["gmail"],
      intendedEmail: "   ",
    });
    const q = new URL(url).searchParams;
    expect(q.has("hd")).toBe(false);
    expect(q.has("login_hint")).toBe(false);
    const rec = await store.consumeOAuthState(hex(sha256(stateOf(url))), now());
    expect(rec?.intendedEmail).toBeNull();
  });

  it("requires connectionId to belong to the tenant", async () => {
    await store.upsertConnection(conn("t2", "connOfT2"));
    await expect(
      g.oauth.createAuthUrl({
        tenantId: "t1",
        actorId: "u",
        services: ["gmail"],
        connectionId: "connOfT2",
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("allows re-authorizing a revoked connection and records its id", async () => {
    await store.upsertConnection(conn("t1", "c1", "revoked" as never));
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u",
      services: ["gmail"],
      connectionId: "c1",
    });
    const rec = await store.consumeOAuthState(hex(sha256(stateOf(url))), now());
    expect(rec?.connectionId).toBe("c1");
  });

  it("produces a URL the fake Google consent accepts", async () => {
    const fake = new FakeGoogleOAuth({ now });
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u",
      services: ["gmail"],
    });
    const out = fake.consent(url, { sub: "s1", email: "a@sunculture.io" });
    expect(out.state).toBe(stateOf(url));
    expect(out.code).toBeTruthy();
  });

  it("generates a fresh state each time", async () => {
    const p = { tenantId: "t1", actorId: "u", services: ["gmail" as const] };
    const a = await g.oauth.createAuthUrl(p);
    const b = await g.oauth.createAuthUrl(p);
    expect(stateOf(a.url)).not.toBe(stateOf(b.url));
  });
});

describe("oauth.purgeExpiredStates", () => {
  it("deletes only expired states", async () => {
    const p = { tenantId: "t1", actorId: "u", services: ["gmail" as const] };
    const old = await g.oauth.createAuthUrl(p);
    clock = new Date(clock.getTime() + 300_000);
    const fresh = await g.oauth.createAuthUrl(p);
    clock = new Date(clock.getTime() + 300_000); // old expires exactly now
    expect(await g.oauth.purgeExpiredStates()).toBe(1);
    expect(
      await store.consumeOAuthState(hex(sha256(stateOf(old.url))), now()),
    ).toBeNull();
    expect(
      await store.consumeOAuthState(hex(sha256(stateOf(fresh.url))), now()),
    ).not.toBeNull();
    expect(await g.oauth.purgeExpiredStates()).toBe(0);
  });
});
