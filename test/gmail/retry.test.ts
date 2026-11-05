import { describe, expect, it, vi } from "vitest";
import {
  DailyQuotaExceededError,
  GoogleApiError,
  InvalidMessageError,
  RateLimitedError,
  SendOutcomeUnknownError,
} from "../../src/core/errors.js";
import { classifySendError, withSendRetry } from "../../src/gmail/retry.js";

const http = (
  status: number,
  reason?: string,
  extra: { headers?: Record<string, string>; message?: string } = {},
) =>
  Object.assign(new Error(extra.message ?? `http ${status}`), {
    response: {
      status,
      headers: extra.headers ?? {},
      data: {
        error: { errors: reason ? [{ reason }] : [], message: extra.message },
      },
    },
  });
const net = (code: string) => Object.assign(new Error(code), { code });

describe("classifySendError", () => {
  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
  ])("retries pre-send network error %s", (code) => {
    expect(classifySendError(net(code))).toEqual({
      kind: "retry",
      delayMs: null,
    });
  });

  it("reads the network code from err.cause.code", () => {
    const e = Object.assign(new Error("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    expect(classifySendError(e)).toEqual({ kind: "retry", delayMs: null });
  });

  it("retries 429", () => {
    expect(classifySendError(http(429))).toEqual({
      kind: "retry",
      delayMs: null,
    });
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
    "retries 403 %s",
    (r) => {
      expect(classifySendError(http(403, r))).toEqual({
        kind: "retry",
        delayMs: null,
      });
    },
  );

  it("reads reason from err.errors[0].reason and status from err.status", () => {
    const e = Object.assign(new Error("x"), {
      status: 403,
      errors: [{ reason: "rateLimitExceeded" }],
    });
    expect(classifySendError(e).kind).toBe("retry");
  });

  it("reads a numeric err.code as the status", () => {
    expect(
      classifySendError(Object.assign(new Error("x"), { code: 401 })),
    ).toEqual({
      kind: "unauthorized",
    });
  });

  it("parses Retry-After seconds", () => {
    expect(
      classifySendError(
        http(429, undefined, { headers: { "retry-after": "2" } }),
      ),
    ).toEqual({
      kind: "retry",
      delayMs: 2000,
    });
  });

  it("parses Retry-After HTTP dates relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const c = classifySendError(
        http(429, undefined, {
          headers: { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" },
        }),
      );
      expect(c).toEqual({ kind: "retry", delayMs: 5000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails 403 dailyLimitExceeded with DailyQuotaExceededError", () => {
    const c = classifySendError(http(403, "dailyLimitExceeded"));
    expect(c.kind).toBe("fail");
    expect((c as { error: unknown }).error).toBeInstanceOf(
      DailyQuotaExceededError,
    );
  });

  it("fails a sending-limit message with DailyQuotaExceededError", () => {
    const c = classifySendError(
      http(403, "forbidden", { message: "User-rate sending limit exceeded" }),
    );
    expect((c as { error: unknown }).error).toBeInstanceOf(
      DailyQuotaExceededError,
    );
  });

  it("maps 401 to unauthorized", () => {
    expect(classifySendError(http(401))).toEqual({ kind: "unauthorized" });
  });

  it("fails 400 with InvalidMessageError('message')", () => {
    const c = classifySendError(http(400, "invalidArgument"));
    const err = (c as unknown as { error: InvalidMessageError }).error;
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect(err.field).toBe("message");
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "ESOCKETTIMEDOUT"])(
    "%s is outcome-unknown",
    (code) => {
      const c = classifySendError(net(code));
      expect((c as { error: unknown }).error).toBeInstanceOf(
        SendOutcomeUnknownError,
      );
    },
  );

  it("socket hang up and AbortError are outcome-unknown", () => {
    expect(
      (classifySendError(new Error("socket hang up")) as { error: unknown })
        .error,
    ).toBeInstanceOf(SendOutcomeUnknownError);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(
      (classifySendError(abort) as { error: unknown }).error,
    ).toBeInstanceOf(SendOutcomeUnknownError);
  });

  it.each([500, 502, 503])("%i is outcome-unknown", (s) => {
    expect(
      (classifySendError(http(s)) as { error: unknown }).error,
    ).toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("other statuses become GoogleApiError(status, reason)", () => {
    const err = (
      classifySendError(http(404, "notFound")) as unknown as {
        error: GoogleApiError;
      }
    ).error;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(404);
    expect(err.reason).toBe("notFound");
  });
});

describe("withSendRetry", () => {
  const opts = (sleep = vi.fn(async (_ms: number) => {})) => ({
    sleep,
    random: () => 1,
    baseMs: 250,
    capMs: 8000,
  });

  it("returns the result on success", async () => {
    await expect(withSendRetry(async () => 7, opts())).resolves.toBe(7);
  });

  it("retries 429 up to 3 attempts then throws RateLimitedError", async () => {
    const fn = vi.fn(async () => {
      throw http(429, undefined, { headers: { "retry-after": "1" } });
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const err = await withSendRetry(fn, opts(sleep)).catch((e) => e);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(1000);
  });

  it("honors Retry-After: 2 → sleeps 2000ms", async () => {
    let n = 0;
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await withSendRetry(async () => {
      if (n++ === 0)
        throw http(429, undefined, { headers: { "retry-after": "2" } });
      return "ok";
    }, opts(sleep));
    expect(r).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("uses full-jitter exponential backoff without Retry-After", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await withSendRetry(
      async () => {
        throw net("ENOTFOUND");
      },
      { sleep, random: () => 0.5, baseMs: 250, capMs: 8000 },
    ).catch(() => {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([125, 250]);
  });

  it("caps the backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await withSendRetry(
      async () => {
        throw net("ENOTFOUND");
      },
      { sleep, random: () => 1, baseMs: 250, capMs: 300, maxAttempts: 4 },
    ).catch(() => {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 300, 300]);
  });

  it("throws GoogleApiError(0, code) after exhausting pre-send network retries", async () => {
    const fn = vi.fn(async () => {
      throw net("ECONNREFUSED");
    });
    const err = await withSendRetry(fn, opts()).catch((e) => e);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(0);
    expect(err.reason).toBe("ECONNREFUSED");
  });

  it("never retries 5xx or ECONNRESET", async () => {
    for (const e of [http(503), net("ECONNRESET")]) {
      const fn = vi.fn(async () => {
        throw e;
      });
      await expect(withSendRetry(fn, opts())).rejects.toBeInstanceOf(
        SendOutcomeUnknownError,
      );
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("surfaces 401 as an unauthorized signal without retrying", async () => {
    const fn = vi.fn(async () => {
      throw http(401);
    });
    const err = await withSendRetry(fn, opts()).catch((e) => e);
    expect(err.name).toBe("SendUnauthorizedSignal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
