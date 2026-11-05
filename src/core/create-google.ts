import { createAuthUrl } from "./oauth/auth-url.js";
import { handleCallback } from "./oauth/callback.js";
import { createGoogleAuthGateway } from "./oauth/google-gateway.js";
import type { OAuthGateway } from "./oauth/gateway.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import { InvalidConfigError } from "./errors.js";
import { createEmitter } from "./events.js";
import type { Emit, GoogleEvent } from "./events.js";
import { createClientsApi } from "./clients.js";
import type { ClientsApi } from "./clients.js";
import type { GoogleService } from "./scopes.js";
import type { CredentialStore } from "./store.js";
import { createTokenManager } from "./tokens.js";
import type { TokenManager } from "./tokens.js";
import { createConnectionsApi } from "./connections.js";
import type { ConnectionsApi } from "./connections.js";
import type { ConnectionView, Logger } from "./types.js";

export type CreateGoogleOptions = {
  store: CredentialStore;
  keyProvider: KeyProvider;
  callbackUrl: string;
  onEvent?: (e: GoogleEvent) => void | Promise<void>;
  logger?: Logger;
  redactRecipients?: boolean;
  oauthGateway?: OAuthGateway;
  now?: () => Date;
};

export type OAuthApi = {
  createAuthUrl(p: {
    tenantId: string;
    actorId: string;
    services: GoogleService[];
    intendedEmail?: string;
    connectionId?: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  handleCallback(p: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<{
    connection: ConnectionView;
    tenantId: string;
    actorId: string;
    created: boolean;
  }>;
  purgeExpiredStates(): Promise<number>;
};

export const internals: unique symbol = Symbol.for("mshindi-google.internals");

export type Internals = {
  store: CredentialStore;
  keyProvider: KeyProvider;
  emit: Emit;
  now: () => Date;
  callbackUrl: string;
  logger?: Logger;
  gateway: OAuthGateway;
  tokens: TokenManager;
};

export type GoogleCore = {
  clients: ClientsApi;
  oauth: OAuthApi;
  connections: ConnectionsApi;
  [internals]: Internals;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function assertCallbackUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InvalidConfigError("callbackUrl must be a valid URL");
  }
  const ok =
    u.protocol === "https:" ||
    (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname));
  if (!ok) {
    throw new InvalidConfigError(
      "callbackUrl must use https (http is allowed only for localhost, 127.0.0.1 and [::1])",
    );
  }
}

export function createGoogle(opts: CreateGoogleOptions): GoogleCore {
  assertCallbackUrl(opts.callbackUrl);
  const now = opts.now ?? (() => new Date());
  const emit = createEmitter({
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    store: opts.store,
    ...(opts.logger ? { logger: opts.logger } : {}),
    redactRecipients: opts.redactRecipients ?? false,
  });
  const gateway = opts.oauthGateway ?? createGoogleAuthGateway();
  const tokens = createTokenManager({
    store: opts.store,
    keyProvider: opts.keyProvider,
    gateway,
    emit,
    now,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const clients = createClientsApi({
    store: opts.store,
    keyProvider: opts.keyProvider,
    emit,
    now,
    tokens: () => tokens,
  });

  return {
    clients,
    oauth: {
      createAuthUrl: (p) =>
        createAuthUrl(
          {
            store: opts.store,
            keyProvider: opts.keyProvider,
            now,
            callbackUrl: opts.callbackUrl,
          },
          p,
        ),
      handleCallback: (p) =>
        handleCallback(
          {
            store: opts.store,
            keyProvider: opts.keyProvider,
            emit,
            now,
            callbackUrl: opts.callbackUrl,
            gateway,
            tokens,
            ...(opts.logger ? { logger: opts.logger } : {}),
          },
          p,
        ),
      purgeExpiredStates: () => opts.store.deleteExpiredOAuthStates(now()),
    },
    connections: createConnectionsApi({
      store: opts.store,
      keyProvider: opts.keyProvider,
      gateway,
      tokens,
      emit,
      now,
      ...(opts.logger ? { logger: opts.logger } : {}),
    }),
    [internals]: {
      store: opts.store,
      keyProvider: opts.keyProvider,
      emit,
      now,
      callbackUrl: opts.callbackUrl,
      ...(opts.logger ? { logger: opts.logger } : {}),
      gateway,
      tokens,
    },
  };
}
