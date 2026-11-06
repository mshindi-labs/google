import { describe, expect, it } from "vitest";
import {
  assertTimeZone,
  zonedParts,
  zonedToInstant,
} from "../../src/calendar/time.js";

describe("assertTimeZone", () => {
  it("returns a valid IANA zone", () => {
    expect(assertTimeZone("Africa/Nairobi", "tz")).toBe("Africa/Nairobi");
  });
  it.each([["Mars/Base"], [""], [42], [undefined], [null]])(
    "rejects %j with the given field",
    (tz) => {
      expect(() => assertTimeZone(tz, "workingHours.timeZone")).toThrow(
        expect.objectContaining({
          code: "invalid_event",
          field: "workingHours.timeZone",
        }),
      );
    },
  );
});

describe("zonedParts", () => {
  it("reads wall-clock parts and weekday in a zone", () => {
    expect(
      zonedParts(new Date("2026-11-09T06:00:00Z"), "Africa/Nairobi"),
    ).toEqual({
      year: 2026,
      month: 11,
      day: 9,
      hour: 9,
      minute: 0,
      weekday: "mon",
    });
  });
  it("uses 0 for midnight (never 24)", () => {
    expect(
      zonedParts(new Date("2026-11-08T21:00:00Z"), "Africa/Nairobi"),
    ).toMatchObject({
      day: 9,
      hour: 0,
      weekday: "mon",
    });
  });
  it("crosses the date line", () => {
    expect(
      zonedParts(new Date("2026-11-08T12:00:00Z"), "Pacific/Kiritimati"),
    ).toMatchObject({
      day: 9,
      hour: 2,
      weekday: "mon",
    });
  });
});

describe("zonedToInstant", () => {
  const ny = "America/New_York";
  it("converts a plain wall time", () => {
    expect(
      zonedToInstant(
        { year: 2026, month: 11, day: 9, hour: 9, minute: 0 },
        "Africa/Nairobi",
      ),
    ).toEqual(new Date("2026-11-09T06:00:00Z"));
  });
  it("gap returns null", () => {
    expect(
      zonedToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, ny),
    ).toBeNull();
    expect(
      zonedToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 0 }, ny),
    ).toBeNull();
  });
  it("edges of the gap exist", () => {
    expect(
      zonedToInstant({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, ny),
    ).toEqual(new Date("2026-03-08T06:59:00Z"));
    expect(
      zonedToInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, ny),
    ).toEqual(new Date("2026-03-08T07:00:00Z"));
  });
  it("ambiguous returns earlier", () => {
    expect(
      zonedToInstant(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        ny,
      ),
    ).toEqual(new Date("2026-11-01T05:30:00Z"));
  });
  it("handles a positive-offset zone with DST (Europe/London fall back)", () => {
    expect(
      zonedToInstant(
        { year: 2026, month: 10, day: 25, hour: 1, minute: 15 },
        "Europe/London",
      ),
    ).toEqual(new Date("2026-10-25T00:15:00Z"));
  });
});

describe("zonedToInstant — 30-minute DST", () => {
  it("returns the earlier instant of a repeated wall time on Lord Howe", () => {
    expect(
      zonedToInstant(
        { year: 2026, month: 4, day: 5, hour: 1, minute: 45 },
        "Australia/Lord_Howe",
      )?.toISOString(),
    ).toBe("2026-04-04T14:45:00.000Z");
  });
});
