import { randomUUID } from "node:crypto";
import type { GoogleCore } from "../core/create-google.js";
import { internals } from "../core/create-google.js";
import {
  ConferencingUnavailableError,
  ConnectionRevokedError,
  EventCancelledError,
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
import {
  validateAvailabilityInput,
  validateChanges,
  validateCreateInput,
} from "./validate.js";
import type {
  AvailabilityInput,
  CancelEventInput,
  CreateEventInput,
  GetEventInput,
  NormalizedEvent,
  SuggestSlotsInput,
  UpdateEventInput,
} from "./validate.js";
import { assertManaged, toNormalized, toView } from "./view.js";

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
  updateEvent(input: UpdateEventInput): Promise<CalendarEventView>;
  cancelEvent(input: CancelEventInput): Promise<void>;
};

const GOOGLE_SEND_UPDATES: Record<SendUpdates, GoogleSendUpdates> = {
  all: "all",
  external_only: "externalOnly",
  none: "none",
};

/** D§5.3.1 step 2: total ~10 s of polling for a `pending` conference. */
const CONFERENCE_POLL_MS = [500, 1000, 2000, 3000, 3500] as const;
const RELEASE_ATTEMPTS = 3;
const PATCH_ATTEMPTS = 3;
const MAX_EVENT_MS = 24 * 3_600_000;
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

const storedFingerprint = (e: GEvent): string | undefined =>
  e.extendedProperties?.private?.mshindiFingerprint;

/** Throws before any token fetch, so bad input emits nothing (as createEvent). */
function requireIds(
  input: Record<string, unknown> | undefined,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const v = input?.[field];
    if (typeof v !== "string" || v === "") throw new InvalidEventError(field);
  }
}

function parseSendUpdates(v: unknown): GoogleSendUpdates {
  if (v === undefined) return "all";
  if (
    typeof v !== "string" ||
    !Object.prototype.hasOwnProperty.call(GOOGLE_SEND_UPDATES, v)
  ) {
    throw new InvalidEventError("sendUpdates");
  }
  return GOOGLE_SEND_UPDATES[v as SendUpdates];
}

