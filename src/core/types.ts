import type { AadRecord, EncryptedValue } from "./crypto/envelope.js";

export type ConnectionStatus = "active" | "revoked" | "error";

export type OAuthClientRecord = {
  tenantId: string;
  clientId: string;
  clientSecret: EncryptedValue;
  secretHint: string;
  hostedDomain: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
};

export type ConnectionRecord = {
  id: string;
  tenantId: string;
  googleSub: string;
  email: string;
  displayName: string | null;
  scopes: string[];
  refreshToken: EncryptedValue | null;
  status: ConnectionStatus;
  statusReason: string | null;
  connectedBy: string;
  connectedAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

export type ConnectionView = Omit<ConnectionRecord, "refreshToken">;

export type OAuthStateRecord = {
  stateHash: Uint8Array;
  tenantId: string;
  actorId: string;
  intendedEmail: string | null;
  connectionId: string | null;
  scopes: string[];
  codeVerifier: EncryptedValue;
  expiresAt: Date;
};

/** Points at one encrypted field of one stored record (used for key rotation). */
export type EncryptedValueRef = {
  tenantId: string;
  record: AadRecord;
  /** tenantId for oauth_client, connection id for connection, hex stateHash for oauth_state. */
  recordId: string;
  field: string;
  value: EncryptedValue;
};

export interface Logger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
