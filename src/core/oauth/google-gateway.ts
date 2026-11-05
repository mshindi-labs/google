import { OAuth2Client } from "google-auth-library";
import { GoogleApiError } from "../errors.js";
import { InvalidGrantError } from "./gateway.js";
import type { OAuthGateway } from "./gateway.js";

type GaxiosLike = {
  message?: unknown;
  status?: unknown;
  response?: { status?: unknown; data?: { error?: unknown } };
};

function statusOf(e: GaxiosLike): number {
  const s = e.response?.status ?? e.status;
  return typeof s === "number" ? s : 0;
}

function reasonOf(e: GaxiosLike): string | null {
  const r = e.response?.data?.error;
  return typeof r === "string" ? r : null;
}

function isInvalidGrant(e: GaxiosLike): boolean {
  return (
    reasonOf(e) === "invalid_grant" ||
    (typeof e.message === "string" && e.message.includes("invalid_grant"))
  );
}

/**
 * Never rethrow raw gaxios errors: they carry request config including the
 * client secret. GoogleLibError's safeCause redacts the cause.
 */
function wrap(e: unknown): GoogleApiError {
  const g = (typeof e === "object" && e !== null ? e : {}) as GaxiosLike;
  return new GoogleApiError(statusOf(g), reasonOf(g), { cause: e });
}

/** A fresh client per call: clients are per tenant, never cached. */
export function createGoogleAuthGateway(): OAuthGateway {
  return {
    async exchangeCode(p) {
      const client = new OAuth2Client(
        p.clientId,
        p.clientSecret,
        p.redirectUri,
      );
      let tokens;
      try {
        ({ tokens } = await client.getToken({
          code: p.code,
          codeVerifier: p.codeVerifier,
          redirect_uri: p.redirectUri,
        }));
      } catch (e) {
        throw wrap(e);
      }
      if (!tokens.id_token) throw new Error("Token response had no id_token");
      if (!tokens.access_token)
        throw new Error("Token response had no access_token");
      return {
        refreshToken: tokens.refresh_token ?? null,
        accessToken: tokens.access_token,
        expiresAt: new Date(tokens.expiry_date ?? 0),
        scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
        idToken: tokens.id_token,
      };
    },

    async verifyIdToken(p) {
      const client = new OAuth2Client(p.clientId);
      let payload;
      try {
        const ticket = await client.verifyIdToken({
          idToken: p.idToken,
          audience: p.clientId,
        });
        payload = ticket.getPayload();
      } catch (e) {
        throw wrap(e);
      }
      if (!payload?.email || !payload.sub) {
        throw new Error("ID token is missing email or sub");
      }
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        hd: payload.hd ?? null,
      };
    },

    async refreshAccessToken(p) {
      const client = new OAuth2Client(p.clientId, p.clientSecret);
      client.setCredentials({ refresh_token: p.refreshToken });
      let token: string | null | undefined;
      try {
        ({ token } = await client.getAccessToken());
      } catch (e) {
        const g = (typeof e === "object" && e !== null ? e : {}) as GaxiosLike;
        if (isInvalidGrant(g)) throw new InvalidGrantError();
        throw wrap(e);
      }
      if (!token) throw new Error("Refresh response had no access_token");
      return {
        accessToken: token,
        expiresAt: new Date(client.credentials.expiry_date ?? 0),
      };
    },

    async revokeToken(token) {
      try {
        await new OAuth2Client().revokeToken(token);
      } catch (e) {
        throw wrap(e);
      }
    },
  };
}
