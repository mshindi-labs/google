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
import { createPlaceholderTokenManager } from "./tokens.js";
import type { TokenManager } from "./tokens.js";
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

export type ConnectionsApi = {
  list(tenantId: string): Promise<ConnectionView[]>;
  get(tenantId: string, connectionId: string): Promise<ConnectionView>;
  disconnect(p: {
    tenantId: string;
    connectionId: string;
    actorId: string;
  }): Promise<void>;
};

export const internals: unique symbol = Symbol("mshindi-google.internals");

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

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export function createGoogle(opts: CreateGoogleOptions): GoogleCore {
  assertCallbackUrl(opts.callbackUrl);
  const now = opts.now ?? (() => new Date());
  const emit = createEmitter({
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    store: opts.store,
    ...(opts.logger ? { logger: opts.logger } : {}),
    redactRecipients: opts.redactRecipients ?? false,
  });
  const tokens = createPlaceholderTokenManager();

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
      createAuthUrl: notImplemented,
      handleCallback: notImplemented,
      purgeExpiredStates: notImplemented,
    },
    connections: {
      list: notImplemented,
      get: notImplemented,
      disconnect: notImplemented,
    },
    [internals]: {
      store: opts.store,
      keyProvider: opts.keyProvider,
      emit,
      now,
      callbackUrl: opts.callbackUrl,
      ...(opts.logger ? { logger: opts.logger } : {}),
      gateway: opts.oauthGateway ?? createGoogleAuthGateway(),
      tokens,
    },
  };
}
