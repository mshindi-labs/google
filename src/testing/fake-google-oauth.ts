import { InvalidGrantError } from "../core/oauth/gateway.js";
import type { OAuthGateway } from "../core/oauth/gateway.js";
import { codeChallenge } from "../core/oauth/pkce.js";

type Account = {
  sub: string;
  email: string;
  hd?: string | null;
  emailVerified?: boolean;
  grantScopes?: string[];
  omitRefreshToken?: boolean;
};

type Consent = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  account: Account;
  used: boolean;
};

const USERINFO_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const ACCESS_TTL_MS = 3_600_000;

/** In-process stand-in for Google's OAuth endpoints, implementing OAuthGateway. */
export class FakeGoogleOAuth implements OAuthGateway {
  readonly revoked: string[] = [];
  readonly calls: { method: string }[] = [];

  private readonly now: () => Date;
  private n = 0;
  private revokeFails = false;
  private readonly codes = new Map<string, Consent>();
  private readonly idTokens = new Map<
    string,
    { clientId: string; account: Account }
  >();
  private readonly refreshTokens = new Map<string, string>(); // token -> clientId
  private readonly failing = new Set<string>();

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  consent(authUrl: string, account: Account): { code: string; state: string } {
    const q = new URL(authUrl).searchParams;
    const requested = (q.get("scope") ?? "").split(" ").filter(Boolean);
    const scopes =
      account.grantScopes ??
      requested.map((s) => (s === "email" ? USERINFO_EMAIL : s));
    const code = `fake-code-${++this.n}`;
    this.codes.set(code, {
      clientId: q.get("client_id") ?? "",
      redirectUri: q.get("redirect_uri") ?? "",
      challenge: q.get("code_challenge") ?? "",
      scopes,
      account,
      used: false,
    });
    return { code, state: q.get("state") ?? "" };
  }

  async exchangeCode(p: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    this.calls.push({ method: "exchangeCode" });
    const c = this.codes.get(p.code);
    if (!c) throw new Error("invalid_grant: unknown code");
    if (c.used) throw new Error("invalid_grant: code already used");
    c.used = true;
    if (c.clientId !== p.clientId) throw new Error("invalid_client");
    if (c.redirectUri !== p.redirectUri)
      throw new Error("redirect_uri_mismatch");
    if (codeChallenge(p.codeVerifier) !== c.challenge)
      throw new Error("invalid_grant: PKCE verifier mismatch");

    const id = ++this.n;
    const idToken = `fake-id.${id}`;
    this.idTokens.set(idToken, { clientId: c.clientId, account: c.account });
    let refreshToken: string | null = null;
    if (!c.account.omitRefreshToken) {
      refreshToken = `1//fake-refresh-${id}`;
      this.refreshTokens.set(refreshToken, c.clientId);
    }
    return {
      refreshToken,
      accessToken: `ya29.fake-access-${id}`,
      expiresAt: new Date(this.now().getTime() + ACCESS_TTL_MS),
      scopes: [...c.scopes],
      idToken,
    };
  }

  async verifyIdToken(p: { idToken: string; clientId: string }) {
    this.calls.push({ method: "verifyIdToken" });
    const t = this.idTokens.get(p.idToken);
    if (!t || t.clientId !== p.clientId) throw new Error("invalid id token");
    return {
      sub: t.account.sub,
      email: t.account.email,
      emailVerified: t.account.emailVerified ?? true,
      hd: t.account.hd ?? null,
    };
  }

  async refreshAccessToken(p: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }) {
    this.calls.push({ method: "refreshAccessToken" });
    const owner = this.refreshTokens.get(p.refreshToken);
    if (
      owner === undefined ||
      owner !== p.clientId ||
      this.failing.has(p.refreshToken) ||
      this.revoked.includes(p.refreshToken)
    ) {
      throw new InvalidGrantError();
    }
    return {
      accessToken: `ya29.fake-access-${++this.n}`,
      expiresAt: new Date(this.now().getTime() + ACCESS_TTL_MS),
    };
  }

  async revokeToken(token: string): Promise<void> {
    this.calls.push({ method: "revokeToken" });
    if (this.revokeFails) throw new Error("revoke failed");
    this.revoked.push(token);
  }

  failRefresh(refreshToken: string, _error: "invalid_grant"): void {
    this.failing.add(refreshToken);
  }

  failRevoke(on: boolean): void {
    this.revokeFails = on;
  }
}
