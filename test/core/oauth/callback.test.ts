import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidOAuthStateError,
  MissingScopeError,
  NoRefreshTokenError,
  OAuthClientNotConfiguredError,
  OAuthConsentDeniedError,
  UnexpectedAccountError,
} from "../../../src/core/errors.js";
import { createGoogle } from "../../../src/core/create-google.js";
import type { GoogleEvent } from "../../../src/core/events.js";
import { buildAad, decryptValue } from "../../../src/core/crypto/envelope.js";
import { sha256 } from "../../../src/core/oauth/pkce.js";
import { FakeGoogleOAuth } from "../../../src/testing/fake-google-oauth.js";
import { InMemoryStore } from "../../../src/testing/in-memory-store.js";
import { LocalKeyProvider } from "../../../src/testing/local-key-provider.js";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-abcdx7Qa";
const cfg = { actorId: "admin1", clientId: CLIENT_ID, clientSecret: SECRET };

type Account = Parameters<FakeGoogleOAuth["consent"]>[1];
type Opts = {
  tenantId?: string;
  actorId?: string;
  intendedEmail?: string;
  connectionId?: string;
};

let store: InMemoryStore;
let kp: LocalKeyProvider;
let fake: FakeGoogleOAuth;
let events: GoogleEvent[];
let warnings: string[];
let clock: Date;
let g: ReturnType<typeof createGoogle>;
let thrown: Error[];
const now = () => clock;

const connect = async (account: Account, opts: Opts = {}) => {
  const { url } = await g.oauth.createAuthUrl({
    tenantId: opts.tenantId ?? "t1",
    actorId: opts.actorId ?? "u1",
    services: ["gmail"],
    ...(opts.intendedEmail ? { intendedEmail: opts.intendedEmail } : {}),
    ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
  });
  const { code, state } = fake.consent(url, account);
  try {
    return await g.oauth.handleCallback({ code, state });
  } catch (e) {
    thrown.push(e as Error);
    throw e;
  }
};

const careers = {
  sub: "s1",
  email: "careers@sunculture.io",
  hd: "sunculture.io",
};

