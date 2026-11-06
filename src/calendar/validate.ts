import { normalizeEmail } from "../core/address.js";
import { InvalidEventError } from "../core/errors.js";
import { assertTimeZone } from "./time.js";
import type {
  AttendeeInput,
  Meeting,
  SendUpdates,
  TimeRange,
  WorkingHours,
} from "./types.js";

type Identity = { tenantId: string; connectionId: string; actorId: string };

export type CreateEventInput = Identity & {
  idempotencyKey: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  timeZone: string;
  attendees: AttendeeInput[];
  meeting: Meeting;
  guestsCanSeeOtherGuests?: boolean;
  sendUpdates?: SendUpdates;
};

export type EventChanges = {
  start?: Date;
  end?: Date;
  timeZone?: string;
  title?: string;
  description?: string | null;
  attendees?: AttendeeInput[];
  meeting?: Meeting;
  guestsCanSeeOtherGuests?: boolean;
};

export type UpdateEventInput = Identity & {
  eventId: string;
  changes: EventChanges;
  sendUpdates?: SendUpdates;
};

export type CancelEventInput = Identity & {
  eventId: string;
  sendUpdates?: SendUpdates;
};

export type GetEventInput = {
  tenantId: string;
  connectionId: string;
  eventId: string;
};

export type AvailabilityInput = Identity & {
  attendees: string[];
  window: TimeRange;
};

export type SuggestSlotsInput = AvailabilityInput & {
  durationMinutes: number;
  workingHours: WorkingHours;
  workingHoursByAttendee?: Record<string, WorkingHours>;
  bufferMinutes?: number;
  stepMinutes?: number;
  minNoticeMinutes?: number;
  maxResults?: number;
};

export type NormalizedEvent = {
  title: string;
  description: string | null;
  start: Date;
  end: Date;
  timeZone: string;
  attendees: { email: string; displayName: string | null; optional: boolean }[];
  meeting: Meeting;
  guestsCanSeeOtherGuests: boolean;
};

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const LOCATION_FORBIDDEN = /[\r\n\0]/;
const SEND_UPDATES: readonly string[] = ["all", "external_only", "none"];
const CHANGE_KEYS = new Set([
  "start",
  "end",
  "timeZone",
  "title",
  "description",
  "attendees",
  "meeting",
  "guestsCanSeeOtherGuests",
]);
const MAX_EVENT_MS = 24 * 3_600_000;
const MAX_WINDOW_MS = 31 * 24 * 3_600_000;

const fail = (field: string): never => {
  throw new InvalidEventError(field);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function requireString(v: unknown, field: string, min: number, max: number) {
  if (typeof v !== "string" || v.length < min || v.length > max) fail(field);
  return v as string;
}

function validId(v: unknown, field: string): string {
  return requireString(v, field, 1, Number.MAX_SAFE_INTEGER);
}

function validateIdentity(i: Record<string, unknown>, actor = true): void {
  validId(i.tenantId, "tenantId");
  validId(i.connectionId, "connectionId");
  if (actor) validId(i.actorId, "actorId");
}

function validDate(v: unknown, field: string): Date {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) fail(field);
  return v as Date;
}

function validTitle(v: unknown): string {
  const t = requireString(v, "title", 1, 255);
  if (CONTROLS.test(t)) fail("title");
  return t;
}

function validDescription(v: unknown): string {
  if (typeof v !== "string" || v.includes("\0")) return fail("description");
  if (Buffer.byteLength(v, "utf8") > 8192) fail("description");
  return v;
}

function validMeeting(v: unknown): Meeting {
  if (!isObject(v)) return fail("meeting");
  const keys = Object.keys(v);
  if (v.type === "google_meet") {
    if (keys.length !== 1) fail("meeting");
    return { type: "google_meet" };
  }
  if (v.type === "in_person") {
    if (keys.some((k) => k !== "type" && k !== "location")) fail("meeting");
    const loc = requireString(v.location, "meeting.location", 1, 1024);
    if (LOCATION_FORBIDDEN.test(loc)) fail("meeting.location");
    return { type: "in_person", location: loc };
  }
  return fail("meeting");
}

function validBool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") fail(field);
  return v as boolean;
}

function validAttendees(
  v: unknown,
  organizerEmail: string,
): NormalizedEvent["attendees"] {
  if (!Array.isArray(v)) return fail("attendees");
  const organizer = organizerEmail.toLowerCase();
  const seen = new Set<string>([organizer]);
  const out: NormalizedEvent["attendees"] = [];
  v.forEach((raw: unknown, i) => {
    if (!isObject(raw)) fail(`attendees[${i}]`);
    const a = raw as Record<string, unknown>;
    const email = normalizeEmail(a.email);
    if (email === null) fail(`attendees[${i}]`);
    let displayName: string | null = null;
    if (a.displayName !== undefined) {
      const n = requireString(
        a.displayName,
        `attendees[${i}].displayName`,
        0,
        200,
      );
      if (CONTROLS.test(n)) fail(`attendees[${i}].displayName`);
      displayName = n === "" ? null : n;
    }
    const optional =
      a.optional === undefined
        ? false
        : validBool(a.optional, `attendees[${i}].optional`);
    const key = (email as string).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email: email as string, displayName, optional });
  });
  if (out.length < 1 || out.length > 100) fail("attendees");
  return out;
}

