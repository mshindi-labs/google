import {
  ConferencingUnavailableError,
  GoogleApiError,
  GoogleLibError,
  RateLimitedError,
} from "../core/errors.js";
import {
  asErr,
  readMessages,
  readNetCode,
  readReason,
  readRetryAfterMs,
  readStatus,
} from "../core/google-http.js";
import type { RetryOptions } from "../gmail/retry.js";

export type { RetryOptions };

export type CalendarErrorClass =
  | { kind: "retry"; delayMs: number | null }
  | { kind: "unauthorized" }
  | { kind: "duplicate" }
  | { kind: "gone" }
  | { kind: "fail"; error: GoogleLibError };

/** Thrown by `withCalendarRetry` when Google answered 401; the caller refreshes and retries once. */
export class CalendarUnauthorizedSignal extends Error {
  constructor() {
    super("Google rejected the access token (401)");
    this.name = "CalendarUnauthorizedSignal";
  }
}

/** Thrown by `withCalendarRetry` when Google answered 409 (event id already exists). */
export class DuplicateEventSignal extends Error {
  constructor() {
    super("Event already exists (409)");
    this.name = "DuplicateEventSignal";
  }
}

/** Thrown by `withCalendarRetry` when Google answered 404 or 410. */
export class EventGoneSignal extends Error {
  constructor() {
    super("Event not found or deleted (404/410)");
    this.name = "EventGoneSignal";
  }
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export function classifyCalendarError(err: unknown): CalendarErrorClass {
  if (err instanceof GoogleLibError) return { kind: "fail", error: err };
  const e = asErr(err);
  const status = readStatus(e);
  const reason = readReason(e);
  const code = readNetCode(e);
  const opts = { cause: err };

  if (
    status === 429 ||
    (status === 403 && reason !== null && RATE_REASONS.has(reason))
  ) {
    return { kind: "retry", delayMs: readRetryAfterMs(e) };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 409) return { kind: "duplicate" };
  if (status === 404 || status === 410) return { kind: "gone" };
  if (status === 400) {
    if (/conference/i.test(readMessages(e))) {
      return {
        kind: "fail",
        error: new ConferencingUnavailableError(undefined, opts),
      };
    }
    return { kind: "fail", error: new GoogleApiError(400, reason, opts) };
  }
  if (status !== null && status >= 500) return { kind: "retry", delayMs: null };
  if (
    (code !== null &&
      (NETWORK_CODES.has(code) ||
        code.startsWith("ERR_TLS_") ||
        code.startsWith("CERT_") ||
        code === "ABORT_ERR")) ||
    e.name === "AbortError" ||
    /socket hang up/i.test(readMessages(e))
  ) {
    return { kind: "retry", delayMs: null };
  }
  if (status !== null) {
    return { kind: "fail", error: new GoogleApiError(status, reason, opts) };
  }
  return { kind: "fail", error: new GoogleApiError(0, code, opts) };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying rate limits, 5xx and network failures. Unlike Gmail's send
 * (I7), this deliberately retries ambiguous failures: callers only wrap idempotent
 * calls. 401/409/404/410 surface as internal signals; everything else as sanitized
 * `GoogleLibError`s.
 */
export async function withCalendarRetry<T>(
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
      const c = classifyCalendarError(err);
      if (c.kind === "fail") throw c.error;
      if (c.kind === "unauthorized") throw new CalendarUnauthorizedSignal();
      if (c.kind === "duplicate") throw new DuplicateEventSignal();
      if (c.kind === "gone") throw new EventGoneSignal();
      if (c.delayMs !== null && c.delayMs > capMs) {
        throw new RateLimitedError(c.delayMs, { cause: err });
      }
      if (attempt + 1 >= maxAttempts) {
        const e = asErr(err);
        const status = readStatus(e);
        if (status === 429 || status === 403) {
          throw new RateLimitedError(c.delayMs, { cause: err });
        }
        if (status !== null) {
          throw new GoogleApiError(status, readReason(e), { cause: err });
        }
        throw new GoogleApiError(0, readNetCode(e), { cause: err });
      }
      await sleep(
        c.delayMs ?? random() * Math.min(capMs, baseMs * 2 ** attempt),
      );
    }
  }
}
