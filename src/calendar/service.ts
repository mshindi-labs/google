import type { GoogleCore } from "../core/create-google.js";
import { internals } from "../core/create-google.js";
import {
  ConnectionRevokedError,
  EventNotFoundError,
  InvalidEventError,
} from "../core/errors.js";
import { assertServiceScopes } from "../core/scopes.js";
import type { ConnectionView } from "../core/types.js";
import {
  CalendarUnauthorizedSignal,
  EventGoneSignal,
  withCalendarRetry,
} from "./retry.js";
import { findCommonSlots } from "./slots.js";
import { createCalendarApiTransport } from "./transport.js";
import type { CalendarTransport } from "./transport.js";
import type { Availability, CalendarEventView, TimeRange } from "./types.js";
import { validateAvailabilityInput } from "./validate.js";
import type {
  AvailabilityInput,
  GetEventInput,
  SuggestSlotsInput,
} from "./validate.js";
import { assertManaged, toView } from "./view.js";

export type CalendarOptions = {
  transport?: CalendarTransport;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type CalendarApi = {
  getAvailability(input: AvailabilityInput): Promise<Availability>;
  suggestSlots(
    input: SuggestSlotsInput,
  ): Promise<{ slots: TimeRange[]; unknownAttendees?: string[] }>;
  getEvent(input: GetEventInput): Promise<CalendarEventView>;
};

type Reason = "not_found" | "no_access" | "error";

const REASONS: Record<string, Reason> = {
  notFound: "not_found",
  forbidden: "no_access",
  noAccess: "no_access",
};

function mergeBusy(raw: { start: string; end: string }[], w: TimeRange) {
  const lo = w.start.getTime();
  const hi = w.end.getTime();
  const spans: [number, number][] = [];
  for (const b of raw) {
    const s = Math.max(Date.parse(b.start), lo);
    const e = Math.min(Date.parse(b.end), hi);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => ({ start: new Date(s), end: new Date(e) }));
}

export function createCalendar(
  google: GoogleCore,
  opts: CalendarOptions = {},
): CalendarApi {
  const transport = opts.transport ?? createCalendarApiTransport();
  const retryOpts = {
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  };
  /** Wrap each transport call so 401 surfaces as CalendarUnauthorizedSignal. */
  const retry = <T>(fn: () => Promise<T>): Promise<T> =>
    withCalendarRetry(fn, retryOpts);

  async function withToken<T>(
    tenantId: string,
    connectionId: string,
    fn: (accessToken: string, connection: ConnectionView) => Promise<T>,
  ): Promise<T> {
    const { store, tokens, emit, now, logger } = google[internals];
    const first = await tokens.getAccessToken(tenantId, connectionId);
    const { refreshToken: _omit, ...view } = first.connection;
    void _omit;
    assertServiceScopes(view.scopes, ["calendar"], { tenantId, connectionId });

    let result: T;
    try {
      result = await fn(first.accessToken, view);
    } catch (err) {
      if (!(err instanceof CalendarUnauthorizedSignal)) throw err;
      const fresh = await tokens.getAccessToken(tenantId, connectionId, {
        forceRefresh: true,
      });
      try {
        result = await fn(fresh.accessToken, view);
      } catch (err2) {
        if (!(err2 instanceof CalendarUnauthorizedSignal)) throw err2;
        await store.updateConnectionStatus(
          tenantId,
          connectionId,
          "revoked",
          "unauthorized",
        );
        tokens.evict(connectionId);
        await emit({
          type: "connection.revoked",
          tenantId,
          connectionId,
          reason: "unauthorized",
          at: now(),
        });
        throw new ConnectionRevokedError("unauthorized", {
          tenantId,
          connectionId,
        });
      }
    }
    try {
      await store.touchConnection(tenantId, connectionId, now());
    } catch {
      try {
        logger?.warn("google touchConnection failed");
      } catch {
        // logging must never break the caller
      }
    }
    return result;
  }

  async function getAvailability(input: AvailabilityInput) {
    return (await availabilityOf(input)).availability;
  }

  async function availabilityOf(input: AvailabilityInput) {
    const { attendees, window } = validateAvailabilityInput(input);
    const { tenantId, connectionId } = input;
    const raw = await withToken(tenantId, connectionId, (accessToken) =>
      retry(() =>
        transport.freeBusy({
          accessToken,
          timeMin: window.start.toISOString(),
          timeMax: window.end.toISOString(),
          emails: attendees,
        }),
      ),
    );
    const byLower = new Map(
      Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const out: Availability = {};
    for (const email of attendees) {
      const cal = byLower.get(email);
      if (cal === undefined) {
        out[email] = { status: "unknown", reason: "error" };
      } else if (cal.errors.length > 0) {
        out[email] = {
          status: "unknown",
          reason: REASONS[cal.errors[0]?.reason ?? ""] ?? "error",
        };
      } else {
        out[email] = { status: "ok", busy: mergeBusy(cal.busy, window) };
      }
    }
    return { availability: out, window };
  }

  return {
    getAvailability,

    async suggestSlots(input) {
      const { availability, window } = await availabilityOf(input);
      const unknownAttendees = Object.entries(availability)
        .filter(([, v]) => v.status === "unknown")
        .map(([k]) => k);
      if (unknownAttendees.length > 0) return { slots: [], unknownAttendees };
      const busy: Record<string, TimeRange[]> = {};
      for (const [email, v] of Object.entries(availability)) {
        if (v.status === "ok") busy[email] = v.busy;
      }
      const slots = findCommonSlots({
        now: google[internals].now(),
        window,
        durationMinutes: input.durationMinutes,
        workingHours: input.workingHours,
        busy,
        ...(input.workingHoursByAttendee !== undefined && {
          workingHoursByAttendee: input.workingHoursByAttendee,
        }),
        ...(input.bufferMinutes !== undefined && {
          bufferMinutes: input.bufferMinutes,
        }),
        ...(input.stepMinutes !== undefined && {
          stepMinutes: input.stepMinutes,
        }),
        ...(input.minNoticeMinutes !== undefined && {
          minNoticeMinutes: input.minNoticeMinutes,
        }),
        ...(input.maxResults !== undefined && { maxResults: input.maxResults }),
      });
      return { slots };
    },

    async getEvent(input) {
      for (const field of ["tenantId", "connectionId", "eventId"] as const) {
        if (typeof input?.[field] !== "string" || input[field] === "") {
          throw new InvalidEventError(field);
        }
      }
      const { tenantId, connectionId, eventId } = input;
      const ev = await withToken(
        tenantId,
        connectionId,
        async (accessToken) => {
          try {
            return await retry(() => transport.get({ accessToken, eventId }));
          } catch (err) {
            if (err instanceof EventGoneSignal) throw new EventNotFoundError();
            throw err;
          }
        },
      );
      assertManaged(ev, tenantId);
      return toView(ev);
    },
  };
}
