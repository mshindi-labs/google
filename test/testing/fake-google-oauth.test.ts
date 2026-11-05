import { describe, expect, it } from "vitest";
import { InvalidGrantError } from "../../src/core/oauth/gateway.js";
import { codeChallenge } from "../../src/core/oauth/pkce.js";
import { FakeGoogleOAuth } from "../../src/testing/fake-google-oauth.js";

const VERIFIER = "v".repeat(43);
const url = (o: Record<string, string> = {}) => {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  const p = {
    client_id: "cid",
    redirect_uri: "https://x/cb",
    code_challenge: codeChallenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "openid email https://www.googleapis.com/auth/gmail.send",
    state: "st8",
    ...o,
  };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
};
const acct = { sub: "sub1", email: "a@b.io" };
const ex = (code: string, o: Record<string, string> = {}) => ({
  clientId: "cid",
  clientSecret: "s",
  code,
  codeVerifier: VERIFIER,
  redirectUri: "https://x/cb",
  ...o,
});

describe("FakeGoogleOAuth", () => {
  it("consent returns state and a fresh code", () => {
    const f = new FakeGoogleOAuth();
    const a = f.consent(url(), acct);
    const b = f.consent(url(), acct);
    expect(a.state).toBe("st8");
    expect(a.code).not.toBe(b.code);
  });

  it("exchange succeeds and defaults scopes to the URL scope", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), acct);
    const r = await f.exchangeCode(ex(code));
    expect(r.refreshToken).toMatch(/^1\/\/fake-refresh-/);
    expect(r.accessToken).toMatch(/^ya29\.fake-access-/);
    expect(r.scopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  it("grantScopes replaces the list verbatim", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), {
      ...acct,
      grantScopes: ["openid", "email"],
    });
    expect((await f.exchangeCode(ex(code))).scopes).toEqual([
      "openid",
      "email",
    ]);
  });

  it("omitRefreshToken yields null refresh token", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), { ...acct, omitRefreshToken: true });
    expect((await f.exchangeCode(ex(code))).refreshToken).toBeNull();
  });

  it("access token expires 3600s after the fake clock", async () => {
    const f = new FakeGoogleOAuth({ now: () => new Date(1_000_000) });
    const { code } = f.consent(url(), acct);
    expect((await f.exchangeCode(ex(code))).expiresAt).toEqual(
      new Date(1_000_000 + 3_600_000),
    );
  });

  it("rejects wrong verifier, client, redirect", async () => {
    const f = new FakeGoogleOAuth();
    const bad: Record<string, string>[] = [
      { codeVerifier: "w".repeat(43) },
      { clientId: "other" },
      { redirectUri: "https://evil/cb" },
    ];
    for (const o of bad) {
      const { code } = f.consent(url(), acct);
      await expect(f.exchangeCode(ex(code, o))).rejects.toThrow();
    }
  });

  it("rejects an unknown or reused code", async () => {
    const f = new FakeGoogleOAuth();
    await expect(f.exchangeCode(ex("nope"))).rejects.toThrow();
    const { code } = f.consent(url(), acct);
    await f.exchangeCode(ex(code));
    await expect(f.exchangeCode(ex(code))).rejects.toThrow();
  });

  it("verifyIdToken maps account and rejects wrong clientId", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), { ...acct, hd: "b.io" });
    const { idToken } = await f.exchangeCode(ex(code));
    expect(await f.verifyIdToken({ idToken, clientId: "cid" })).toEqual({
      sub: "sub1",
      email: "a@b.io",
      emailVerified: true,
      hd: "b.io",
    });
    await expect(
      f.verifyIdToken({ idToken, clientId: "other" }),
    ).rejects.toThrow();
    await expect(
      f.verifyIdToken({ idToken: "junk", clientId: "cid" }),
    ).rejects.toThrow();
  });

  it("defaults hd to null", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), acct);
    const { idToken } = await f.exchangeCode(ex(code));
    expect((await f.verifyIdToken({ idToken, clientId: "cid" })).hd).toBeNull();
  });

  it("refreshAccessToken issues a new token; rejects unknown / other client", async () => {
    const f = new FakeGoogleOAuth({ now: () => new Date(0) });
    const { code } = f.consent(url(), acct);
    const { refreshToken } = await f.exchangeCode(ex(code));
    const r = await f.refreshAccessToken({
      clientId: "cid",
      clientSecret: "s",
      refreshToken: refreshToken!,
    });
    expect(r.accessToken).toMatch(/^ya29\.fake-access-/);
    expect(r.expiresAt).toEqual(new Date(3_600_000));
    await expect(
      f.refreshAccessToken({
        clientId: "cid",
        clientSecret: "s",
        refreshToken: "1//nope",
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      f.refreshAccessToken({
        clientId: "other",
        clientSecret: "s",
        refreshToken: refreshToken!,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("failRefresh makes refresh throw InvalidGrantError", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), acct);
    const { refreshToken } = await f.exchangeCode(ex(code));
    f.failRefresh(refreshToken!, "invalid_grant");
    await expect(
      f.refreshAccessToken({
        clientId: "cid",
        clientSecret: "s",
        refreshToken: refreshToken!,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("revokeToken records, and revoked refresh tokens fail refresh", async () => {
    const f = new FakeGoogleOAuth();
    const { code } = f.consent(url(), acct);
    const { refreshToken } = await f.exchangeCode(ex(code));
    await f.revokeToken(refreshToken!);
    expect(f.revoked).toEqual([refreshToken]);
    await expect(
      f.refreshAccessToken({
        clientId: "cid",
        clientSecret: "s",
        refreshToken: refreshToken!,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("failRevoke(true) makes revokeToken reject", async () => {
    const f = new FakeGoogleOAuth();
    f.failRevoke(true);
    await expect(f.revokeToken("x")).rejects.toThrow();
    expect(f.revoked).toEqual([]);
  });

  it("records calls", async () => {
    const f = new FakeGoogleOAuth();
    await f.revokeToken("x");
    expect(f.calls).toEqual([{ method: "revokeToken" }]);
  });
});
