import {
  DailyQuotaExceededError,
  GoogleApiError,
  GoogleLibError,
  InvalidMessageError,
  RateLimitedError,
  SendOutcomeUnknownError,
} from "../core/errors.js";

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

type ErrLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  errors?: { reason?: unknown }[];
  cause?: { code?: unknown } | null;
  response?: {
    status?: unknown;
    headers?: Record<string, unknown>;
    data?: { error?: { message?: unknown; errors?: { reason?: unknown }[] } };
  };
};

const PRE_SEND_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);
const OUTCOME_UNKNOWN_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

const asErr = (err: unknown): ErrLike =>
  typeof err === "object" && err !== null ? (err as ErrLike) : {};

function readStatus(e: ErrLike): number | null {
  const s = e.response?.status ?? e.status ?? e.code;
  return typeof s === "number" ? s : null;
}

function readReason(e: ErrLike): string | null {
  const r =
    e.response?.data?.error?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  return typeof r === "string" ? r : null;
}

function readNetCode(e: ErrLike): string | null {
  const c = e.code ?? e.cause?.code;
  return typeof c === "string" ? c : null;
}

function readMessages(e: ErrLike): string {
  const a = typeof e.message === "string" ? e.message : "";
  const b = e.response?.data?.error?.message;
  return `${a} ${typeof b === "string" ? b : ""}`;
}

function readRetryAfterMs(e: ErrLike): number | null {
  const raw = e.response?.headers?.["retry-after"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

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
  return {
    kind: "fail",
    error: new GoogleApiError(status ?? 0, reason ?? code, opts),
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
