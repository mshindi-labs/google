import { InvalidEventError } from "../core/errors.js";
import type { Weekday } from "./types.js";

export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};
export type ZonedParts = WallTime & { weekday: Weekday };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEKDAYS: Record<string, Weekday> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Throws `InvalidEventError(field)` unless `tz` is an IANA zone Intl accepts. */
export function assertTimeZone(tz: unknown, field: string): string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) {
    throw new InvalidEventError(field);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new InvalidEventError(field);
  }
  return tz;
}

/** Wall-clock parts of `at` in `tz` (month 1–12, hour 0–23). */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(at)) out[p.type] = p.value;
  const weekday = WEEKDAYS[out.weekday ?? ""];
  if (weekday === undefined) throw new Error("unexpected Intl weekday");
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday,
  };
}

const wallAsUTC = (p: WallTime) =>
  Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);

const sameWall = (a: WallTime, b: WallTime) =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute;

function offsetAt(t: number, tz: string): number {
  const floored = t - (((t % MINUTE) + MINUTE) % MINUTE);
  return wallAsUTC(zonedParts(new Date(floored), tz)) - floored;
}

/**
 * The instant at which the wall clock in `tz` reads `p`. `null` when that wall time
 * doesn't exist (DST gap); the earlier instant when it occurs twice (DST overlap).
 */
export function zonedToInstant(p: WallTime, tz: string): Date | null {
  const guess = wallAsUTC(p);
  const o1 = offsetAt(guess, tz);
  const o2 = offsetAt(guess - o1, tz);
  const found = new Set<number>();
  for (const offset of new Set([
    o1,
    o2,
    o1 - HOUR,
    o1 + HOUR,
    o2 - HOUR,
    o2 + HOUR,
  ])) {
    const cand = guess - offset;
    if (sameWall(zonedParts(new Date(cand), tz), p)) found.add(cand);
  }
  if (found.size === 0) return null;
  return new Date(Math.min(...found));
}
