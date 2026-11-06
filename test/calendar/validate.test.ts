import { describe, expect, it } from "vitest";
import {
  type CreateEventInput,
  validateAvailabilityInput,
  validateChanges,
  validateCreateInput,
} from "../../src/calendar/validate.js";

const ORG = "careers@acme.io";
const ok = (over: Partial<CreateEventInput> = {}): CreateEventInput => ({
  tenantId: "t1",
  connectionId: "c1",
  actorId: "u1",
  idempotencyKey: "interview-1",
  title: "Interview",
  start: new Date("2026-11-10T08:00:00Z"),
  end: new Date("2026-11-10T09:00:00Z"),
  timeZone: "Africa/Nairobi",
  attendees: [{ email: "Ann@X.com" }],
  meeting: { type: "google_meet" },
  ...over,
});
const field = (f: string) =>
  expect.objectContaining({ code: "invalid_event", field: f });
const bad = (over: Partial<CreateEventInput>, f: string) =>
  expect(() => validateCreateInput(ok(over), ORG)).toThrow(field(f));

describe("validateCreateInput", () => {
  it("normalizes and applies defaults", () => {
    const v = validateCreateInput(ok(), ORG);
    expect(v.attendees).toEqual([
      { email: "Ann@x.com", displayName: null, optional: false },
    ]);
    expect(v.description).toBeNull();
    expect(v.guestsCanSeeOtherGuests).toBe(false);
    expect(v.sendUpdates).toBe("all");
    expect(v.idempotencyKey).toBe("interview-1");
  });

  it("[RF 3] dedupes case-insensitively and removes the organizer", () => {
    const v = validateCreateInput(
      ok({
        attendees: [
          { email: "Ann@X.com" },
          { email: "ann@x.com", displayName: "Second" },
          { email: "CAREERS@acme.io" },
        ],
      }),
      ORG,
    );
    expect(v.attendees).toHaveLength(1);
    expect(v.attendees[0]?.email.toLowerCase()).toBe("ann@x.com");
  });

  it("rejects an organizer-only list", () => {
    bad({ attendees: [{ email: "Careers@acme.io" }] }, "attendees");
  });
  it("rejects more than 100 attendees", () => {
    bad(
      {
        attendees: Array.from({ length: 101 }, (_, i) => ({
          email: `u${i}@x.com`,
        })),
      },
      "attendees",
    );
  });
  it("reports attendee field paths", () => {
    bad({ attendees: [{ email: "nope" }] }, "attendees[0]");
    bad(
      { attendees: [{ email: "a@x.com", displayName: "a\nb" }] },
      "attendees[0].displayName",
    );
    bad(
      { attendees: [{ email: "a@x.com", displayName: "x".repeat(201) }] },
      "attendees[0].displayName",
    );
    bad(
      { attendees: [{ email: "a@x.com", optional: "yes" as never }] },
      "attendees[0].optional",
    );
  });

  it.each([["tenantId"], ["connectionId"], ["actorId"]])("requires %s", (k) => {
    bad({ [k]: "" } as never, k);
  });
  it("validates idempotencyKey", () => {
    bad({ idempotencyKey: "" }, "idempotencyKey");
    bad({ idempotencyKey: "a".repeat(201) }, "idempotencyKey");
    bad({ idempotencyKey: "a\u0085b" }, "idempotencyKey");
  });
  it("validates title", () => {
    bad({ title: "" }, "title");
    bad({ title: "a\nb" }, "title");
    bad({ title: "x".repeat(256) }, "title");
  });
  it("validates description by bytes", () => {
    bad({ description: "a".repeat(8193) }, "description");
    bad({ description: "é".repeat(4097) }, "description");
    bad({ description: "a\0b" }, "description");
    expect(
      validateCreateInput(ok({ description: "a".repeat(8192) }), ORG)
        .description,
    ).toHaveLength(8192);
  });
  it("validates times", () => {
    bad({ start: new Date("x") }, "start");
    bad({ end: new Date("x") }, "end");
    bad({ end: new Date("2026-11-10T08:00:00Z") }, "end");
    bad({ end: new Date("2026-11-11T09:00:00Z") }, "end"); // 25 h
    expect(
      validateCreateInput(ok({ end: new Date("2026-11-11T08:00:00Z") }), ORG),
    ).toBeTruthy();
  });
  it("validates timeZone", () => {
    bad({ timeZone: "Mars/Base" }, "timeZone");
  });
  it("validates meeting", () => {
    bad({ meeting: { type: "zoom" } as never }, "meeting");
    bad({ meeting: undefined as never }, "meeting");
    bad(
      { meeting: { type: "google_meet", location: "x" } as never },
      "meeting",
    );
    bad({ meeting: { type: "in_person" } as never }, "meeting.location");
    bad({ meeting: { type: "in_person", location: "" } }, "meeting.location");
    bad(
      { meeting: { type: "in_person", location: "a\nb" } },
      "meeting.location",
    );
    bad(
      { meeting: { type: "in_person", location: "x".repeat(1025) } },
      "meeting.location",
    );
    expect(
      validateCreateInput(
        ok({ meeting: { type: "in_person", location: "HQ" } }),
        ORG,
      ).meeting,
    ).toEqual({ type: "in_person", location: "HQ" });
  });
  it("validates flags", () => {
    bad({ sendUpdates: "some" as never }, "sendUpdates");
    bad({ guestsCanSeeOtherGuests: 1 as never }, "guestsCanSeeOtherGuests");
  });
});

