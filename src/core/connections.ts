import { buildAad, decryptValue } from "./crypto/envelope.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import { ConnectionNotFoundError } from "./errors.js";
import type { Emit } from "./events.js";
import type { OAuthGateway } from "./oauth/gateway.js";
import type { CredentialStore } from "./store.js";
import type { TokenManager } from "./tokens.js";
import type { ConnectionRecord, ConnectionView, Logger } from "./types.js";

export type ConnectionsApi = {
  list(tenantId: string): Promise<ConnectionView[]>;
  get(tenantId: string, connectionId: string): Promise<ConnectionView>;
  disconnect(p: {
    tenantId: string;
    connectionId: string;
    actorId: string;
  }): Promise<void>;
  setDisplayName(p: {
    tenantId: string;
    connectionId: string;
    displayName: string | null;
  }): Promise<ConnectionView>;
};

const MAX_DISPLAY_NAME = 100;

function toView(rec: ConnectionRecord): ConnectionView {
  const { refreshToken: _omit, ...view } = rec;
  return view;
}

/** Strips C0/C1 control characters, trims, caps at 100 chars; empty becomes null. */
export function sanitizeDisplayName(v: string | null): string | null {
  if (v === null) return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return Array.from(s).slice(0, MAX_DISPLAY_NAME).join("").trim() || null;
}

export function createConnectionsApi(deps: {
  store: CredentialStore;
  keyProvider: KeyProvider;
  gateway: OAuthGateway;
  tokens: TokenManager;
  emit: Emit;
  now: () => Date;
  logger?: Logger;
}): ConnectionsApi {
  const load = async (
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord> => {
    const rec = await deps.store.getConnection(tenantId, connectionId);
    if (!rec) {
      throw new ConnectionNotFoundError(undefined, { tenantId, connectionId });
    }
    return rec;
  };

  const warn = (msg: string): void => {
    try {
      deps.logger?.warn(msg);
    } catch {
      // logging must never break the caller
    }
  };

  return {
    async list(tenantId) {
      return (await deps.store.listConnections(tenantId)).map(toView);
    },

    async get(tenantId, connectionId) {
      return toView(await load(tenantId, connectionId));
    },

    async disconnect({ tenantId, connectionId, actorId }) {
      const rec = await load(tenantId, connectionId);
      let googleRevoke: "ok" | "failed" = "ok";
      if (rec.refreshToken) {
        try {
          const token = await decryptValue(
            rec.refreshToken,
            buildAad({
              tenantId,
              record: "connection",
              recordId: rec.id,
              field: "refresh_token",
            }),
            deps.keyProvider,
          );
          await deps.gateway.revokeToken(token);
        } catch {
          googleRevoke = "failed";
          warn("google token revoke failed");
        }
      }
      const at = deps.now();
      await deps.store.upsertConnection({
        ...rec,
        refreshToken: null,
        status: "revoked",
        statusReason: "disconnected",
        updatedAt: at,
      });
      deps.tokens.evict(connectionId);
      await deps.emit({
        type: "connection.disconnected",
        tenantId,
        actorId,
        connectionId,
        googleRevoke,
        at,
      });
    },

    async setDisplayName({ tenantId, connectionId, displayName }) {
      const rec = await load(tenantId, connectionId);
      const updated: ConnectionRecord = {
        ...rec,
        displayName: sanitizeDisplayName(displayName),
        updatedAt: deps.now(),
      };
      await deps.store.upsertConnection(updated);
      return toView(updated);
    },
  };
}
