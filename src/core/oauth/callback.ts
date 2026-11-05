import { randomUUID } from "node:crypto";
import { buildAad, decryptValue, encryptValue } from "../crypto/envelope.js";
import type { KeyProvider } from "../crypto/key-provider.js";
import {
  InvalidOAuthStateError,
  NoRefreshTokenError,
  OAuthClientNotConfiguredError,
  OAuthConsentDeniedError,
  UnexpectedAccountError,
} from "../errors.js";
import type { Emit } from "../events.js";
import { SERVICE_SCOPES, assertServiceScopes } from "../scopes.js";
import type { GoogleService } from "../scopes.js";
import type { CredentialStore } from "../store.js";
import type { TokenManager } from "../tokens.js";
import type { ConnectionRecord, ConnectionView, Logger } from "../types.js";
import type { OAuthGateway } from "./gateway.js";
import { sha256 } from "./pkce.js";

export type CallbackDeps = {
  store: CredentialStore;
  keyProvider: KeyProvider;
  emit: Emit;
  now: () => Date;
  callbackUrl: string;
  gateway: OAuthGateway;
  tokens: TokenManager;
  logger?: Logger;
};

export type CallbackResult = {
  connection: ConnectionView;
  tenantId: string;
  actorId: string;
  created: boolean;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const servicesOf = (scopes: string[]): GoogleService[] =>
  (Object.keys(SERVICE_SCOPES) as GoogleService[]).filter((s) =>
    SERVICE_SCOPES[s].every((scope) => scopes.includes(scope)),
  );

function toView(rec: ConnectionRecord): ConnectionView {
  const { refreshToken: _omit, ...view } = rec;
  return view;
}

export async function handleCallback(
  deps: CallbackDeps,
  p: { code?: string; state?: string; error?: string },
): Promise<CallbackResult> {
  // 1. Consume the state first, whatever else is wrong with the callback.
  if (typeof p.state !== "string" || p.state.length === 0) {
    throw new InvalidOAuthStateError();
  }
  const stateHash = hex(sha256(p.state));
  const state = await deps.store.consumeOAuthState(stateHash, deps.now());
  if (!state) throw new InvalidOAuthStateError();
  const { tenantId, actorId } = state;

  // 2. Consent denied / malformed callback.
  if (p.error) throw new OAuthConsentDeniedError(undefined, { tenantId });
  if (typeof p.code !== "string" || p.code.length === 0) {
    throw new InvalidOAuthStateError(undefined, { tenantId });
  }

  // 3. Client comes from the state's tenant, never from input.
  const client = await deps.store.getOAuthClient(tenantId);
  if (!client) {
    throw new OAuthClientNotConfiguredError(undefined, { tenantId });
  }
  const clientSecret = await decryptValue(
    client.clientSecret,
    buildAad({
      tenantId,
      record: "oauth_client",
      recordId: tenantId,
      field: "client_secret",
    }),
    deps.keyProvider,
  );
  const codeVerifier = await decryptValue(
    state.codeVerifier,
    buildAad({
      tenantId,
      record: "oauth_state",
      recordId: stateHash,
      field: "code_verifier",
    }),
    deps.keyProvider,
  );

  // 4. Exchange the code.
  const tokens = await deps.gateway.exchangeCode({
    clientId: client.clientId,
    clientSecret,
    code: p.code,
    codeVerifier,
    redirectUri: deps.callbackUrl,
  });

  // Every rejection from here on revokes the freshly issued token first.
  const issued = tokens.refreshToken ?? tokens.accessToken;
  const reject = async (err: Error): Promise<never> => {
    try {
      await deps.gateway.revokeToken(issued);
    } catch {
      try {
        deps.logger?.warn("google token revoke failed");
      } catch {
        // logging must never mask the real error
      }
    }
    throw err;
  };

  // 5. Verify the ID token.
  let id: Awaited<ReturnType<OAuthGateway["verifyIdToken"]>>;
  try {
    id = await deps.gateway.verifyIdToken({
      idToken: tokens.idToken,
      clientId: client.clientId,
    });
  } catch (err) {
    return reject(err as Error);
  }
  const email = id.email.trim().toLowerCase();
  if (id.emailVerified !== true) {
    return reject(new UnexpectedAccountError(undefined, { tenantId }));
  }

  // 6. Hosted domain.
  if (
    client.hostedDomain &&
    (id.hd ?? "").trim().toLowerCase() !== client.hostedDomain.toLowerCase()
  ) {
    return reject(new UnexpectedAccountError(undefined, { tenantId }));
  }

  // 7. Intended account.
  if (state.intendedEmail && email !== state.intendedEmail) {
    return reject(new UnexpectedAccountError(undefined, { tenantId }));
  }
  let existing: ConnectionRecord | null;
  if (state.connectionId) {
    existing = await deps.store.getConnection(tenantId, state.connectionId);
    if (!existing || existing.googleSub !== id.sub) {
      return reject(
        new UnexpectedAccountError(undefined, {
          tenantId,
          connectionId: state.connectionId,
        }),
      );
    }
  } else {
    existing = await deps.store.findConnectionBySub(tenantId, id.sub);
  }

  // 8. Granted service scopes (base scopes and the userinfo.email alias are ignored).
  try {
    assertServiceScopes(tokens.scopes, servicesOf(state.scopes), { tenantId });
  } catch (err) {
    return reject(err as Error);
  }

  // 9. Refresh token.
  if (!tokens.refreshToken) {
    return reject(new NoRefreshTokenError(undefined, { tenantId }));
  }

  // 10. Upsert by (tenantId, googleSub).
  const at = deps.now();
  const connectionId = existing?.id ?? randomUUID();
  const refreshToken = await encryptValue(
    tokens.refreshToken,
    buildAad({
      tenantId,
      record: "connection",
      recordId: connectionId,
      field: "refresh_token",
    }),
    deps.keyProvider,
  );
  const scopes = [...new Set([...(existing?.scopes ?? []), ...tokens.scopes])];
  const rec: ConnectionRecord = {
    id: connectionId,
    tenantId,
    googleSub: id.sub,
    email,
    displayName: existing?.displayName ?? null,
    scopes,
    refreshToken,
    status: "active",
    statusReason: null,
    connectedBy: existing?.connectedBy ?? actorId,
    connectedAt: existing?.connectedAt ?? at,
    updatedAt: at,
    lastUsedAt: existing?.lastUsedAt ?? null,
  };
  await deps.store.upsertConnection(rec);
  deps.tokens.prime(
    tenantId,
    connectionId,
    tokens.accessToken,
    tokens.expiresAt,
  );

  // 11. Event.
  await deps.emit({
    type: existing ? "connection.scopes_added" : "connection.created",
    tenantId,
    actorId,
    connectionId,
    email,
    scopes,
    at,
  });

  return {
    connection: toView(rec),
    tenantId,
    actorId,
    created: !existing,
  };
}
