import { InvalidEventError } from "../core/errors.js";
import {
  assertTimeZone,
  type WallTime,
  zonedParts,
  zonedToInstant,
} from "./time.js";
import type { TimeRange, Weekday, WorkingHours } from "./types.js";

export type FindCommonSlotsInput = {
  now: Date;
  window: TimeRange;
  durationMinutes: number;
  workingHours: WorkingHours;
  workingHoursByAttendee?: Record<string, WorkingHours>;
  busy: Record<string, TimeRange[]>;
  bufferMinutes?: number;
  stepMinutes?: number;
  minNoticeMinutes?: number;
  maxResults?: number;
};

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const MAX_WINDOW_MS = 31 * DAY_MINUTES * MINUTE;
const WEEKDAYS: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];
const HHMM = /^(\d{2}):(\d{2})$/;

type Interval = { start: number; end: number }; // minutes of the local day, end ≤ 1440
type Hours = { timeZone: string; days: Partial<Record<Weekday, Interval[]>> };

function intIn(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new InvalidEventError(field);
  }
  return value;
}

const isDate = (d: unknown): d is Date =>
  d instanceof Date && !Number.isNaN(d.getTime());

function parseHHMM(s: unknown, allow24: boolean, field: string): number {
  const m = typeof s === "string" ? HHMM.exec(s) : null;
  if (m === null) throw new InvalidEventError(field);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (allow24 && h === 24 && min === 0) return DAY_MINUTES;
  if (h > 23 || min > 59) throw new InvalidEventError(field);
  return h * 60 + min;
}

function parseHours(wh: unknown, path: string): Hours {
  if (typeof wh !== "object" || wh === null) throw new InvalidEventError(path);
  const { timeZone, days } = wh as WorkingHours;
  const tz = assertTimeZone(timeZone, `${path}.timeZone`);
  const daysField = `${path}.days`;
  if (typeof days !== "object" || days === null)
    throw new InvalidEventError(daysField);
  const out: Hours = { timeZone: tz, days: {} };
  for (const [key, list] of Object.entries(days)) {
    if (!WEEKDAYS.includes(key as Weekday) || !Array.isArray(list)) {
      throw new InvalidEventError(daysField);
    }
    out.days[key as Weekday] = list.map((iv: unknown) => {
      const { start, end } = (iv ?? {}) as { start?: unknown; end?: unknown };
      const s = parseHHMM(start, false, daysField);
      const e = parseHHMM(end, true, daysField);
      if (s >= e) throw new InvalidEventError(daysField);
      return { start: s, end: e };
    });
  }
  return out;
}

/** Sorted, merged busy blocks widened by `buffer` ms on both sides. */
function prepareBusy(
  ranges: unknown,
  buffer: number,
  field: string,
): Interval[] {
  if (!Array.isArray(ranges)) throw new InvalidEventError(field);
  const list = ranges.map((r: unknown) => {
    const { start, end } = (r ?? {}) as Partial<TimeRange>;
    if (!isDate(start) || !isDate(end)) throw new InvalidEventError(field);
    return { start: start.getTime() - buffer, end: end.getTime() + buffer };
  });
  list.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of list) {
    const last = merged.at(-1);
    if (last !== undefined && iv.start <= last.end)
      last.end = Math.max(last.end, iv.end);
    else if (iv.end > iv.start) merged.push({ ...iv });
  }
  return merged;
}

/** True when [start, end) overlaps a block of the sorted, merged `busy` list. */
function overlapsBusy(busy: Interval[], start: number, end: number): boolean {
  let lo = 0;
  let hi = busy.length; // first block with start >= end
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (busy[mid]!.start < end) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && busy[lo - 1]!.end > start;
}

const addDays = (p: WallTime, n: number): WallTime => {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
  };
};

