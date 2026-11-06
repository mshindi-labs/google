import {
  DailyQuotaExceededError,
  GoogleApiError,
  GoogleLibError,
  InvalidMessageError,
  RateLimitedError,
  SendOutcomeUnknownError,
} from "../core/errors.js";
import {
  asErr,
  readMessages,
  readNetCode,
  readReason,
  readRetryAfterMs,
  readStatus,
} from "../core/google-http.js";

export type SendErrorClass =
  | { kind: "retry"; delayMs: number | null }
  | { kind: "unauthorized" }
  | { kind: "fail"; error: GoogleLibError };

/** Thrown by `withSendRetry` when Google answered 401; `send` refreshes and retries once. */
export class SendUnauthorizedSignal extends Error {
  constructor() {
    super("Google rejected the access token (401)");
    this.name = "SendUnauthorizedSignal";
  }
}

const PRE_SEND_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);
const OUTCOME_UNKNOWN_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export function classifySendError(err: unknown): SendErrorClass {
  if (err instanceof GoogleLibError) return { kind: "fail", error: err };
  const e = asErr(err);
  const status = readStatus(e);
  const reason = readReason(e);
  const code = readNetCode(e);
  const opts = { cause: err };

  if (
    reason === "dailyLimitExceeded" ||
    /sending limit/i.test(readMessages(e))
  ) {
    return {
      kind: "fail",
      error: new DailyQuotaExceededError(undefined, opts),
    };
  }
  if (
    status === 429 ||
    (status === 403 && reason !== null && RATE_REASONS.has(reason))
  ) {
    return { kind: "retry", delayMs: readRetryAfterMs(e) };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 400) {
    return {
      kind: "fail",
      error: new InvalidMessageError("message", undefined, opts),
    };
  }
  if (status !== null && status >= 500) {
    return {
      kind: "fail",
      error: new SendOutcomeUnknownError(undefined, opts),
    };
  }
  if (
    code !== null &&
    (PRE_SEND_CODES.has(code) ||
      code.startsWith("ERR_TLS_") ||
      code.startsWith("CERT_"))
  ) {
    return { kind: "retry", delayMs: null };
  }
  if (
    (code !== null && OUTCOME_UNKNOWN_CODES.has(code)) ||
    code === "ABORT_ERR" ||
    e.name === "AbortError" ||
    /socket hang up/i.test(readMessages(e))
  ) {
    return {
      kind: "fail",
      error: new SendOutcomeUnknownError(undefined, opts),
    };
  }
  if (status !== null) {
    return { kind: "fail", error: new GoogleApiError(status, reason, opts) };
  }
  // No HTTP status and not provably pre-send: the request may have been written (I7).
  return {
    kind: "fail",
    error: new SendOutcomeUnknownError(undefined, opts),
  };
}

export type RetryOptions = {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying only errors that provably never reached Google's send
 * (pre-write network failures, rate limits). Anything ambiguous is not retried (I7).
 * 401 surfaces as `SendUnauthorizedSignal`.
 */
export async function withSendRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 250;
  const capMs = opts.capMs ?? 8000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const c = classifySendError(err);
      if (c.kind === "fail") throw c.error;
      if (c.kind === "unauthorized") throw new SendUnauthorizedSignal();
      if (c.delayMs !== null && c.delayMs > capMs) {
        throw new RateLimitedError(c.delayMs, { cause: err });
      }
      if (attempt + 1 >= maxAttempts) {
        const e = asErr(err);
        if (readStatus(e) !== null) {
          throw new RateLimitedError(c.delayMs, { cause: err });
        }
        throw new GoogleApiError(0, readNetCode(e), { cause: err });
      }
      await sleep(
        c.delayMs ?? random() * Math.min(capMs, baseMs * 2 ** attempt),
      );
    }
  }
}