beforeEach(async () => {
  store = new InMemoryStore();
  kp = new LocalKeyProvider();
  clock = new Date("2026-01-01T00:00:00Z");
  fake = new FakeGoogleOAuth({ now });
  events = [];
  warnings = [];
  thrown = [];
  g = createGoogle({
    store,
    keyProvider: kp,
    callbackUrl: "https://hrms.io/cb",
    oauthGateway: fake,
    onEvent: (e) => {
      events.push(e);
    },
    logger: { warn: (m) => warnings.push(m), error: () => {} },
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

describe("oauth.handleCallback", () => {
  it("creates an active connection with verified email and sub", async () => {
    const r = await connect(careers, {
      intendedEmail: "Careers@SunCulture.io",
    });
    expect(r.created).toBe(true);
    expect(r.tenantId).toBe("t1");
    expect(r.actorId).toBe("u1");
    expect(r.connection).toMatchObject({
      tenantId: "t1",
      googleSub: "s1",
      email: "careers@sunculture.io",
      status: "active",
      statusReason: null,
      connectedBy: "u1",
    });
    expect(r.connection).not.toHaveProperty("refreshToken");
    const row = await store.getConnection("t1", r.connection.id);
    const aad = buildAad({
      tenantId: "t1",
      record: "connection",
      recordId: r.connection.id,
      field: "refresh_token",
    });
    expect(await decryptValue(row!.refreshToken!, aad, kp)).toMatch(
      /^1\/\/fake-refresh-/,
    );
  });

  it("replayed state → InvalidOAuthStateError, exactly one connection", async () => {
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
    });
    const { code, state } = fake.consent(url, careers);
    await g.oauth.handleCallback({ code, state });
    await expect(
      g.oauth.handleCallback({ code, state }),
    ).rejects.toBeInstanceOf(InvalidOAuthStateError);
    expect(await store.listConnections("t1")).toHaveLength(1);
  });

  it("expired state → InvalidOAuthStateError", async () => {
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
    });
    const { code, state } = fake.consent(url, careers);
    clock = new Date(clock.getTime() + 600_001);
    await expect(
      g.oauth.handleCallback({ code, state }),
    ).rejects.toBeInstanceOf(InvalidOAuthStateError);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([{}, { state: "" }, { state: "garbage" }])(
    "missing/garbage state %j → InvalidOAuthStateError",
    async (p) => {
      await expect(
        g.oauth.handleCallback({ code: "c", ...p }),
      ).rejects.toBeInstanceOf(InvalidOAuthStateError);
    },
  );

  it("error=access_denied → OAuthConsentDeniedError and the state is consumed", async () => {
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
    });
    const { state } = fake.consent(url, careers);
    await expect(
      g.oauth.handleCallback({ state, error: "access_denied" }),
    ).rejects.toBeInstanceOf(OAuthConsentDeniedError);
    expect(
      await store.consumeOAuthState(
        Buffer.from(sha256(state)).toString("hex"),
        now(),
      ),
    ).toBeNull();
  });

  it.each([{}, { code: "" }])(
    "valid state with missing/empty code %j → InvalidOAuthStateError, state consumed",
    async (p) => {
      const { url } = await g.oauth.createAuthUrl({
        tenantId: "t1",
        actorId: "u1",
        services: ["gmail"],
      });
      const { state } = fake.consent(url, careers);
      await expect(
        g.oauth.handleCallback({ state, ...p }),
      ).rejects.toBeInstanceOf(InvalidOAuthStateError);
      expect(
        await store.consumeOAuthState(
          Buffer.from(sha256(state)).toString("hex"),
          now(),
        ),
      ).toBeNull();
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("wrong account → UnexpectedAccountError and token revoked at Google", async () => {
    await expect(
      connect(
        { sub: "s9", email: "me@gmail.com", hd: "sunculture.io" },
        { intendedEmail: "careers@sunculture.io" },
      ),
    ).rejects.toBeInstanceOf(UnexpectedAccountError);
    expect(fake.revoked).toHaveLength(1);
    expect(fake.revoked[0]).toMatch(/^1\/\/fake-refresh-/);
    expect(await store.listConnections("t1")).toHaveLength(0);
  });

  it("revoke failure is swallowed and logged without the token", async () => {
    fake.failRevoke(true);
    await expect(
      connect(
        { sub: "s9", email: "me@gmail.com", hd: "sunculture.io" },
        { intendedEmail: "careers@sunculture.io" },
      ),
    ).rejects.toBeInstanceOf(UnexpectedAccountError);
    expect(warnings).toEqual(["google token revoke failed"]);
  });

  it("ID token email in different case from intendedEmail still matches", async () => {
    const r = await connect(
      { ...careers, email: " Careers@SunCulture.IO " },
      { intendedEmail: "careers@sunculture.io" },
    );
    expect(r.connection.email).toBe("careers@sunculture.io");
  });

  it("hd mismatch → UnexpectedAccountError (revoked)", async () => {
    await expect(
      connect({ sub: "s2", email: "a@other.io", hd: "other.io" }),
    ).rejects.toBeInstanceOf(UnexpectedAccountError);
    await expect(
      connect({ sub: "s3", email: "a@gmail.com" }),
    ).rejects.toBeInstanceOf(UnexpectedAccountError);
    expect(fake.revoked).toHaveLength(2);
  });

  it("hd comparison is case-insensitive", async () => {
    const r = await connect({ ...careers, hd: "SunCulture.IO" });
    expect(r.created).toBe(true);
  });

  it("email_verified false → UnexpectedAccountError", async () => {
    await expect(
      connect({ ...careers, emailVerified: false }),
    ).rejects.toBeInstanceOf(UnexpectedAccountError);
    expect(fake.revoked).toHaveLength(1);
  });

  it("user unticks gmail.send → MissingScopeError and token revoked", async () => {
    await expect(
      connect({
        ...careers,
        grantScopes: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
      }),
    ).rejects.toBeInstanceOf(MissingScopeError);
    expect(fake.revoked).toHaveLength(1);
  });

  it('granted "userinfo.email" alias does not count as missing', async () => {
    const r = await connect(careers);
    expect(r.connection.scopes).toContain(
      "https://www.googleapis.com/auth/userinfo.email",
    );
    expect(r.connection.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("no refresh token → NoRefreshTokenError, access token revoked", async () => {
    await expect(
      connect({ ...careers, omitRefreshToken: true }),
    ).rejects.toBeInstanceOf(NoRefreshTokenError);
    expect(fake.revoked).toHaveLength(1);
    expect(fake.revoked[0]).toMatch(/^ya29\.fake-access-/);
    expect(await store.listConnections("t1")).toHaveLength(0);
  });

  it("state's tenant is used: a t1 state cannot create a t2 connection", async () => {
    const r = await connect(
      { sub: "s5", email: "x@sunculture.io", hd: "sunculture.io" },
      { tenantId: "t1" },
    );
    expect(r.tenantId).toBe("t1");
    expect(await store.listConnections("t2")).toHaveLength(0);
    expect(await store.listConnections("t1")).toHaveLength(1);
  });

  it("missing client for the state's tenant → OAuthClientNotConfiguredError", async () => {
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t2",
      actorId: "u1",
      services: ["gmail"],
    });
    const { code, state } = fake.consent(url, { sub: "s", email: "a@b.io" });
    const empty = new InMemoryStore();
    const g2 = createGoogle({
      store: empty,
      keyProvider: kp,
      callbackUrl: "https://hrms.io/cb",
      oauthGateway: fake,
      now,
    });
    await empty.insertOAuthState(
      (await store.consumeOAuthState(
        Buffer.from(sha256(state)).toString("hex"),
        now(),
      ))!,
    );
    await expect(
      g2.oauth.handleCallback({ code, state }),
    ).rejects.toBeInstanceOf(OAuthClientNotConfiguredError);
  });

  it("re-connecting the same account keeps the row, reactivates a revoked one, created=false", async () => {
    const first = await connect(careers, { actorId: "u1" });
    await store.updateConnectionStatus(
      "t1",
      first.connection.id,
      "revoked",
      "disconnected",
    );
    clock = new Date("2026-01-02T00:00:00Z");
    const second = await connect(careers, { actorId: "u2" });
    expect(second.created).toBe(false);
    expect(second.actorId).toBe("u2");
    expect(second.connection).toMatchObject({
      id: first.connection.id,
      connectedBy: "u1",
      connectedAt: first.connection.connectedAt,
      displayName: first.connection.displayName,
      status: "active",
      statusReason: null,
      updatedAt: clock,
    });
    expect(await store.listConnections("t1")).toHaveLength(1);
  });

  it("adding scopes to a connection with a different Google account → UnexpectedAccountError", async () => {
    const first = await connect(careers);
    await expect(
      connect(
        { sub: "other", email: "other@sunculture.io", hd: "sunculture.io" },
        { connectionId: first.connection.id },
      ),
    ).rejects.toBeInstanceOf(UnexpectedAccountError);
    expect(fake.revoked).toHaveLength(1);
  });

  it("adding scopes with the same account succeeds", async () => {
    const first = await connect(careers);
    const again = await connect(careers, { connectionId: first.connection.id });
    expect(again.created).toBe(false);
    expect(again.connection.id).toBe(first.connection.id);
  });

  it("emits connection.created then connection.scopes_added", async () => {
    const first = await connect(careers, { actorId: "u1" });
    await connect(careers, { actorId: "u2" });
    expect(events.map((e) => e.type)).toEqual([
      "connection.created",
      "connection.scopes_added",
    ]);
    expect(events[0]).toMatchObject({
      tenantId: "t1",
      actorId: "u1",
      connectionId: first.connection.id,
      email: "careers@sunculture.io",
      at: clock,
    });
    expect(events[1]).toMatchObject({
      actorId: "u2",
      connectionId: first.connection.id,
    });
    expect((events[1] as { scopes: string[] }).scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("upsertConnection failure → original error rethrown, token revoked", async () => {
    const boom = new Error("db down");
    vi.spyOn(store, "upsertConnection").mockRejectedValueOnce(boom);
    await expect(connect(careers)).rejects.toBe(boom);
    expect(fake.revoked).toHaveLength(1);
  });

  it("key provider encrypt failure → original error rethrown, token revoked", async () => {
    const boom = new Error("kms down");
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
    });
    const { code, state } = fake.consent(url, careers);
    vi.spyOn(kp, "wrap").mockRejectedValueOnce(boom);
    await expect(g.oauth.handleCallback({ code, state })).rejects.toBe(boom);
    expect(fake.revoked).toHaveLength(1);
    expect(await store.listConnections("t1")).toHaveLength(0);
  });

  it("store lookup failure → original error rethrown, token revoked", async () => {
    const boom = new Error("db down");
    vi.spyOn(store, "findConnectionBySub").mockRejectedValueOnce(boom);
    await expect(connect(careers)).rejects.toBe(boom);
    expect(fake.revoked).toHaveLength(1);
  });

  it("concurrent first-time connects of one account: one wins, the loser's token is revoked", async () => {
    const mk = async () => {
      const { url } = await g.oauth.createAuthUrl({
        tenantId: "t1",
        actorId: "u1",
        services: ["gmail"],
      });
      return fake.consent(url, careers);
    };
    const [a, b] = [await mk(), await mk()];
    const res = await Promise.allSettled([
      g.oauth.handleCallback(a),
      g.oauth.handleCallback(b),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(fake.revoked).toHaveLength(1);
    expect(await store.listConnections("t1")).toHaveLength(1);
  });

  it("no thrown error message, stack or cause contains the code, tokens or secret", async () => {
    // Drive a failure through each rejection path, collecting what was thrown.
    const { url } = await g.oauth.createAuthUrl({
      tenantId: "t1",
      actorId: "u1",
      services: ["gmail"],
    });
    const { code, state } = fake.consent(url, careers);
    await g.oauth.handleCallback({ code, state });
    await g.oauth.handleCallback({ code, state }).catch((e) => thrown.push(e));
    await g.oauth
      .handleCallback({ state: "x", code })
      .catch((e) => thrown.push(e));
    fake.failRevoke(true);
    await connect({ sub: "z", email: "z@gmail.com" }).catch(() => {});
    await connect({ ...careers, sub: "z2", omitRefreshToken: true }).catch(
      () => {},
    );
    await connect({ ...careers, sub: "z3", grantScopes: ["openid"] }).catch(
      () => {},
    );
    expect(thrown.length).toBeGreaterThanOrEqual(4);
    const text = (e: unknown): string => {
      const err = e as Error;
      return `${err.message}\n${err.stack ?? ""}\n${err.cause ? text(err.cause) : ""}`;
    };
    for (const e of thrown) {
      const t = text(e);
      expect(t).not.toContain(code);
      expect(t).not.toContain(SECRET);
      expect(t).not.toMatch(/1\/\/fake-refresh-|ya29\.fake-access-/);
    }
    expect(warnings.join(" ")).not.toMatch(
      /1\/\/fake-refresh-|ya29\.fake-access-/,
    );
  });
});
