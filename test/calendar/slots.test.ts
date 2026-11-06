import { describe, expect, it } from "vitest";
import { findCommonSlots } from "../../src/calendar/slots.js";
import { zonedParts } from "../../src/calendar/time.js";
import type { WorkingHours } from "../../src/calendar/types.js";

type Input = Parameters<typeof findCommonSlots>[0];

const NBO = "Africa/Nairobi";
const nine5 = [{ start: "09:00", end: "17:00" }];
const weekdays = (tz: string, iv = nine5): WorkingHours => ({
  timeZone: tz,
  days: { mon: iv, tue: iv, wed: iv, thu: iv, fri: iv },
});
const z = (s: string) => new Date(s);
const MON = {
  start: z("2026-11-09T00:00:00Z"),
  end: z("2026-11-10T00:00:00Z"),
};

const base = (patch: Partial<Input> = {}): Input => ({
  now: z("2026-11-01T00:00:00Z"),
  window: MON,
  durationMinutes: 45,
  workingHours: weekdays(NBO),
  busy: { "a@x.com": [] },
  maxResults: 50,
  ...patch,
});
const local = (d: Date, tz = NBO) => {
  const p = zonedParts(d, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const bad = (patch: Partial<Input>, field: string) =>
  expect(() => findCommonSlots(base(patch))).toThrow(
    expect.objectContaining({ code: "invalid_event", field }),
  );

describe("findCommonSlots", () => {
  it("nairobi 09:00-17:00, empty busy, 45 min, step 15", () => {
    const slots = findCommonSlots(base({ stepMinutes: 15 }));
    expect(slots[0]).toEqual({
      start: z("2026-11-09T06:00:00Z"),
      end: z("2026-11-09T06:45:00Z"),
    });
    expect(zonedParts(slots[0]!.start, NBO).weekday).toBe("mon");
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.start.getTime() - slots[i - 1]!.start.getTime()).toBe(
        15 * 60_000,
      );
    }
    expect(local(slots.at(-1)!.start)).toBe("16:15");
    expect(slots).toHaveLength(30);
  });

  it("no attendees falls back to the tenant working hours", () => {
    const slots = findCommonSlots(base({ busy: {} }));
    expect(slots[0]!.start).toEqual(z("2026-11-09T06:00:00Z"));
    expect(local(slots.at(-1)!.start)).toBe("16:15");
  });

  it("defaults: step 15, maxResults 10", () => {
    const { maxResults: _m, ...rest } = base();
    const slots = findCommonSlots(rest);
    expect(slots).toHaveLength(10);
    expect(local(slots[1]!.start)).toBe("09:15");
  });

  it("busy 10:00-11:00 local with buffer 15", () => {
    const busyStart = z("2026-11-09T07:00:00Z");
    const busyEnd = z("2026-11-09T08:00:00Z");
    const slots = findCommonSlots(
      base({
        busy: { "a@x.com": [{ start: busyStart, end: busyEnd }] },
        bufferMinutes: 15,
      }),
    );
    const lo = z("2026-11-09T06:45:00Z").getTime();
    const hi = z("2026-11-09T08:15:00Z").getTime();
    for (const s of slots) {
      expect(s.start.getTime() < hi && s.end.getTime() > lo).toBe(false);
    }
    const starts = slots.map((s) => local(s.start));
    expect(starts).toContain("09:00"); // ends exactly at 09:45
    expect(starts).not.toContain("09:15");
    expect(starts).toContain("11:15");
    expect(starts).not.toContain("11:00");
  });

  it("busy blocks are matched to the attendee and unsorted input works", () => {
    const slots = findCommonSlots(
      base({
        busy: {
          "a@x.com": [
            {
              start: z("2026-11-09T12:00:00Z"),
              end: z("2026-11-09T14:00:00Z"),
            },
            {
              start: z("2026-11-09T06:00:00Z"),
              end: z("2026-11-09T11:00:00Z"),
            },
          ],
          "b@x.com": [
            {
              start: z("2026-11-09T11:00:00Z"),
              end: z("2026-11-09T11:15:00Z"),
            },
          ],
        },
      }),
    );
    // only 11:15-12:00Z (14:15-15:00 local) is free for both
    expect(slots.map((s) => local(s.start))).toEqual(["14:15"]);
  });

  it("two attendees, one in Europe/London 09:00-17:00", () => {
    const slots = findCommonSlots(
      base({
        busy: { "a@x.com": [], "b@y.com": [] },
        workingHoursByAttendee: { "B@Y.com": weekdays("Europe/London") },
      }),
    );
    // Nairobi 06:00-14:00Z ∩ London 09:00-17:00Z
    expect(slots[0]!.start).toEqual(z("2026-11-09T09:00:00Z"));
    expect(slots.at(-1)!.end).toEqual(z("2026-11-09T14:00:00Z"));
    for (const s of slots) {
      expect(s.start.getTime()).toBeGreaterThanOrEqual(
        z("2026-11-09T09:00:00Z").getTime(),
      );
      expect(s.end.getTime()).toBeLessThanOrEqual(
        z("2026-11-09T14:00:00Z").getTime(),
      );
    }
  });

  it("uses each attendee's own local weekday", () => {
    // Auckland Tue 09:00 = Mon 20:00Z; Nairobi attendee 00:00-24:00 every day
    const all = [{ start: "00:00", end: "24:00" }];
    const slots = findCommonSlots(
      base({
        window: {
          start: z("2026-11-09T00:00:00Z"),
          end: z("2026-11-11T00:00:00Z"),
        },
        workingHours: { timeZone: NBO, days: { mon: all, tue: all, wed: all } },
        busy: { "a@x.com": [], "nz@x.com": [] },
        workingHoursByAttendee: {
          "nz@x.com": { timeZone: "Pacific/Auckland", days: { tue: nine5 } },
        },
        durationMinutes: 60,
      }),
    );
    expect(slots[0]!.start).toEqual(z("2026-11-09T20:00:00Z"));
    expect(slots.at(-1)!.end).toEqual(z("2026-11-10T04:00:00Z"));
  });

  it("minNotice 60 with now = 09:10 local", () => {
    const slots = findCommonSlots(
      base({ now: z("2026-11-09T06:10:00Z"), minNoticeMinutes: 60 }),
    );
    expect(local(slots[0]!.start)).toBe("10:15");
  });

  it("default minNotice is 60", () => {
    const { minNoticeMinutes: _n, ...rest } = base({
      now: z("2026-11-09T06:00:00Z"),
    });
    expect(local(findCommonSlots(rest)[0]!.start)).toBe("10:00");
  });

  it("respects window bounds", () => {
    const slots = findCommonSlots(
      base({
        window: {
          start: z("2026-11-09T07:10:00Z"),
          end: z("2026-11-09T09:00:00Z"),
        },
      }),
    );
    expect(slots.map((s) => local(s.start))).toEqual([
      "10:15",
      "10:30",
      "10:45",
      "11:00",
      "11:15",
    ]);
  });

  it("America/New_York 2026-03-08 spring forward: no 02:xx starts", () => {
    const tz = "America/New_York";
    const all = [{ start: "00:00", end: "24:00" }];
    const slots = findCommonSlots({
      now: z("2026-01-01T00:00:00Z"),
      window: {
        start: z("2026-03-08T05:00:00Z"),
        end: z("2026-03-09T04:00:00Z"),
      },
      durationMinutes: 30,
      stepMinutes: 30,
      workingHours: { timeZone: tz, days: { sun: all } },
      busy: { "a@x.com": [] },
      maxResults: 50,
    });
    const starts = slots.map((s) => local(s.start, tz));
    expect(starts.slice(0, 5)).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "03:00",
    ]);
    expect(starts).not.toContain("02:00");
    expect(starts).not.toContain("02:30");
    expect(new Set(slots.map((s) => s.start.getTime())).size).toBe(
      slots.length,
    );
  });

  it("America/New_York 2026-11-01 fall back: repeated hour used once, earlier instants", () => {
    const tz = "America/New_York";
    const all = [{ start: "00:00", end: "24:00" }];
    const slots = findCommonSlots({
      now: z("2026-01-01T00:00:00Z"),
      window: {
        start: z("2026-11-01T04:00:00Z"),
        end: z("2026-11-02T05:00:00Z"),
      },
      durationMinutes: 30,
      stepMinutes: 30,
      workingHours: { timeZone: tz, days: { sun: all } },
      busy: { "a@x.com": [] },
      maxResults: 50,
    });
    const starts = slots.map((s) => local(s.start, tz));
    expect(starts.filter((s) => s === "01:00")).toHaveLength(1);
    expect(starts.filter((s) => s === "01:30")).toHaveLength(1);
    expect(slots.map((s) => s.start.toISOString())).toEqual(
      expect.arrayContaining([
        "2026-11-01T05:00:00.000Z",
        "2026-11-01T05:30:00.000Z",
      ]),
    );
    expect(slots.map((s) => s.start.toISOString())).not.toContain(
      "2026-11-01T06:00:00.000Z",
    );
    expect(new Set(slots.map((s) => s.start.getTime())).size).toBe(
      slots.length,
    );
    expect(starts.slice(0, 5)).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "02:00",
    ]);
  });

  it("never straddles local midnight; 24:00 means end of day", () => {
    const all = [{ start: "00:00", end: "24:00" }];
    const slots = findCommonSlots(
      base({
        window: {
          start: z("2026-11-09T19:00:00Z"),
          end: z("2026-11-09T23:00:00Z"),
        },
        workingHours: { timeZone: NBO, days: { mon: all, tue: all } },
        durationMinutes: 60,
        stepMinutes: 30,
      }),
    );
    // window is 22:00 Mon - 02:00 Tue local; a 23:30 start would cross midnight
    expect(slots.map((s) => local(s.start))).toEqual([
      "22:00",
      "22:30",
      "23:00",
      "00:00",
      "00:30",
      "01:00",
    ]);
  });

  it("maxResults 3", () => {
    expect(findCommonSlots(base({ maxResults: 3 }))).toHaveLength(3);
  });

  it("weekend with only mon-fri hours", () => {
    const slots = findCommonSlots(
      base({
        window: {
          start: z("2026-11-07T00:00:00Z"),
          end: z("2026-11-08T20:00:00Z"),
        },
      }),
    );
    expect(slots).toEqual([]);
  });

  it("31-day window with step 5 runs fast", () => {
    const t0 = performance.now();
    const slots = findCommonSlots(
      base({
        window: {
          start: z("2026-11-01T00:00:00Z"),
          end: z("2026-12-02T00:00:00Z"),
        },
        stepMinutes: 5,
        busy: {
          "a@x.com": [
            {
              start: z("2026-11-30T06:00:00Z"),
              end: z("2026-11-30T13:00:00Z"),
            },
          ],
          "b@y.com": [],
        },
        workingHoursByAttendee: { "b@y.com": weekdays("Europe/London") },
        workingHours: {
          timeZone: NBO,
          days: { mon: [{ start: "16:00", end: "17:00" }] },
        },
      }),
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(slots.length).toBeGreaterThan(0);
  });

  describe("invalid inputs", () => {
    it.each<[string, Partial<Input>, string]>([
      ["durationMinutes 4", { durationMinutes: 4 }, "durationMinutes"],
      ["durationMinutes 481", { durationMinutes: 481 }, "durationMinutes"],
      ["durationMinutes 30.5", { durationMinutes: 30.5 }, "durationMinutes"],
      ["stepMinutes 4", { stepMinutes: 4 }, "stepMinutes"],
      ["stepMinutes 61", { stepMinutes: 61 }, "stepMinutes"],
      ["bufferMinutes -1", { bufferMinutes: -1 }, "bufferMinutes"],
      ["bufferMinutes 241", { bufferMinutes: 241 }, "bufferMinutes"],
      [
        "minNoticeMinutes 10081",
        { minNoticeMinutes: 10081 },
        "minNoticeMinutes",
      ],
      ["maxResults 0", { maxResults: 0 }, "maxResults"],
      ["maxResults 51", { maxResults: 51 }, "maxResults"],
      [
        "timeZone Mars/Base",
        { workingHours: { timeZone: "Mars/Base", days: {} } },
        "workingHours.timeZone",
      ],
      [
        "window 32 days",
        {
          window: {
            start: z("2026-11-01T00:00:00Z"),
            end: z("2026-12-03T00:00:00Z"),
          },
        },
        "window",
      ],
      [
        "window reversed",
        { window: { start: MON.end, end: MON.start } },
        "window",
      ],
      [
        "window invalid date",
        { window: { start: z("nope"), end: MON.end } },
        "window",
      ],
      [
        "HH:MM start >= end",
        {
          workingHours: {
            timeZone: NBO,
            days: { mon: [{ start: "17:00", end: "09:00" }] },
          },
        },
        "workingHours.days",
      ],
      [
        "HH:MM malformed",
        {
          workingHours: {
            timeZone: NBO,
            days: { mon: [{ start: "9:00", end: "17:00" }] },
          },
        },
        "workingHours.days",
      ],
      [
        "start 24:00",
        {
          workingHours: {
            timeZone: NBO,
            days: { mon: [{ start: "24:00", end: "24:00" }] },
          },
        },
        "workingHours.days",
      ],
      [
        "unknown weekday",
        { workingHours: { timeZone: NBO, days: { xyz: nine5 } as never } },
        "workingHours.days",
      ],
      [
        "attendee tz",
        { workingHoursByAttendee: { "b@y.com": weekdays("Mars/Base") } },
        "workingHoursByAttendee.b@y.com.timeZone",
      ],
    ])("%s", (_name, patch, field) => bad(patch, field));
  });
});
