import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleApiError } from "../../../src/core/errors.js";
import { InvalidGrantError } from "../../../src/core/oauth/gateway.js";

const m = vi.hoisted(() => ({
  ctor: vi.fn(),
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  revokeToken: vi.fn(),
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
  credentials: {} as { expiry_date?: number | null },
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    constructor(...args: unknown[]) {
      m.ctor(...args);
    }
    getToken = m.getToken;
    verifyIdToken = m.verifyIdToken;
    revokeToken = m.revokeToken;
    setCredentials = m.setCredentials;
    getAccessToken = m.getAccessToken;
    get credentials() {
      return m.credentials;
    }
  },
}));

import { createGoogleAuthGateway } from "../../../src/core/oauth/google-gateway.js";

const gw = createGoogleAuthGateway();

beforeEach(() => {
  vi.clearAllMocks();
  m.credentials = {};
});

describe("google gateway", () => {
  it("exchangeCode passes verifier + redirect_uri and splits scopes", async () => {
    m.getToken.mockResolvedValue({
      tokens: {
        access_token: "ya29.a",
        refresh_token: "1//r",
        id_token: "idt",
        expiry_date: 1_700_000_000_000,
        scope: "openid https://www.googleapis.com/auth/gmail.send",
      },
    });
    const r = await gw.exchangeCode({
      clientId: "cid",
      clientSecret: "sec",
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://x/cb",
    });
    expect(m.ctor).toHaveBeenCalledWith("cid", "sec", "https://x/cb");
    expect(m.getToken).toHaveBeenCalledWith({
      code: "c",
      codeVerifier: "v",
      redirect_uri: "https://x/cb",
    });
    expect(r).toEqual({
      refreshToken: "1//r",
      accessToken: "ya29.a",
      expiresAt: new Date(1_700_000_000_000),
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.send"],
      idToken: "idt",
    });
  });

  it("exchangeCode returns null refreshToken when absent", async () => {
    m.getToken.mockResolvedValue({
      tokens: { access_token: "a", id_token: "i", expiry_date: 1, scope: "" },
    });
    const r = await gw.exchangeCode({
      clientId: "c",
      clientSecret: "s",
      code: "c",
      codeVerifier: "v",
      redirectUri: "u",
    });
    expect(r.refreshToken).toBeNull();
    expect(r.scopes).toEqual([]);
  });

  it("exchangeCode throws a plain Error on missing id_token", async () => {
    m.getToken.mockResolvedValue({
      tokens: { access_token: "a", expiry_date: 1 },
    });
    await expect(
      gw.exchangeCode({
        clientId: "c",
        clientSecret: "s",
        code: "c",
        codeVerifier: "v",
        redirectUri: "u",
      }),
    ).rejects.toThrow(/id_token/);
  });

  it("exchangeCode wraps gaxios errors without leaking the secret", async () => {
    const err = Object.assign(
      new Error(
        "boom client_secret=GOCSPX-SUPERSECRET refresh_token=1//SUPERSECRET",
      ),
      {
        response: { status: 400, data: { error: "invalid_request" } },
        config: { data: "client_secret=GOCSPX-SUPERSECRET" },
      },
    );
    m.getToken.mockRejectedValue(err);
    const e = await gw
      .exchangeCode({
        clientId: "c",
        clientSecret: "GOCSPX-SUPERSECRET",
        code: "c",
        codeVerifier: "v",
        redirectUri: "u",
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect((e as GoogleApiError).status).toBe(400);
    expect((e as GoogleApiError).reason).toBe("invalid_request");
    const cause = (e as Error).cause as Error;
    expect(cause).toBeInstanceOf(Error);
    for (const k of ["config", "request", "response"])
      expect(cause).not.toHaveProperty(k);
    for (const text of [
      (e as Error).message,
      String(cause.message),
      String(cause.stack),
    ]) {
      expect(text).not.toContain("SUPERSECRET");
    }
  });

  it("refreshAccessToken uses setCredentials + getAccessToken", async () => {
    m.getAccessToken.mockImplementation(async () => {
      m.credentials = { expiry_date: 5_000 };
      return { token: "ya29.new" };
    });
    const r = await gw.refreshAccessToken({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "1//r",
    });
    expect(m.setCredentials).toHaveBeenCalledWith({ refresh_token: "1//r" });
    expect(r).toEqual({ accessToken: "ya29.new", expiresAt: new Date(5_000) });
  });

  it("maps invalid_grant in response body to InvalidGrantError", async () => {
    m.getAccessToken.mockRejectedValue(
      Object.assign(new Error("x"), {
        response: { status: 400, data: { error: "invalid_grant" } },
      }),
    );
    await expect(
      gw.refreshAccessToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("maps invalid_grant in the message to InvalidGrantError", async () => {
    m.getAccessToken.mockRejectedValue(
      new Error("invalid_grant: Token has been expired or revoked."),
    );
    await expect(
      gw.refreshAccessToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("wraps other refresh errors as GoogleApiError", async () => {
    m.getAccessToken.mockRejectedValue(
      Object.assign(new Error("x"), { response: { status: 503, data: {} } }),
    );
    const e = await gw
      .refreshAccessToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect((e as GoogleApiError).status).toBe(503);
  });

  it("refresh throws when no access token returned", async () => {
    m.getAccessToken.mockResolvedValue({ token: null });
    await expect(
      gw.refreshAccessToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      }),
    ).rejects.toThrow(/access_token/);
  });

  it("verifyIdToken passes audience and maps claims", async () => {
    m.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: "s1",
        email: "a@b.io",
        email_verified: true,
        hd: "b.io",
      }),
    });
    const r = await gw.verifyIdToken({ idToken: "t", clientId: "cid" });
    expect(m.verifyIdToken).toHaveBeenCalledWith({
      idToken: "t",
      audience: "cid",
    });
    expect(r).toEqual({
      sub: "s1",
      email: "a@b.io",
      emailVerified: true,
      hd: "b.io",
    });
  });

  it("verifyIdToken maps absent hd to null and unverified email", async () => {
    m.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "s1", email: "a@b.io" }),
    });
    const r = await gw.verifyIdToken({ idToken: "t", clientId: "cid" });
    expect(r).toEqual({
      sub: "s1",
      email: "a@b.io",
      emailVerified: false,
      hd: null,
    });
  });

  it.each([{ sub: "s" }, { email: "a@b.io" }])(
    "verifyIdToken rejects payload %o",
    async (p) => {
      m.verifyIdToken.mockResolvedValue({ getPayload: () => p });
      await expect(
        gw.verifyIdToken({ idToken: "t", clientId: "c" }),
      ).rejects.toThrow();
    },
  );

  it("revokeToken calls client.revokeToken", async () => {
    m.revokeToken.mockResolvedValue({});
    await gw.revokeToken("1//r");
    expect(m.revokeToken).toHaveBeenCalledWith("1//r");
  });
});
