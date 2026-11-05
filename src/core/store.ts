import type { EncryptedValue } from "./crypto/envelope.js";
import type { GoogleEvent } from "./events.js";
import type {
  ConnectionRecord,
  ConnectionStatus,
  EncryptedValueRef,
  OAuthClientRecord,
  OAuthStateRecord,
} from "./types.js";

export interface CredentialStore {
  // OAuth clients
  getOAuthClient(tenantId: string): Promise<OAuthClientRecord | null>;
  /**
   * When `revokeConnections` is true, every connection of the tenant must be set to
   * status 'revoked' / statusReason 'client_changed' atomically with the upsert.
   */
  upsertOAuthClient(
    rec: OAuthClientRecord,
    opts: { revokeConnections: boolean },
  ): Promise<void>;

  // Connections
  getConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null>;
  findConnectionBySub(
    tenantId: string,
    googleSub: string,
  ): Promise<ConnectionRecord | null>;
  listConnections(tenantId: string): Promise<ConnectionRecord[]>;
  /** Rejects if another id already holds the same (tenantId, googleSub). */
  upsertConnection(rec: ConnectionRecord): Promise<void>;
  updateConnectionStatus(
    tenantId: string,
    connectionId: string,
    status: ConnectionStatus,
    reason: string,
  ): Promise<void>;
  touchConnection(
    tenantId: string,
    connectionId: string,
    at: Date,
  ): Promise<void>;
  /**
   * Targeted update of `displayName` and `updatedAt` only (never status or
   * refresh token). Returns false when the connection does not exist in the tenant.
   */
  setConnectionDisplayName(
    tenantId: string,
    connectionId: string,
    displayName: string | null,
    at: Date,
  ): Promise<boolean>;
  /**
   * Targeted update: refreshToken = null, status 'revoked', statusReason
   * 'disconnected', updatedAt = at. Returns false when the connection does not
   * exist in the tenant.
   */
  disconnectConnection(
    tenantId: string,
    connectionId: string,
    at: Date,
  ): Promise<boolean>;

  // OAuth state
  insertOAuthState(rec: OAuthStateRecord): Promise<void>;
  /** Atomic: at most one concurrent caller receives the record. `stateHash` is lowercase hex. */
  consumeOAuthState(
    stateHash: string,
    now: Date,
  ): Promise<OAuthStateRecord | null>;
  deleteExpiredOAuthStates(now: Date): Promise<number>;

  // Key rotation
  iterateEncryptedValues(batchSize: number): AsyncIterable<EncryptedValueRef>;
  /**
   * Compare-and-swap: replaces the stored value only if it still equals `ref.value`
   * (and the tenant matches). Returns true if replaced, false otherwise (e.g. a
   * concurrent write changed the field, or the tenant/record does not match).
   */
  replaceEncryptedValue(
    ref: EncryptedValueRef,
    value: EncryptedValue,
  ): Promise<boolean>;

  // Optional audit persistence
  insertAuditEvent?(event: GoogleEvent): Promise<void>;
}
