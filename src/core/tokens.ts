import type { ConnectionRecord } from "./types.js";

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

/** Placeholder until the real token manager lands (Task 9). */
export function createPlaceholderTokenManager(): TokenManager {
  return {
    getAccessToken: () => Promise.reject(new Error("not implemented")),
    prime: () => {},
    evict: () => {},
    evictTenant: () => {},
  };
}
