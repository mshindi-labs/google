export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Thrown by a gateway when Google reports `invalid_grant` (refresh token
 * revoked/expired). The core maps it to ConnectionRevokedError; callers of
 * createGoogle never see it.
 */
export class InvalidGrantError extends Error {
  constructor(message = "invalid_grant") {
    super(message);
    this.name = "InvalidGrantError";
  }
}

export interface OAuthGateway {
  exchangeCode(p: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{
    refreshToken: string | null;
    accessToken: string;
    expiresAt: Date;
    scopes: string[];
    idToken: string;
  }>;
  verifyIdToken(p: { idToken: string; clientId: string }): Promise<{
    sub: string;
    email: string;
    emailVerified: boolean;
    hd: string | null;
  }>;
  /** Throws InvalidGrantError on `invalid_grant`. */
  refreshAccessToken(p: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<{ accessToken: string; expiresAt: Date }>;
  revokeToken(token: string): Promise<void>;
}