/** Local date + minutes-of-day → instant; a gap wall time resolves to the gap's end. */
function boundInstant(date: WallTime, minutes: number, tz: string): number {
  for (let m = minutes; m <= minutes + 24 * 60; m++) {
    const p = m >= DAY_MINUTES ? addDays(date, 1) : date;
    const mm = m % DAY_MINUTES;
    const at = zonedToInstant(
      { ...p, hour: Math.floor(mm / 60), minute: mm % 60 },
      tz,
    );
    if (at !== null) return at.getTime();
  }
  throw new Error("unresolvable wall time");
}

type Participant = { hours: Hours; busy: Interval[]; working: Interval[] };

/**
 * Working intervals of `hours` as instants for every local day overlapping
 * [from, to], sorted by start. Each interval stays inside its own local day.
 */
function workingInstants(hours: Hours, from: number, to: number): Interval[] {
  const tz = hours.timeZone;
  const a = zonedParts(new Date(from), tz);
  const b = zonedParts(new Date(to), tz);
  const lastKey = Date.UTC(b.year, b.month - 1, b.day);
  const out: Interval[] = [];
  for (let n = 0; ; n++) {
    const date = addDays({ ...a, hour: 0, minute: 0 }, n);
    const utc = Date.UTC(date.year, date.month - 1, date.day);
    if (utc > lastKey) break;
    const weekday = WEEKDAYS[(new Date(utc).getUTCDay() + 6) % 7]!;
    for (const iv of hours.days[weekday] ?? []) {
      out.push({
        start: boundInstant(date, iv.start, tz),
        end: boundInstant(date, iv.end, tz),
      });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** True when [start, end) lies inside a single interval of the sorted `working` list. */
function insideHours(working: Interval[], start: number, end: number): boolean {
  let lo = 0;
  let hi = working.length; // first interval with start > `start`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (working[mid]!.start <= start) lo = mid + 1;
    else hi = mid;
  }
  // intervals never exceed one local day (≤ 25 h), so older ones can't contain `start`
  for (
    let i = lo - 1;
    i >= 0 && working[i]!.start > start - 26 * 60 * MINUTE;
    i--
  ) {
    if (end <= working[i]!.end) return true;
  }
  return false;
}

/**
 * Instants of the wall times 00:00, step, 2·step… of `date` in `tz`; `null` for a
 * wall time in a DST gap, the earlier instant for a repeated one. Days without an
 * offset change (sampled hourly) are computed with one fixed offset.
 */
function dayCandidates(
  date: WallTime,
  step: number,
  tz: string,
): (number | null)[] {
  const midnight = Date.UTC(date.year, date.month - 1, date.day);
  const offsetOf = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  const offset = offsetOf(midnight);
  let fixed = true;
  for (let h = -2; h <= 26 && fixed; h++) {
    fixed = offsetOf(midnight - offset + h * 60 * MINUTE) === offset;
  }
  const out: (number | null)[] = [];
  for (let m = 0; m < DAY_MINUTES; m += step) {
    if (fixed) out.push(midnight + m * MINUTE - offset);
    else {
      const at = zonedToInstant(
        { ...date, hour: Math.floor(m / 60), minute: m % 60 },
        tz,
      );
      out.push(at === null ? null : at.getTime());
    }
  }
  return out;
}

export type SlotParams = Pick<
  FindCommonSlotsInput,
  | "durationMinutes"
  | "workingHours"
  | "workingHoursByAttendee"
  | "bufferMinutes"
  | "stepMinutes"
  | "minNoticeMinutes"
  | "maxResults"
>;

/**
 * Validates the slot parameters (everything but `now`, `window` and `busy`) and
 * applies defaults. Throws InvalidEventError; pure, so callers can run it before
 * any Google call.
 */
export function parseSlotParams(input: SlotParams) {
  const durationMinutes = intIn(
    input.durationMinutes,
    5,
    480,
    "durationMinutes",
  );
  const stepMinutes = intIn(input.stepMinutes ?? 15, 5, 60, "stepMinutes");
  const bufferMinutes = intIn(
    input.bufferMinutes ?? 0,
    0,
    240,
    "bufferMinutes",
  );
  const minNoticeMinutes = intIn(
    input.minNoticeMinutes ?? 60,
    0,
    10080,
    "minNoticeMinutes",
  );
  const maxResults = intIn(input.maxResults ?? 10, 1, 50, "maxResults");
  const tenant = parseHours(input.workingHours, "workingHours");
  const overrides = new Map<string, Hours>();
  const byAttendee = input.workingHoursByAttendee ?? {};
  if (typeof byAttendee !== "object" || byAttendee === null)
    throw new InvalidEventError("workingHoursByAttendee");
  for (const [email, wh] of Object.entries(byAttendee)) {
    overrides.set(
      email.toLowerCase(),
      parseHours(wh, `workingHoursByAttendee.${email}`),
    );
  }
  return {
    durationMinutes,
    stepMinutes,
    bufferMinutes,
    minNoticeMinutes,
    maxResults,
    tenant,
    overrides,
  };
}

/**
 * Common free slots for every attendee (the keys of `busy`), each inside that attendee's
 * own working hours (`workingHoursByAttendee`, case-insensitive, else `workingHours`) and
 * clear of their busy blocks widened by `bufferMinutes`. With no attendees the tenant
 * `workingHours` apply. Candidate starts are wall times aligned to `stepMinutes` from
 * 00:00 in `workingHours.timeZone`: DST-gap times are skipped, repeated ones used once.
 * Pure: no I/O, `now` is an input.
 */
export function findCommonSlots(input: FindCommonSlotsInput): TimeRange[] {
  const {
    durationMinutes: duration,
    stepMinutes: step,
    bufferMinutes: buffer,
    minNoticeMinutes: notice,
    maxResults,
    tenant,
    overrides,
  } = parseSlotParams(input);
  if (!isDate(input.now)) throw new InvalidEventError("now");
  const { window } = input;
  if (
    typeof window !== "object" ||
    window === null ||
    !isDate(window.start) ||
    !isDate(window.end)
  ) {
    throw new InvalidEventError("window");
  }
  const winStart = window.start.getTime();
  const winEnd = window.end.getTime();
  if (winEnd <= winStart || winEnd - winStart > MAX_WINDOW_MS) {
    throw new InvalidEventError("window");
  }
  if (typeof input.busy !== "object" || input.busy === null)
    throw new InvalidEventError("busy");
  const people: Participant[] = Object.entries(input.busy).map(
    ([email, ranges]) => ({
      hours: overrides.get(email.toLowerCase()) ?? tenant,
      busy: prepareBusy(ranges, buffer * MINUTE, `busy.${email}`),
      working: [],
    }),
  );
  if (people.length === 0)
    people.push({ hours: tenant, busy: [], working: [] });
  const workingCache = new Map<Hours, Interval[]>();
  for (const p of people) {
    let w = workingCache.get(p.hours);
    if (w === undefined) {
      w = workingInstants(p.hours, winStart, winEnd);
      workingCache.set(p.hours, w);
    }
    p.working = w;
  }

  const earliest = Math.max(winStart, input.now.getTime() + notice * MINUTE);
  const durationMs = duration * MINUTE;
  const tz = tenant.timeZone;
  const first = zonedParts(window.start, tz);
  const last = zonedParts(new Date(winEnd - 1), tz);
  const lastKey = Date.UTC(last.year, last.month - 1, last.day);
  const seen = new Set<number>();
  const slots: TimeRange[] = [];

  for (let n = 0; ; n++) {
    const date = addDays({ ...first, hour: 0, minute: 0 }, n);
    if (Date.UTC(date.year, date.month - 1, date.day) > lastKey) break;
    for (const start of dayCandidates(date, step, tz)) {
      if (start === null) continue;
      const end = start + durationMs;
      if (start < earliest || end > winEnd || seen.has(start)) continue;
      seen.add(start);
      if (
        people.every(
          (p) =>
            !overlapsBusy(p.busy, start, end) &&
            insideHours(p.working, start, end),
        )
      ) {
        slots.push({ start: new Date(start), end: new Date(end) });
      }
    }
  }
  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return slots.slice(0, maxResults);
}
