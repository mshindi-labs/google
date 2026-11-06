import { randomUUID } from "node:crypto";
import type { GoogleCore } from "../core/create-google.js";
import { internals } from "../core/create-google.js";
import {
  ConferencingUnavailableError,
  ConnectionRevokedError,
  EventConflictError,
  EventNotFoundError,
  GoogleApiError,
  GoogleLibError,
  InvalidEventError,
} from "../core/errors.js";
import { asErr, readStatus } from "../core/google-http.js";
import { assertServiceScopes } from "../core/scopes.js";
import type { ConnectionView } from "../core/types.js";
import { deriveEventId, fingerprint } from "./ids.js";
import {
  CalendarUnauthorizedSignal,
  classifyCalendarError,
  DuplicateEventSignal,
  EventGoneSignal,
  PreconditionFailedSignal,
  withCalendarRetry,
} from "./retry.js";
import { findCommonSlots } from "./slots.js";
import { createCalendarApiTransport } from "./transport.js";
import type {
  CalendarTransport,
  GEvent,
  GoogleSendUpdates,
} from "./transport.js";
import type {
  Availability,
  CalendarEventView,
  SendUpdates,
  TimeRange,
} from "./types.js";
import { validateAvailabilityInput, validateCreateInput } from "./validate.js";
import type {
  AvailabilityInput,
  CreateEventInput,
  GetEventInput,
  NormalizedEvent,
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
  createEvent(
    input: CreateEventInput,
  ): Promise<CalendarEventView & { created: boolean }>;
};

const GOOGLE_SEND_UPDATES: Record<SendUpdates, GoogleSendUpdates> = {
  all: "all",
  external_only: "externalOnly",
  none: "none",
};

/** D§5.3.1 step 2: total ~10 s of polling for a `pending` conference. */
const CONFERENCE_POLL_MS = [500, 1000, 2000, 3000, 3500] as const;
const RELEASE_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 8000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const conferenceStatus = (e: GEvent): string | undefined =>
  e.conferenceData?.createRequest?.status?.statusCode;

/** A Meet event is only usable once Google reports success AND a video link exists. */
const meetReady = (e: GEvent): boolean =>
  conferenceStatus(e) === "success" &&
  (e.conferenceData?.entryPoints ?? []).some(
    (p) => p.entryPointType === "video" && typeof p.uri === "string",
  );

const inviteState = (e: GEvent): string | undefined =>
  e.extendedProperties?.private?.mshindiInvite;