describe("validateChanges", () => {
  it("returns {} for empty changes and only provided keys otherwise", () => {
    expect(validateChanges({}, ORG)).toEqual({});
    expect(validateChanges({ title: "New" }, ORG)).toEqual({ title: "New" });
  });
  it("rejects unknown keys", () => {
    expect(() => validateChanges({ foo: 1 } as never, ORG)).toThrow(
      field("changes"),
    );
  });
  it("validates provided fields with the create rules", () => {
    expect(() => validateChanges({ title: "a\nb" }, ORG)).toThrow(
      field("title"),
    );
    expect(() => validateChanges({ attendees: [] }, ORG)).toThrow(
      field("attendees"),
    );
    expect(() => validateChanges({ attendees: [{ email: ORG }] }, ORG)).toThrow(
      field("attendees"),
    );
    expect(() => validateChanges({ start: new Date("x") }, ORG)).toThrow(
      field("start"),
    );
    expect(() => validateChanges({ timeZone: "Nope/Zone" }, ORG)).toThrow(
      field("timeZone"),
    );
    expect(() =>
      validateChanges({ meeting: { type: "x" } as never }, ORG),
    ).toThrow(field("meeting"));
    expect(
      validateChanges(
        { attendees: [{ email: "B@X.com" }, { email: "b@x.com" }] },
        ORG,
      ).attendees,
    ).toHaveLength(1);
  });
});

describe("validateAvailabilityInput", () => {
  const w = {
    start: new Date("2026-11-10T00:00:00Z"),
    end: new Date("2026-11-11T00:00:00Z"),
  };
  const base = { tenantId: "t", connectionId: "c", actorId: "a" };
  it("dedupes (lowercase full address) and returns the window", () => {
    const v = validateAvailabilityInput({
      ...base,
      attendees: ["Ann@X.com", "ann@x.COM", "b@y.org"],
      window: w,
    });
    expect(v.attendees).toEqual(["ann@x.com", "b@y.org"]);
    expect(v.window).toEqual(w);
  });
  it("rejects bad attendees", () => {
    for (const attendees of [
      [],
      ["nope"],
      Array.from({ length: 51 }, (_, i) => `u${i}@x.com`),
    ])
      expect(() =>
        validateAvailabilityInput({ ...base, attendees, window: w }),
      ).toThrow(field("attendees"));
  });
  it("rejects bad windows", () => {
    const run = (window: unknown) =>
      validateAvailabilityInput({
        ...base,
        attendees: ["a@x.com"],
        window,
      } as never);
    expect(() => run({ start: w.end, end: w.start })).toThrow(field("window"));
    expect(() => run({ start: new Date("x"), end: w.end })).toThrow(
      field("window"),
    );
    expect(() =>
      run({ start: w.start, end: new Date("2026-12-11T00:00:01Z") }),
    ).toThrow(field("window"));
    expect(() =>
      run({ start: w.start, end: new Date("2026-12-11T00:00:00Z") }),
    ).not.toThrow();
  });
  it("requires identity ids", () => {
    expect(() =>
      validateAvailabilityInput({
        ...base,
        tenantId: "",
        attendees: ["a@x.com"],
        window: w,
      }),
    ).toThrow(field("tenantId"));
  });
});