function checkRange(start: Date, end: Date): void {
  const span = end.getTime() - start.getTime();
  if (span <= 0 || span > MAX_EVENT_MS) fail("end");
}

function validSendUpdates(v: unknown): SendUpdates {
  if (v === undefined) return "all";
  if (typeof v !== "string" || !SEND_UPDATES.includes(v)) fail("sendUpdates");
  return v as SendUpdates;
}

export function validateCreateInput(
  input: CreateEventInput,
  organizerEmail: string,
): NormalizedEvent & { idempotencyKey: string; sendUpdates: SendUpdates } {
  if (!isObject(input)) return fail("input");
  const i = input as Record<string, unknown>;
  validateIdentity(i);
  const key = requireString(i.idempotencyKey, "idempotencyKey", 1, 200);
  if (CONTROLS.test(key)) fail("idempotencyKey");
  const title = validTitle(i.title);
  const description =
    i.description === undefined ? null : validDescription(i.description);
  const start = validDate(i.start, "start");
  const end = validDate(i.end, "end");
  checkRange(start, end);
  const timeZone = assertTimeZone(i.timeZone, "timeZone");
  const attendees = validAttendees(i.attendees, organizerEmail);
  const meeting = validMeeting(i.meeting);
  const guestsCanSeeOtherGuests =
    i.guestsCanSeeOtherGuests === undefined
      ? false
      : validBool(i.guestsCanSeeOtherGuests, "guestsCanSeeOtherGuests");
  const sendUpdates = validSendUpdates(i.sendUpdates);
  return {
    idempotencyKey: key,
    title,
    description,
    start,
    end,
    timeZone,
    attendees,
    meeting,
    guestsCanSeeOtherGuests,
    sendUpdates,
  };
}

/**
 * Validates only the provided keys. `{}` is valid (the service treats it as a
 * no-op); `description: null` clears the description. start/end ordering is
 * cross-checked by the service after merging with the current event.
 */
export function validateChanges(
  changes: EventChanges,
  organizerEmail: string,
): Partial<NormalizedEvent> {
  if (!isObject(changes)) return fail("changes");
  const c = changes as Record<string, unknown>;
  if (Object.keys(c).some((k) => !CHANGE_KEYS.has(k))) fail("changes");
  const out: Partial<NormalizedEvent> = {};
  if (c.title !== undefined) out.title = validTitle(c.title);
  if (c.description !== undefined)
    out.description =
      c.description === null ? null : validDescription(c.description);
  if (c.start !== undefined) out.start = validDate(c.start, "start");
  if (c.end !== undefined) out.end = validDate(c.end, "end");
  if (c.timeZone !== undefined)
    out.timeZone = assertTimeZone(c.timeZone, "timeZone");
  if (c.attendees !== undefined)
    out.attendees = validAttendees(c.attendees, organizerEmail);
  if (c.meeting !== undefined) out.meeting = validMeeting(c.meeting);
  if (c.guestsCanSeeOtherGuests !== undefined)
    out.guestsCanSeeOtherGuests = validBool(
      c.guestsCanSeeOtherGuests,
      "guestsCanSeeOtherGuests",
    );
  return out;
}

/** Attendees are returned as normalized, lowercase full addresses (first wins). */
export function validateAvailabilityInput(input: AvailabilityInput): {
  attendees: string[];
  window: TimeRange;
} {
  if (!isObject(input)) return fail("input");
  const i = input as Record<string, unknown>;
  validateIdentity(i);
  if (!Array.isArray(i.attendees)) return fail("attendees");
  const seen = new Set<string>();
  for (const raw of i.attendees as unknown[]) {
    const email = normalizeEmail(raw);
    if (email === null) fail("attendees");
    seen.add((email as string).toLowerCase());
  }
  if (seen.size < 1 || seen.size > 50) fail("attendees");
  const w = i.window;
  if (!isObject(w)) return fail("window");
  const start = w.start;
  const end = w.end;
  if (
    !(start instanceof Date) ||
    !(end instanceof Date) ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  )
    return fail("window");
  const span = end.getTime() - start.getTime();
  if (span <= 0 || span > MAX_WINDOW_MS) fail("window");
  return { attendees: [...seen], window: { start, end } };
}
