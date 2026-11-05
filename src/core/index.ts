// Public surface of @mshindi-labs/google/core. Keep this list explicit: anything
// not named here is internal. Test helpers live in /testing only.
export * from "./errors.js";

export { createGoogle } from "./create-google.js";
export type {
  CreateGoogleOptions,
  GoogleCore,
  OAuthApi,
} from "./create-google.js";
export type { ClientsApi } from "./clients.js";
export type { ConnectionsApi } from "./connections.js";

export { StaticKeyProvider } from "./crypto/static-key-provider.js";
export { GcpKmsKeyProvider } from "./crypto/gcp-kms.js";
export type { GcpKmsClientLike } from "./crypto/gcp-kms.js";
export { AwsKmsKeyProvider } from "./crypto/aws-kms.js";
export type { AwsKmsClientLike, AwsKmsCommands } from "./crypto/aws-kms.js";
export type { KeyProvider } from "./crypto/key-provider.js";
export type { AadRecord, EncryptedValue } from "./crypto/envelope.js";

export { rewrapAll, verifyAll } from "./ops.js";
export type { OpsFailure } from "./ops.js";

export { BASE_SCOPES, SERVICE_SCOPES, scopesFor } from "./scopes.js";
export type { GoogleService } from "./scopes.js";

export type { CredentialStore } from "./store.js";
export type {
  ConnectionRecord,
  ConnectionStatus,
  ConnectionView,
  EncryptedValueRef,
  Logger,
  OAuthClientRecord,
  OAuthStateRecord,
} from "./types.js";
export type { GoogleEvent } from "./events.js";

// For custom OAuthGateway implementers (the default gateway is built in).
export { InvalidGrantError } from "./oauth/gateway.js";
export type { OAuthGateway } from "./oauth/gateway.js";
