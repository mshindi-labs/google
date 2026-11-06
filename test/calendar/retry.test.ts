import { describe, expect, it, vi } from "vitest";
import {
  ConferencingUnavailableError,
  GoogleApiError,
  GoogleLibError,
  RateLimitedError,
} from "../../src/core/errors.js";
import {
  CalendarUnauthorizedSignal,
  DuplicateEventSignal,
  EventGoneSignal,
  PreconditionFailedSignal,
  classifyCalendarError,
  withCalendarRetry,
} from "../../src/calendar/retry.js";

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
const opts = () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  random: () => 1,
});

describe("classifyCalendarError", () => {
  it("passes GoogleLibError through", () => {
    const e = new ConferencingUnavailableError();
    expect(classifyCalendarError(e)).toEqual({ kind: "fail", error: e });
  });

  it.each([
    ["429", http(429), null],
    ["403 rateLimitExceeded", http(403, "rateLimitExceeded"), null],
    ["403 userRateLimitExceeded", http(403, "userRateLimitExceeded"), null],
    [
      "429 retry-after",
      http(429, undefined, { headers: { "retry-after": "2" } }),
      2000,
    ],
    ["500", http(500), null],
    ["503", http(503, "backendError"), null],
    ["ETIMEDOUT", net("ETIMEDOUT"), null],
    ["ECONNRESET", net("ECONNRESET"), null],
    ["ENOTFOUND", net("ENOTFOUND"), null],
    ["EAI_AGAIN", net("EAI_AGAIN"), null],
    ["ECONNREFUSED", net("ECONNREFUSED"), null],
    ["ESOCKETTIMEDOUT", net("ESOCKETTIMEDOUT"), null],
    ["TLS", net("ERR_TLS_CERT_ALTNAME_INVALID"), null],
    ["AbortError", Object.assign(new Error("x"), { name: "AbortError" }), null],
    ["hang up", new Error("socket hang up"), null],
  ])("retries %s", (_n, err, delayMs) => {
    expect(classifyCalendarError(err)).toEqual({ kind: "retry", delayMs });
  });

  it("maps 401, 409, 404, 410, 412", () => {
    expect(classifyCalendarError(http(401))).toEqual({ kind: "unauthorized" });
    expect(classifyCalendarError(http(409))).toEqual({ kind: "duplicate" });
    expect(classifyCalendarError(http(404))).toEqual({ kind: "gone" });
    expect(classifyCalendarError(http(410))).toEqual({ kind: "gone" });
    expect(classifyCalendarError(http(412))).toEqual({ kind: "precondition" });
  });

  it("fails 400 conference as ConferencingUnavailableError", () => {
    const c = classifyCalendarError(
      http(400, "invalid", { message: "Invalid conference type value" }),
    );
    expect(c.kind).toBe("fail");
    if (c.kind === "fail")
      expect(c.error).toBeInstanceOf(ConferencingUnavailableError);
  });

  it("fails other 400 and non-rate 403 as GoogleApiError", () => {
    for (const [err, status, reason] of [
      [http(400, "invalid"), 400, "invalid"],
      [http(403, "forbiddenForNonOrganizer"), 403, "forbiddenForNonOrganizer"],
      [http(403, "dailyLimitExceeded"), 403, "dailyLimitExceeded"],
      [http(418), 418, null],
    ] as const) {
      const c = classifyCalendarError(err);
      expect(c.kind).toBe("fail");
      if (c.kind === "fail") {
        expect(c.error).toBeInstanceOf(GoogleApiError);
        expect((c.error as GoogleApiError).status).toBe(status);
        expect((c.error as GoogleApiError).reason).toBe(reason);
      }
    }
  });

  it("fails unknown errors as GoogleApiError(0, code)", () => {
    const c = classifyCalendarError(net("EWEIRD"));
    expect(c.kind).toBe("fail");
    if (c.kind === "fail") {
      expect((c.error as GoogleApiError).status).toBe(0);
      expect((c.error as GoogleApiError).reason).toBe("EWEIRD");
    }
  });
});

describe("withCalendarRetry", () => {
  it("retries 503 twice then succeeds", async () => {
    const o = opts();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(503))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValue("ok");
    await expect(withCalendarRetry(fn, o)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(o.sleep).toHaveBeenCalledTimes(2);
  });

  it("3x ETIMEDOUT throws GoogleApiError(0, ETIMEDOUT)", async () => {
    const fn = vi.fn().mockRejectedValue(net("ETIMEDOUT"));
    const err: any = await withCalendarRetry(fn, opts()).catch(
      (e: unknown) => e as any,
    );
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(0);
    expect(err.reason).toBe("ETIMEDOUT");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("exhausted 5xx throws GoogleApiError(status, reason)", async () => {
    const err: any = await withCalendarRetry(
      () => Promise.reject(http(503, "backendError")),
      opts(),
    ).catch((e: unknown) => e as any);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(503);
    expect(err.reason).toBe("backendError");
  });

  it("exhausted 429 throws RateLimitedError", async () => {
    const err: any = await withCalendarRetry(
      () => Promise.reject(http(429)),
      opts(),
    ).catch((e: unknown) => e as any);
    expect(err).toBeInstanceOf(RateLimitedError);
  });

  it("Retry-After above the cap throws RateLimitedError without sleeping", async () => {
    const o = opts();
    const fn = vi
      .fn()
      .mockRejectedValue(
        http(429, undefined, { headers: { "retry-after": "30" } }),
      );
    const err: any = await withCalendarRetry(fn, o).catch(
      (e: unknown) => e as any,
    );
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(30000);
    expect(o.sleep).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours a small Retry-After as the sleep", async () => {
    const o = opts();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        http(429, undefined, { headers: { "retry-after": "2" } }),
      )
      .mockResolvedValue(1);
    await withCalendarRetry(fn, o);
    expect(o.sleep).toHaveBeenCalledWith(2000);
  });

  it("rethrows signals without retrying", async () => {
    for (const [status, Sig] of [
      [401, CalendarUnauthorizedSignal],
      [409, DuplicateEventSignal],
      [404, EventGoneSignal],
      [410, EventGoneSignal],
      [412, PreconditionFailedSignal],
    ] as const) {
      const fn = vi.fn().mockRejectedValue(http(status));
      await expect(withCalendarRetry(fn, opts())).rejects.toBeInstanceOf(Sig);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry a 403 forbiddenForNonOrganizer", async () => {
    const fn = vi.fn().mockRejectedValue(http(403, "forbiddenForNonOrganizer"));
    const err: any = await withCalendarRetry(fn, opts()).catch(
      (e: unknown) => e as any,
    );
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(403);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("[RF4] never leaks the bearer token through the thrown error", async () => {
    const secret = Object.assign(new Error("boom"), {
      config: { headers: { Authorization: "Bearer ya29.secret" } },
      response: { status: 503, headers: {}, data: {} },
    });
    const err: any = await withCalendarRetry(
      () => Promise.reject(secret),
      opts(),
    ).catch((e: unknown) => e as any);
    expect(err).toBeInstanceOf(GoogleLibError);
    expect(JSON.stringify(err)).not.toContain("ya29");
    expect(String(err.cause)).not.toContain("ya29");
    expect(JSON.stringify(err.cause)).not.toContain("ya29");
  });
});