function eventBody(
  id: string,
  ev: NormalizedEvent,
  stamp: { tenantId: string; key: string; fingerprint: string },
): GEvent {
  const meet = ev.meeting.type === "google_meet";
  return {
    id,
    summary: ev.title,
    ...(ev.description !== null && { description: ev.description }),
    start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
    end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
    attendees: ev.attendees.map((a) => ({
      email: a.email,
      ...(a.displayName !== null && { displayName: a.displayName }),
      optional: a.optional,
    })),
    ...(ev.meeting.type === "in_person" && { location: ev.meeting.location }),
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: ev.guestsCanSeeOtherGuests,
    ...(meet && {
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
    extendedProperties: {
      private: {
        mshindiGoogle: "v1",
        mshindiTenant: stamp.tenantId,
        mshindiKey: stamp.key,
        mshindiFingerprint: stamp.fingerprint,
        mshindiInvite: meet ? "pending" : "sent",
      },
    },
  };
}

/** I1: only sanitized GoogleLibErrors leave createEvent. */
function sanitize(err: unknown): GoogleLibError {
  if (err instanceof GoogleLibError) return err;
  if (err instanceof EventGoneSignal) return new EventNotFoundError();
  if (
    err instanceof DuplicateEventSignal ||
    err instanceof PreconditionFailedSignal
  ) {
    return new EventConflictError();
  }
  return new GoogleApiError(0, null, { cause: err });
}

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
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  /** Rejects with exactly the signal / sanitized error withCalendarRetry would give. */
  const rethrow = (err: unknown): Promise<never> =>
    withCalendarRetry<never>(() => Promise.reject(err), {
      ...retryOpts,
      maxAttempts: 1,
    });

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

  async function createEvent(
    input: CreateEventInput,
  ): Promise<CalendarEventView & { created: boolean }> {
    for (const field of ["tenantId", "connectionId", "actorId"] as const) {
      if (typeof input?.[field] !== "string" || input[field] === "") {
        throw new InvalidEventError(field);
      }
    }
    // Fail fast on bad input (no token fetch, no event), as Gmail's send does.
    // Re-validated below against the real organizer to drop their own address.
    validateCreateInput(input, "");
    const { tenantId, connectionId, actorId } = input;
    const { emit, now, logger } = google[internals];

    // Call-scoped (not per withToken attempt): a 401 re-run must still know
    // that an insert of ours may already have landed.
    let ownInsertMayHaveLanded = false;
    let released = false;

    try {
      const { event, created, ev } = await withToken(
        tenantId,
        connectionId,
        async (accessToken, connection) => {
          const ev = validateCreateInput(input, connection.email);
          const id = deriveEventId(
            tenantId,
            connection.email,
            ev.idempotencyKey,
          );
          const fp = fingerprint(ev);
          const meet = ev.meeting.type === "google_meet";
          const body = eventBody(id, ev, {
            tenantId,
            key: ev.idempotencyKey,
            fingerprint: fp,
          });
          const sendUpdates = GOOGLE_SEND_UPDATES[ev.sendUpdates];
          const getEv = () =>
            retry(() => transport.get({ accessToken, eventId: id }));

          // Step 1: insert with the deterministic id (I8).
          let event: GEvent;
          let created: boolean;
          try {
            event = await retry(async () => {
              try {
                const out = await transport.insert({
                  accessToken,
                  event: body,
                  sendUpdates: meet ? "none" : sendUpdates,
                  conferenceDataVersion: meet ? 1 : 0,
                });
                ownInsertMayHaveLanded = true;
                return out;
              } catch (err) {
                // An ambiguous (network / 5xx) failure may have created the event;
                // a rate-limit rejection never does.
                const status = readStatus(asErr(err));
                if (
                  classifyCalendarError(err).kind === "retry" &&
                  status !== 429 &&
                  status !== 403
                ) {
                  ownInsertMayHaveLanded = true;
                }
                throw err;
              }
            });
            created = true;
          } catch (err) {
            if (!(err instanceof DuplicateEventSignal)) throw err;
            created = ownInsertMayHaveLanded;
            try {
              event = await getEv();
            } catch (err2) {
              if (err2 instanceof EventGoneSignal) {
                throw new EventConflictError(
                  "An event with this idempotency key exists but cannot be read",
                );
              }
              throw err2;
            }
            assertReplayable(event, tenantId, ev.idempotencyKey, fp);
          }

          if (meet && inviteState(event) === "pending") {
            const conf = await confirmConference(accessToken, id, event);
            if (conf.releasedElsewhere) {
              // A concurrent same-key call released the invites while we were
              // withdrawing: its success is ours, reported as a replay.
              event = conf.event;
              created = false;
            } else {
              const rel = await releaseInvites(
                accessToken,
                id,
                sendUpdates,
                conf.event,
              );
              event = rel.event;
              released = rel.byUs;
            }
          } else if (created && !meet) {
            // In person: our insert itself sent the invites. (A Meet event that is
            // already "sent" here was released by another call, never by an insert.)
            released = true;
          }
          return { event, created, ev };
        },
      );

      if (released) {
        await emit({
          type: "calendar_event.created",
          tenantId,
          actorId,
          connectionId,
          eventId: event.id,
          attendees: ev.attendees.map((a) => a.email),
          title: ev.title,
          start: ev.start,
          end: ev.end,
          at: now(),
        });
      }
      return { ...toView(event), created };
    } catch (err) {
      const safe = sanitize(err);
      await emit({
        type: "calendar_event.failed",
        tenantId,
        actorId,
        connectionId,
        operation: "create",
        errorCode: safe.code,
        at: now(),
      });
      throw safe;
    }

    function assertReplayable(
      e: GEvent,
      tenant: string,
      key: string,
      fp: string,
    ): void {
      const priv = e.extendedProperties?.private;
      if (
        priv?.mshindiGoogle !== "v1" ||
        priv.mshindiTenant !== tenant ||
        priv.mshindiKey !== key
      ) {
        throw new EventConflictError(
          "An event with this id exists and is not owned by this idempotency key",
        );
      }
      if (e.status === "cancelled") {
        throw new EventConflictError(
          "The event for this idempotency key was cancelled; use a new idempotency key",
        );
      }
      if (priv.mshindiFingerprint !== fp) {
        throw new EventConflictError(
          "An event with this idempotency key exists with different details; use updateEvent to change it",
        );
      }
    }

    /**
     * D§5.3.1 step 2: wait for the Meet link; on failure withdraw silently. The
     * withdrawal is guarded by the etag of the last observed pending event, so it
     * cannot cancel an event a concurrent same-key call has just released.
     */
    async function confirmConference(
      accessToken: string,
      eventId: string,
      inserted: GEvent,
    ): Promise<{ event: GEvent; releasedElsewhere: boolean }> {
      const getEv = () => retry(() => transport.get({ accessToken, eventId }));
      let event = inserted;
      for (const ms of CONFERENCE_POLL_MS) {
        if (meetReady(event) || conferenceStatus(event) !== "pending") break;
        await sleep(ms);
        event = await getEv();
      }
      if (meetReady(event)) return { event, releasedElsewhere: false };
      try {
        for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
          try {
            await retry(() =>
              transport.delete({
                accessToken,
                eventId,
                sendUpdates: "none",
                ...(event.etag !== undefined && { ifMatch: event.etag }),
              }),
            );
            break;
          } catch (err) {
            if (!(err instanceof PreconditionFailedSignal)) throw err;
            const current = await getEv();
            if (current.status === "cancelled") break;
            if (inviteState(current) === "sent") {
              return { event: current, releasedElsewhere: true };
            }
            // Changed but still pending: the link may have arrived meanwhile.
            if (meetReady(current)) {
              return { event: current, releasedElsewhere: false };
            }
            event = current;
            if (attempt + 1 >= RELEASE_ATTEMPTS) throw err;
          }
        }
      } catch {
        try {
          logger?.warn(
            "google calendar: could not withdraw event after Meet creation failed",
          );
        } catch {
          // logging must never break the caller
        }
      }
      throw new ConferencingUnavailableError(
        "Google Meet link could not be created; the event was withdrawn without " +
          "notifying guests. Retry with a new idempotency key.",
        { tenantId, connectionId },
      );
    }

    /**
     * D§5.3.1 step 3. Guarded by `If-Match` (etag of the last observed pending
     * event) so two concurrent same-key calls cannot both release the invites,
     * and verify-then-retry so a lost response never causes a second patch.
     * `byUs` is false when another call released them.
     */
    async function releaseInvites(
      accessToken: string,
      eventId: string,
      sendUpdates: GoogleSendUpdates,
      observed: GEvent,
    ): Promise<{ event: GEvent; byUs: boolean }> {
      if (inviteState(observed) === "sent") {
        return { event: observed, byUs: false };
      }
      let etag = observed.etag;
      for (let attempt = 0; ; attempt++) {
        try {
          const event = await transport.patch({
            accessToken,
            eventId,
            patch: {
              extendedProperties: { private: { mshindiInvite: "sent" } },
            },
            sendUpdates,
            conferenceDataVersion: 1,
            ...(etag !== undefined && { ifMatch: etag }),
          });
          return { event, byUs: true };
        } catch (err) {
          const c = classifyCalendarError(err);
          if (c.kind !== "retry" && c.kind !== "precondition") {
            return rethrow(err);
          }
          const current = await retry(() =>
            transport.get({ accessToken, eventId }),
          );
          if (inviteState(current) === "sent") {
            // 412: someone else's patch landed. Retryable: most likely ours.
            return { event: current, byUs: c.kind === "retry" };
          }
          if (current.status === "cancelled") {
            throw new EventConflictError(
              "The event for this idempotency key was cancelled; use a new idempotency key",
            );
          }
          etag = current.etag;
          const tooLong =
            c.kind === "retry" &&
            c.delayMs !== null &&
            c.delayMs > BACKOFF_CAP_MS;
          if (attempt + 1 >= RELEASE_ATTEMPTS || tooLong) return rethrow(err);
          if (c.kind === "retry") {
            await sleep(
              c.delayMs ??
                random() *
                  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt),
            );
          }
        }
      }
    }
  }

  return {
    getAvailability,
    createEvent,

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
