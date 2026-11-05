import { buildAad, decryptValue } from "./crypto/envelope.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import {
  ConnectionNotFoundError,
  ConnectionRevokedError,
  OAuthClientNotConfiguredError,
} from "./errors.js";
import type { Emit } from "./events.js";
import { InvalidGrantError } from "./oauth/gateway.js";
import type { OAuthGateway } from "./oauth/gateway.js";
import type { CredentialStore } from "./store.js";
import type { ConnectionRecord, Logger } from "./types.js";

export type TokenManager = {
  getAccessToken(
    tenantId: string,
    connectionId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<{ accessToken: string; connection: ConnectionRecord }>;
  prime(
    tenantId: string,
    connectionId: string,
    accessToken: string,
    expiresAt: Date,
  ): void;
  evict(connectionId: string): void;
  evictTenant(tenantId: string): void;
};

const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

type Entry = {
  tenantId: string;
  connectionId: string;
  accessToken: string;
  expiresAt: Date;
};

type Flight = {
  tenantId: string;
  connectionId: string;
  promise: Promise<string>;
  /** Set by evict/evictTenant: the result must not be cached. */
  cancelled: boolean;
};

const keyOf = (tenantId: string, connectionId: string): string =>
  `${tenantId}:${connectionId}`;

export function createTokenManager(deps: {
  store: CredentialStore;
  keyProvider: KeyProvider;
  gateway: OAuthGateway;
  emit: Emit;
  now: () => Date;
  maxEntries?: number;
  logger?: Logger;
}): TokenManager {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, Entry>();
  const flights = new Map<string, Flight>();

  const remember = (e: Entry): void => {
    const k = keyOf(e.tenantId, e.connectionId);
    cache.delete(k);
    cache.set(k, e);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  const evictWhere = (
    match: (e: { tenantId: string; connectionId: string }) => boolean,
  ): void => {
    for (const [k, e] of cache) if (match(e)) cache.delete(k);
    for (const f of flights.values()) if (match(f)) f.cancelled = true;
  };

  const refresh = async (
    tenantId: string,
    connectionId: string,
    connection: ConnectionRecord,
    flight: () => Flight,
  ): Promise<string> => {
    const client = await deps.store.getOAuthClient(tenantId);
    if (!client) {
      throw new OAuthClientNotConfiguredError(undefined, {
        tenantId,
        connectionId,
      });
    }
    if (!connection.refreshToken) {
      throw new ConnectionRevokedError("disconnected", {
        tenantId,
        connectionId,
      });
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
    const refreshToken = await decryptValue(
      connection.refreshToken,
      buildAad({
        tenantId,
        record: "connection",
        recordId: connection.id,
        field: "refresh_token",
      }),
      deps.keyProvider,
    );
    let result: { accessToken: string; expiresAt: Date };
    try {
      result = await deps.gateway.refreshAccessToken({
        clientId: client.clientId,
        clientSecret,
        refreshToken,
      });
    } catch (err) {
      if (!(err instanceof InvalidGrantError)) throw err;
      await deps.store.updateConnectionStatus(
        tenantId,
        connectionId,
        "revoked",
        "invalid_grant",
      );
      evictWhere(
        (e) => e.tenantId === tenantId && e.connectionId === connectionId,
      );
      await deps.emit({
        type: "connection.revoked",
        tenantId,
        connectionId,
        reason: "invalid_grant",
        at: deps.now(),
      });
      throw new ConnectionRevokedError("invalid_grant", {
        tenantId,
        connectionId,
      });
    }
    if (!flight().cancelled) {
      remember({
        tenantId,
        connectionId,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
      });
    }
    try {
      await deps.store.touchConnection(tenantId, connectionId, deps.now());
    } catch {
      // best-effort: the caller still gets the token
      try {
        deps.logger?.warn("google touchConnection failed");
      } catch {
        // logging must never break the caller
      }
    }
    return result.accessToken;
  };

  return {
    async getAccessToken(tenantId, connectionId, opts) {
      const connection = await deps.store.getConnection(tenantId, connectionId);
      if (!connection) {
        throw new ConnectionNotFoundError(undefined, {
          tenantId,
          connectionId,
        });
      }
      if (connection.status !== "active") {
        throw new ConnectionRevokedError(connection.statusReason ?? "revoked", {
          tenantId,
          connectionId,
        });
      }

      const key = keyOf(tenantId, connectionId);
      const hit = cache.get(key);
      if (
        hit &&
        hit.tenantId === tenantId &&
        !opts?.forceRefresh &&
        hit.expiresAt.getTime() - deps.now().getTime() > EXPIRY_SKEW_MS
      ) {
        cache.delete(key);
        cache.set(key, hit);
        return { accessToken: hit.accessToken, connection };
      }

      // forceRefresh deliberately joins an in-flight refresh: its token is freshly minted.
      let flight = flights.get(key);
      if (!flight) {
        const created: Flight = {
          tenantId,
          connectionId,
          cancelled: false,
          promise: Promise.resolve(""),
        };
        created.promise = refresh(
          tenantId,
          connectionId,
          connection,
          () => created,
        ).finally(() => {
          if (flights.get(key) === created) flights.delete(key);
        });
        flights.set(key, created);
        flight = created;
      }
      return { accessToken: await flight.promise, connection };
    },

    prime(tenantId, connectionId, accessToken, expiresAt) {
      remember({ tenantId, connectionId, accessToken, expiresAt });
    },

    evict(connectionId) {
      evictWhere((e) => e.connectionId === connectionId);
    },

    evictTenant(tenantId) {
      evictWhere((e) => e.tenantId === tenantId);
    },
  };
}
