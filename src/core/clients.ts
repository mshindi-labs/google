import { buildAad, encryptValue } from "./crypto/envelope.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import { InvalidConfigError } from "./errors.js";
import type { Emit } from "./events.js";
import type { CredentialStore } from "./store.js";
import type { TokenManager } from "./tokens.js";
import type { OAuthClientRecord } from "./types.js";

export type ClientsApi = {
  configure(p: {
    tenantId: string;
    actorId: string;
    clientId: string;
    clientSecret: string;
    hostedDomain?: string | null;
  }): Promise<void>;
  get(tenantId: string): Promise<{
    clientId: string;
    secretHint: string;
    hostedDomain: string | null;
    updatedAt: Date;
  } | null>;
};

const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;

const nonEmpty = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.length === 0) {
    throw new InvalidConfigError(`${name} must be a non-empty string`);
  }
  return v;
};

export function createClientsApi(deps: {
  store: CredentialStore;
  keyProvider: KeyProvider;
  emit: Emit;
  now: () => Date;
  tokens: () => TokenManager;
}): ClientsApi {
  return {
    async configure(p) {
      const tenantId = nonEmpty(p.tenantId, "tenantId");
      const actorId = nonEmpty(p.actorId, "actorId");
      if (typeof p.clientId !== "string" || !CLIENT_ID.test(p.clientId)) {
        throw new InvalidConfigError(
          "clientId must look like <id>.apps.googleusercontent.com",
        );
      }
      if (
        typeof p.clientSecret !== "string" ||
        p.clientSecret.length === 0 ||
        /\s/.test(p.clientSecret)
      ) {
        throw new InvalidConfigError(
          "clientSecret must be non-empty and contain no whitespace",
        );
      }
      const hostedDomain = p.hostedDomain?.trim().toLowerCase() || null;

      const existing = await deps.store.getOAuthClient(tenantId);
      const clientIdChanged =
        existing !== null && existing.clientId !== p.clientId;
      const at = deps.now();
      const rec: OAuthClientRecord = {
        tenantId,
        clientId: p.clientId,
        clientSecret: await encryptValue(
          p.clientSecret,
          buildAad({
            tenantId,
            record: "oauth_client",
            recordId: tenantId,
            field: "client_secret",
          }),
          deps.keyProvider,
        ),
        secretHint: p.clientSecret.slice(-4),
        hostedDomain,
        createdBy: existing?.createdBy ?? actorId,
        createdAt: existing?.createdAt ?? at,
        updatedBy: actorId,
        updatedAt: at,
      };
      await deps.store.upsertOAuthClient(rec, {
        revokeConnections: clientIdChanged,
      });
      if (clientIdChanged) deps.tokens().evictTenant(tenantId);
      await deps.emit({
        type: existing ? "oauth_client.rotated" : "oauth_client.configured",
        tenantId,
        actorId,
        clientIdChanged,
        at,
      });
    },

    async get(tenantId) {
      const r = await deps.store.getOAuthClient(tenantId);
      if (!r) return null;
      return {
        clientId: r.clientId,
        secretHint: r.secretHint,
        hostedDomain: r.hostedDomain,
        updatedAt: r.updatedAt,
      };
    },
  };
}
