import { describe, expect, it } from "vitest";
import { deriveEventId, fingerprint } from "../../src/calendar/ids.js";
import type { NormalizedEvent } from "../../src/calendar/validate.js";

const base = (): NormalizedEvent => ({
  title: "Interview",
  description: null,
  start: new Date("2026-11-10T08:00:00Z"),
  end: new Date("2026-11-10T09:00:00Z"),
  timeZone: "Africa/Nairobi",
  attendees: [
    { email: "a@x.com", displayName: "A", optional: false },
    { email: "b@x.com", displayName: null, optional: true },
  ],
  meeting: { type: "google_meet" },
  guestsCanSeeOtherGuests: false,
});

describe("deriveEventId", () => {
  it("is stable and base32hex-shaped", () => {
    const id = deriveEventId("t1", "org@acme.io", "k1");
    expect(id).toMatch(/^[a-v0-9]{32}$/);
    expect(deriveEventId("t1", "org@acme.io", "k1")).toBe(id);
  });
  it("matches an independent base32hex reference vector", () => {
    expect(deriveEventId("t1", "org@acme.io", "k1")).toBe(
      "dskkjfe0kt4it6pdb3isvthqqhq7jjvj",
    );
  });
  it("differs per tenant and key", () => {
    const id = deriveEventId("t1", "org@acme.io", "k1");
    expect(deriveEventId("t2", "org@acme.io", "k1")).not.toBe(id);
    expect(deriveEventId("t1", "org@acme.io", "k2")).not.toBe(id);
  });
  it("ignores organizer case", () => {
    expect(deriveEventId("t1", "Org@Acme.IO", "k1")).toBe(
      deriveEventId("t1", "org@acme.io", "k1"),
    );
  });
});

describe("fingerprint", () => {
  it("is 32 hex chars", () => {
    expect(fingerprint(base())).toMatch(/^[0-9a-f]{32}$/);
  });
  it("ignores attendee order and displayName", () => {
    const e = base();
    const f = {
      ...e,
      attendees: [
        { email: "b@x.com", displayName: "Bee", optional: true },
        { email: "a@x.com", displayName: null, optional: false },
      ],
    };
    expect(fingerprint(f)).toBe(fingerprint(e));
  });
  it("changes with start, optional, meeting and visibility", () => {
    const f = fingerprint(base());
    expect(
      fingerprint({ ...base(), start: new Date("2026-11-10T08:15:00Z") }),
    ).not.toBe(f);
    expect(
      fingerprint({
        ...base(),
        attendees: [
          { email: "a@x.com", displayName: "A", optional: true },
          { email: "b@x.com", displayName: null, optional: true },
        ],
      }),
    ).not.toBe(f);
    expect(
      fingerprint({
        ...base(),
        meeting: { type: "in_person", location: "HQ" },
      }),
    ).not.toBe(f);
    expect(fingerprint({ ...base(), guestsCanSeeOtherGuests: true })).not.toBe(
      f,
    );
  });
});
