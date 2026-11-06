import { safeCause } from "./redact.js";

export interface GoogleErrorOptions {
  tenantId?: string;
  connectionId?: string;
  cause?: unknown;
}

export class GoogleLibError extends Error {
  readonly code: string;
  readonly tenantId?: string;
  readonly connectionId?: string;

  constructor(code: string, message: string, opts: GoogleErrorOptions = {}) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: safeCause(opts.cause) },
    );
    this.name = new.target.name;
    this.code = code;
    if (opts.tenantId !== undefined) this.tenantId = opts.tenantId;
    if (opts.connectionId !== undefined) this.connectionId = opts.connectionId;
  }
}

export class OAuthClientNotConfiguredError extends GoogleLibError {
  constructor(
    message = "OAuth client is not configured for this tenant",
    opts?: GoogleErrorOptions,
  ) {
    super("oauth_client_not_configured", message, opts);
  }
}

export class InvalidOAuthStateError extends GoogleLibError {
  constructor(
    message = "OAuth state is invalid, expired or already used",
    opts?: GoogleErrorOptions,
  ) {
    super("invalid_oauth_state", message, opts);
  }
}

export class OAuthConsentDeniedError extends GoogleLibError {
  constructor(message = "OAuth consent was denied", opts?: GoogleErrorOptions) {
    super("oauth_consent_denied", message, opts);
  }
}

export class UnexpectedAccountError extends GoogleLibError {
  constructor(
    message = "Authorized Google account does not match the expected account",
    opts?: GoogleErrorOptions,
  ) {
    super("unexpected_account", message, opts);
  }
}

export class NoRefreshTokenError extends GoogleLibError {
  constructor(
    message = "Google did not return a refresh token",
    opts?: GoogleErrorOptions,
  ) {
    super("no_refresh_token", message, opts);
  }
}

export class MissingScopeError extends GoogleLibError {
  readonly required: string[];
  constructor(required: string[], message?: string, opts?: GoogleErrorOptions) {
    super(
      "missing_scope",
      message ?? `Missing required scopes: ${required.join(", ")}`,
      opts,
    );
    this.required = required;
  }
}

export class ConnectionNotFoundError extends GoogleLibError {
  constructor(message = "Connection not found", opts?: GoogleErrorOptions) {
    super("connection_not_found", message, opts);
  }
}

export class ConnectionRevokedError extends GoogleLibError {
  readonly reason: string;
  constructor(reason: string, opts?: GoogleErrorOptions) {
    super("connection_revoked", `Connection revoked: ${reason}`, opts);
    this.reason = reason;
  }
}

export class CredentialIntegrityError extends GoogleLibError {
  constructor(
    message = "Stored credential failed integrity verification",
    opts?: GoogleErrorOptions,
  ) {
    super("credential_integrity", message, opts);
  }
}

export class KeyProviderUnavailableError extends GoogleLibError {
  constructor(
    message = "Key provider is temporarily unavailable",
    opts?: GoogleErrorOptions,
  ) {
    super("key_provider_unavailable", message, opts);
  }
}

export class InvalidMessageError extends GoogleLibError {
  readonly field: string;
  constructor(field: string, message?: string, opts?: GoogleErrorOptions) {
    super(
      "invalid_message",
      message ?? `Invalid message field: ${field}`,
      opts,
    );
    this.field = field;
  }
}

export class MessageTooLargeError extends GoogleLibError {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number, opts?: GoogleErrorOptions) {
    super(
      "message_too_large",
      `Message is ${bytes} bytes; the limit is ${limit}`,
      opts,
    );
    this.bytes = bytes;
    this.limit = limit;
  }
}

export class RateLimitedError extends GoogleLibError {
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null, opts?: GoogleErrorOptions) {
    super("rate_limited", "Google rate limit hit", opts);
    this.retryAfterMs = retryAfterMs;
  }
}

export class DailyQuotaExceededError extends GoogleLibError {
  constructor(
    message = "Daily sending quota exceeded",
    opts?: GoogleErrorOptions,
  ) {
    super("daily_quota_exceeded", message, opts);
  }
}

export class SendOutcomeUnknownError extends GoogleLibError {
  constructor(
    message = "Send outcome is unknown; the message may or may not have been delivered",
    opts?: GoogleErrorOptions,
  ) {
    super("send_outcome_unknown", message, opts);
  }
}

export class GoogleApiError extends GoogleLibError {
  readonly status: number;
  readonly reason: string | null;
  constructor(
    status: number,
    reason: string | null,
    opts?: GoogleErrorOptions,
  ) {
    super(
      "google_api",
      `Google API error ${status}${reason ? `: ${reason}` : ""}`,
      opts,
    );
    this.status = status;
    this.reason = reason;
  }
}

export class MissingPeerDependencyError extends GoogleLibError {
  readonly peer: string;
  constructor(peer: string, opts?: GoogleErrorOptions) {
    super(
      "missing_peer_dependency",
      `Optional dependency "${peer}" is required for this feature. Install it with: npm i ${peer}`,
      opts,
    );
    this.peer = peer;
  }
}

export class InvalidConfigError extends GoogleLibError {
  constructor(message: string, opts?: GoogleErrorOptions) {
    super("invalid_config", message, opts);
  }
}

export class InvalidEventError extends GoogleLibError {
  readonly field: string;
  constructor(field: string, message?: string, opts?: GoogleErrorOptions) {
    super(
      "invalid_event",
      message ?? `Invalid event field: ${JSON.stringify(field).slice(0, 64)}`,
      opts,
    );
    this.field = field;
  }
}

export class EventNotFoundError extends GoogleLibError {
  constructor(message = "Event not found", opts?: GoogleErrorOptions) {
    super("event_not_found", message, opts);
  }
}

export class EventNotManagedError extends GoogleLibError {
  constructor(
    message = "Event is not managed by this library",
    opts?: GoogleErrorOptions,
  ) {
    super("event_not_managed", message, opts);
  }
}

export class EventCancelledError extends GoogleLibError {
  constructor(message = "Event is cancelled", opts?: GoogleErrorOptions) {
    super("event_cancelled", message, opts);
  }
}

export class EventConflictError extends GoogleLibError {
  constructor(
    message = "Event was modified concurrently",
    opts?: GoogleErrorOptions,
  ) {
    super("event_conflict", message, opts);
  }
}

export class ConferencingUnavailableError extends GoogleLibError {
  constructor(
    message = "Google Meet conferencing is unavailable for this calendar",
    opts?: GoogleErrorOptions,
  ) {
    super("conferencing_unavailable", message, opts);
  }
}