type Attendee = NormalizedEvent["attendees"][number];
const attendeeKey = (as: Attendee[]): string =>
  JSON.stringify(
    as
      .map((a) => [a.email.toLowerCase(), a.optional, a.displayName] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
  );

const SAME: {
  [K in keyof NormalizedEvent]: (
    a: NormalizedEvent[K],
    b: NormalizedEvent[K],
  ) => boolean;
} = {
  title: (a, b) => a === b,
  description: (a, b) => a === b,
  start: (a, b) => a.getTime() === b.getTime(),
  end: (a, b) => a.getTime() === b.getTime(),
  timeZone: (a, b) => a === b,
  attendees: (a, b) => attendeeKey(a) === attendeeKey(b),
  meeting: (a, b) =>
    a.type === b.type &&
    (a.type !== "in_person" ||
      a.location === (b as { location: string }).location),
  guestsCanSeeOtherGuests: (a, b) => a === b,
};

/** Sorted keys of `changes` whose value differs from `current`. */
function changedKeys(
  current: NormalizedEvent,
  changes: Partial<NormalizedEvent>,
): (keyof NormalizedEvent)[] {
  return (Object.keys(changes) as (keyof NormalizedEvent)[])
    .filter(
      (k) =>
        !(SAME[k] as (a: unknown, b: unknown) => boolean)(
          current[k],
          changes[k],
        ),
    )
    .sort();
}

/**
 * D§5.4: only the changed Google fields plus the new fingerprint. Attendees are
 * the full desired list; kept guests carry their current RSVP, the organizer's
 * own entry is preserved.
 */
function updatePatch(
  current: GEvent,
  next: NormalizedEvent,
  changed: (keyof NormalizedEvent)[],
  fp: string,
): { patch: Partial<GEvent>; conferenceDataVersion: 0 | 1 } {
  const p: Record<string, unknown> = {};
  const has = (k: keyof NormalizedEvent) => changed.includes(k);
  let conferenceDataVersion: 0 | 1 = 0;
  if (has("title")) p.summary = next.title;
  if (has("description")) p.description = next.description;
  if (has("start") || has("end") || has("timeZone")) {
    p.start = { dateTime: next.start.toISOString(), timeZone: next.timeZone };
    p.end = { dateTime: next.end.toISOString(), timeZone: next.timeZone };
  }
  if (has("attendees")) {
    const all = current.attendees ?? [];
    const rsvp = new Map(
      all.flatMap((a) =>
        a.email && a.responseStatus
          ? [[a.email.toLowerCase(), a.responseStatus] as const]
          : [],
      ),
    );
    p.attendees = [
      ...all.filter((a) => a.organizer === true || a.self === true),
      ...next.attendees.map((a) => {
        const status = rsvp.get(a.email.toLowerCase());
        return {
          email: a.email,
          ...(a.displayName !== null && { displayName: a.displayName }),
          optional: a.optional,
          ...(status !== undefined && { responseStatus: status }),
        };
      }),
    ];
  }
  if (has("meeting")) {
    const wasMeet = toNormalized(current).meeting.type === "google_meet";
    if (next.meeting.type === "google_meet") {
      if (!wasMeet) {
        p.conferenceData = {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
        p.location = null;
        conferenceDataVersion = 1;
      }
    } else {
      p.location = next.meeting.location;
      if (wasMeet) {
        p.conferenceData = null;
        conferenceDataVersion = 1;
      }
    }
  }
  if (has("guestsCanSeeOtherGuests")) {
    p.guestsCanSeeOtherGuests = next.guestsCanSeeOtherGuests;
  }
  p.extendedProperties = { private: { mshindiFingerprint: fp } };
  return { patch: p as Partial<GEvent>, conferenceDataVersion };
}

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

/** I1: only sanitized GoogleLibErrors leave the calendar service. */
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

  const warn = (message: string): void => {
    try {
      google[internals].logger?.warn(message);
    } catch {
      // logging must never break the caller
    }
  };

  const getManaged = async (
    accessToken: string,
    eventId: string,
    tenantId: string,
  ): Promise<GEvent> => {
    let e: GEvent;
    try {
      e = await retry(() => transport.get({ accessToken, eventId }));
    } catch (err) {
      if (err instanceof EventGoneSignal) throw new EventNotFoundError();
      throw err;
    }
    assertManaged(e, tenantId);
    return e;
  };

  /** D§5.3.1 step 2: poll a `pending` conference for up to ~10 s. */
  async function pollConference(
    accessToken: string,
    eventId: string,
    from: GEvent,
  ): Promise<GEvent> {
    let event = from;
    for (const ms of CONFERENCE_POLL_MS) {
      if (meetReady(event) || conferenceStatus(event) !== "pending") break;
      await sleep(ms);
      event = await retry(() => transport.get({ accessToken, eventId }));
    }
    return event;
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
      let event = await pollConference(accessToken, eventId, inserted);
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

  async function updateEvent(
    input: UpdateEventInput,
  ): Promise<CalendarEventView> {
    requireIds(input as Record<string, unknown> | undefined, [
      "tenantId",
      "connectionId",
      "actorId",
      "eventId",
    ]);
    // Fail fast on bad input; re-validated against the real organizer below.
    validateChanges(input.changes, "");
    const sendUpdates = parseSendUpdates(input.sendUpdates);
    const { tenantId, connectionId, actorId, eventId } = input;
    const { emit, now } = google[internals];

    // Call-scoped: if a 401 re-run finds our own patch already applied, it is
    // still our update (one updated event, with the first attempt's `changed`).
    let attempted: { fp: string; changed: string[] } | null = null;

    try {
      const out = await withToken(
        tenantId,
        connectionId,
        async (accessToken, connection) => {
          const changes = validateChanges(input.changes, connection.email);
          const current = await getManaged(accessToken, eventId, tenantId);
          if (current.status === "cancelled") throw new EventCancelledError();

          const before = toNormalized(current);
          const next: NormalizedEvent = { ...before, ...changes };
          const span = next.end.getTime() - next.start.getTime();
          if (span <= 0 || span > MAX_EVENT_MS)
            throw new InvalidEventError("end");
          const fp = fingerprint(next);
          const changed = changedKeys(before, changes);

          if (fp === storedFingerprint(current) || changed.length === 0) {
            if (attempted?.fp === fp) {
              return { event: current, next, changed: attempted.changed };
            }
            return { event: current, next, changed: null };
          }

          const body = updatePatch(current, next, changed, fp);
          attempted = { fp, changed };
          let event = await patchVerified(accessToken, body, fp);
          if (
            next.meeting.type === "google_meet" &&
            before.meeting.type !== "google_meet"
          ) {
            event = await pollConference(accessToken, eventId, event);
            if (!meetReady(event)) {
              // Guests were already notified by the patch; a link-less Meet event
              // is better than a second round of notifications from a rollback.
              warn(
                "google calendar: Meet link could not be created while updating an event",
              );
            }
          }
          return { event, next, changed };
        },
      );

      if (out.changed !== null) {
        await emit({
          type: "calendar_event.updated",
          tenantId,
          actorId,
          connectionId,
          eventId,
          attendees: out.next.attendees.map((a) => a.email),
          title: out.next.title,
          start: out.next.start,
          end: out.next.end,
          changed: out.changed,
          at: now(),
        });
      }
      return toView(out.event);
    } catch (err) {
      throw await failed(err, "update", { tenantId, actorId, connectionId });
    }

    /**
     * No `If-Match` (D§5.4: RSVPs change the etag). Verify-then-retry: after a
     * retryable failure, a `get` showing our fingerprint means it landed.
     */
    async function patchVerified(
      accessToken: string,
      body: ReturnType<typeof updatePatch>,
      fp: string,
    ): Promise<GEvent> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await transport.patch({
            accessToken,
            eventId,
            patch: body.patch,
            sendUpdates,
            conferenceDataVersion: body.conferenceDataVersion,
          });
        } catch (err) {
          const c = classifyCalendarError(err);
          if (c.kind !== "retry") return rethrow(err);
          const current = await getManaged(accessToken, eventId, tenantId);
          if (storedFingerprint(current) === fp) return current;
          if (current.status === "cancelled") throw new EventCancelledError();
          const tooLong = c.delayMs !== null && c.delayMs > BACKOFF_CAP_MS;
          if (attempt + 1 >= PATCH_ATTEMPTS || tooLong) return rethrow(err);
          await sleep(
            c.delayMs ??
              random() *
                Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt),
          );
        }
      }
    }
  }

  async function cancelEvent(input: CancelEventInput): Promise<void> {
    requireIds(input as Record<string, unknown> | undefined, [
      "tenantId",
      "connectionId",
      "actorId",
      "eventId",
    ]);
    const sendUpdates = parseSendUpdates(input.sendUpdates);
    const { tenantId, connectionId, actorId, eventId } = input;
    const { emit, now } = google[internals];

    // Call-scoped: an ambiguous delete of ours may have landed, so a later
    // "gone" / "cancelled" (also after a 401 re-run) is our own cancellation.
    let ownDeleteMayHaveLanded = false;

    try {
      const cancelled = await withToken(
        tenantId,
        connectionId,
        async (accessToken) => {
          const current = await getManaged(accessToken, eventId, tenantId);
          if (current.status === "cancelled") {
            return ownDeleteMayHaveLanded ? current : null;
          }
          try {
            await retry(async () => {
              try {
                await transport.delete({ accessToken, eventId, sendUpdates });
              } catch (err) {
                const status = readStatus(asErr(err));
                if (
                  classifyCalendarError(err).kind === "retry" &&
                  status !== 429 &&
                  status !== 403
                ) {
                  ownDeleteMayHaveLanded = true;
                }
                throw err;
              }
            });
          } catch (err) {
            if (!(err instanceof EventGoneSignal)) throw err;
            // Gone without an ambiguous attempt of ours: cancelled elsewhere.
            if (!ownDeleteMayHaveLanded) return null;
          }
          return current;
        },
      );

      if (cancelled !== null) {
        const ev = toNormalized(cancelled);
        await emit({
          type: "calendar_event.cancelled",
          tenantId,
          actorId,
          connectionId,
          eventId,
          attendees: ev.attendees.map((a) => a.email),
          title: ev.title,
          start: ev.start,
          end: ev.end,
          at: now(),
        });
      }
    } catch (err) {
      throw await failed(err, "cancel", { tenantId, actorId, connectionId });
    }
  }

  /** Emits `calendar_event.failed` (errorCode only) and returns the sanitized error. */
  async function failed(
    err: unknown,
    operation: "update" | "cancel",
    ids: { tenantId: string; actorId: string; connectionId: string },
  ): Promise<GoogleLibError> {
    const safe = sanitize(err);
    const { emit, now } = google[internals];
    await emit({
      type: "calendar_event.failed",
      ...ids,
      operation,
      errorCode: safe.code,
      at: now(),
    });
    return safe;
  }

  return {
    getAvailability,
    createEvent,
    updateEvent,
    cancelEvent,

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
