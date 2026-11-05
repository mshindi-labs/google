import { buildAad, encryptValue } from "../crypto/envelope.js";
import {
  ConnectionNotFoundError,
  InvalidConfigError,
  OAuthClientNotConfiguredError,
} from "../errors.js";
import { SERVICE_SCOPES, scopesFor } from "../scopes.js";
import type { GoogleService } from "../scopes.js";
import { AUTH_ENDPOINT } from "./gateway.js";
import { codeChallenge, randomToken, sha256 } from "./pkce.js";
import type { KeyProvider } from "../crypto/key-provider.js";
import type { CredentialStore } from "../store.js";

export const STATE_TTL_MS = 600_000;

export type AuthUrlDeps = {
  store: CredentialStore;
  keyProvider: KeyProvider;
  now: () => Date;
  callbackUrl: string;
};

export type CreateAuthUrlParams = {
  tenantId: string;
  actorId: string;
  services: GoogleService[];
  intendedEmail?: string;
  connectionId?: string;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export async function createAuthUrl(
  deps: AuthUrlDeps,
  p: CreateAuthUrlParams,
): Promise<{ url: string; expiresAt: Date }> {
  if (!p.tenantId) throw new InvalidConfigError("tenantId must be non-empty");
  if (!p.actorId) throw new InvalidConfigError("actorId must be non-empty");
  if (!Array.isArray(p.services) || p.services.length === 0) {
    throw new InvalidConfigError("services must be a non-empty list");
  }
  for (const s of p.services) {
    if (!Object.prototype.hasOwnProperty.call(SERVICE_SCOPES, s)) {
      throw new InvalidConfigError(`Unknown service: ${String(s)}`);
    }
  }

  const client = await deps.store.getOAuthClient(p.tenantId);
  if (!client) {
    throw new OAuthClientNotConfiguredError(undefined, {
      tenantId: p.tenantId,
    });
  }
  if (p.connectionId) {
    const existing = await deps.store.getConnection(p.tenantId, p.connectionId);
    if (!existing) {
      throw new ConnectionNotFoundError(undefined, {
        tenantId: p.tenantId,
        connectionId: p.connectionId,
      });
    }
  }

  const intendedEmail = p.intendedEmail?.trim().toLowerCase() || null;
  const scopes = scopesFor(p.services);
  const state = randomToken();
  const verifier = randomToken();
  const stateHash = sha256(state);
  const codeVerifier = await encryptValue(
    verifier,
    buildAad({
      tenantId: p.tenantId,
      record: "oauth_state",
      recordId: hex(stateHash),
      field: "code_verifier",
    }),
    deps.keyProvider,
  );
  const expiresAt = new Date(deps.now().getTime() + STATE_TTL_MS);

  await deps.store.insertOAuthState({
    stateHash,
    tenantId: p.tenantId,
    actorId: p.actorId,
    intendedEmail,
    connectionId: p.connectionId ?? null,
    scopes,
    codeVerifier,
    expiresAt,
  });

  const url = new URL(AUTH_ENDPOINT);
  const q = url.searchParams;
  q.set("client_id", client.clientId);
  q.set("redirect_uri", deps.callbackUrl);
  q.set("response_type", "code");
  q.set("scope", scopes.join(" "));
  q.set("state", state);
  q.set("access_type", "offline");
  q.set("prompt", "consent");
  q.set("include_granted_scopes", "true");
  q.set("code_challenge", codeChallenge(verifier));
  q.set("code_challenge_method", "S256");
  if (intendedEmail) q.set("login_hint", intendedEmail);
  if (client.hostedDomain) q.set("hd", client.hostedDomain);

  return { url: url.toString(), expiresAt };
}
