import { describe, expect, it } from "vitest";
import {
  ConnectionNotFoundError,
  ConnectionRevokedError,
  CredentialIntegrityError,
  DailyQuotaExceededError,
  GoogleApiError,
  GoogleLibError,
  InvalidConfigError,
  InvalidMessageError,
  InvalidOAuthStateError,
  MessageTooLargeError,
  MissingPeerDependencyError,
  MissingScopeError,
  NoRefreshTokenError,
  OAuthClientNotConfiguredError,
  OAuthConsentDeniedError,
  RateLimitedError,
  SendOutcomeUnknownError,
  UnexpectedAccountError,
  safeCause,
} from "../../src/core/index.js";

describe("errors", () => {
  it("carries code and ids", () => {
    const e = new ConnectionRevokedError("invalid_grant", {
      tenantId: "t1",
      connectionId: "c1",
    });
    expect(e).toBeInstanceOf(GoogleLibError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("connection_revoked");
    expect(e.reason).toBe("invalid_grant");
    expect(e.tenantId).toBe("t1");
    expect(e.connectionId).toBe("c1");
  });

  it("every subclass has the spec code and fields", () => {
    expect(new OAuthClientNotConfiguredError().code).toBe(
      "oauth_client_not_configured",
    );
    expect(new InvalidOAuthStateError().code).toBe("invalid_oauth_state");
    expect(new OAuthConsentDeniedError().code).toBe("oauth_consent_denied");
    expect(new UnexpectedAccountError().code).toBe("unexpected_account");
    expect(new NoRefreshTokenError().code).toBe("no_refresh_token");
    const scope = new MissingScopeError(["gmail.send"]);
    expect(scope.code).toBe("missing_scope");
    expect(scope.required).toEqual(["gmail.send"]);
    expect(new ConnectionNotFoundError().code).toBe("connection_not_found");
    expect(new CredentialIntegrityError().code).toBe("credential_integrity");
    const invalid = new InvalidMessageError("subject");
    expect(invalid.code).toBe("invalid_message");
    expect(invalid.field).toBe("subject");
    const big = new MessageTooLargeError(30, 25);
    expect(big.code).toBe("message_too_large");
    expect([big.bytes, big.limit]).toEqual([30, 25]);
    const rl = new RateLimitedError(1500);
    expect(rl.code).toBe("rate_limited");
    expect(rl.retryAfterMs).toBe(1500);
    expect(new RateLimitedError(null).retryAfterMs).toBeNull();
    expect(new DailyQuotaExceededError().code).toBe("daily_quota_exceeded");
    expect(new SendOutcomeUnknownError().code).toBe("send_outcome_unknown");
    const api = new GoogleApiError(503, "backendError");
    expect(api.code).toBe("google_api");
    expect([api.status, api.reason]).toEqual([503, "backendError"]);
    const peer = new MissingPeerDependencyError("nodemailer");
    expect(peer.code).toBe("missing_peer_dependency");
    expect(peer.peer).toBe("nodemailer");
    expect(peer.message).toContain("npm i nodemailer");
    expect(new InvalidConfigError("bad").code).toBe("invalid_config");
  });

  it("sets name to the class name", () => {
    expect(new InvalidOAuthStateError().name).toBe("InvalidOAuthStateError");
  });

  it("redacts the cause", () => {
    const e = new GoogleApiError(500, null, {
      cause: new Error("bad token ya29.a0AfB_secret"),
    });
    expect(String((e.cause as Error).message)).not.toContain(
      "ya29.a0AfB_secret",
    );
    expect(String((e.cause as Error).stack)).not.toContain("ya29.a0AfB_secret");
  });

  it("safeCause keeps name and code, redacts message", () => {
    const src = Object.assign(new Error("GOCSPX-abc123 leaked"), {
      name: "CustomErr",
      code: "E_X",
    });
    const out = safeCause(src) as Error & { code?: string };
    expect(out.name).toBe("CustomErr");
    expect(out.code).toBe("E_X");
    expect(out.message).not.toContain("GOCSPX-abc123");
  });

  it("safeCause wraps non-Error values", () => {
    const out = safeCause("1//0gSecret-token");
    expect(out).toBeInstanceOf(Error);
    expect(out.message).not.toContain("1//0gSecret-token");
  });
});
