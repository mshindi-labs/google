import {
  CredentialIntegrityError,
  KeyProviderUnavailableError,
} from "../errors.js";

const NET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
// gRPC: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, UNAVAILABLE.
const GRPC_CODES = new Set([4, 8, 14]);

/** True for transport/availability failures (retryable), false otherwise. */
export function isKmsAvailabilityError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof e.code === "string" && NET_CODES.has(e.code)) return true;
  if (typeof e.code === "number" && GRPC_CODES.has(e.code)) return true;
  if (e.name === "ThrottlingException" || e.name === "TimeoutError") {
    return true;
  }
  const status = e.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

/** Maps a KMS client failure to the library error; the cause is redacted. */
export function mapKmsError(err: unknown): Error {
  return isKmsAvailabilityError(err)
    ? new KeyProviderUnavailableError(undefined, { cause: err })
    : new CredentialIntegrityError(undefined, { cause: err });
}
