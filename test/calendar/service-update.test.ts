import { beforeEach, describe, expect, it } from "vitest";
import {
  EventCancelledError,
  EventNotFoundError,
  EventNotManagedError,
  GoogleLibError,
  InvalidEventError,
} from "../../src/core/errors.js";
import { createGoogle } from "../../src/core/create-google.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { fingerprint } from "../../src/calendar/ids.js";
import { createCalendar } from "../../src/calendar/service.js";
import type { CreateEventInput } from "../../src/calendar/validate.js";
import { toNormalized } from "../../src/calendar/view.js";
import { FakeCalendar } from "../../src/testing/fake-calendar.js";
import { FakeGoogleOAuth } from "../../src/testing/fake-google-oauth.js";
import { InMemoryStore } from "../../src/testing/in-memory-store.js";
import { LocalKeyProvider } from "../../src/testing/local-key-provider.js";

const cfg = {
  actorId: "admin1",
  clientId: "123-abc.apps.googleusercontent.com",
  clientSecret: "GOCSPX-abcdx7Qa",
};
const careers = {
  sub: "s1",
  email: "careers@sunculture.io",
  hd: "sunculture.io",
  name: "Careers Team",
};

let store: InMemoryStore;
let fake: FakeGoogleOAuth;
let events: GoogleEvent[];
let warnings: string[];
let g: ReturnType<typeof createGoogle>;
let cal: FakeCalendar;
let connId: string;

const svc = () =>
  createCalendar(g, {
    transport: cal,
    sleep: async () => {},
    random: () => 0,
  });

const net = (code: string) =>
  Object.assign(new Error(`socket failure ${code}`), { code });
const unauthorized = () =>
  Object.assign(new Error("unauthorized"), {
    response: { status: 401, data: { error: { errors: [] } } },
  });

const D = (s: string) => new Date(s);
const createInput = (
  over: Partial<CreateEventInput> = {},
): CreateEventInput => ({
  tenantId: "t1",
  connectionId: connId,
  actorId: "u1",
  idempotencyKey: "interview-42",
  title: "Interview: Jane Doe",
  description: "Panel interview",
  start: D("2030-01-07T09:00:00Z"),
  end: D("2030-01-07T10:00:00Z"),
  timeZone: "Africa/Nairobi",
  attendees: [
    { email: "jane@applicant.com", displayName: "Jane Doe" },
    { email: "panel@sunculture.io", optional: true },
  ],
  meeting: { type: "in_person", location: "HQ, Room 4" },
  ...over,
});

const ofType = (t: GoogleEvent["type"]) => events.filter((e) => e.type === t);
const kinds = (k: "invite" | "update" | "cancel") =>
  cal.notifications.filter((n) => n.kind === k);
const ops = () => cal.calls.map((c) => `${c.op}:${c.sendUpdates ?? ""}`);
const patches = () => cal.calls.filter((c) => c.op === "patch");

/** Creates an event, then clears calls/notifications/events so tests see only the update. */
async function booked(over: Partial<CreateEventInput> = {}): Promise<string> {
  const r = await svc().createEvent(createInput(over));
  cal.calls.length = 0;
  cal.notifications.length = 0;
  events.length = 0;
  return r.eventId;
}

const ids = (eventId: string) => ({
  tenantId: "t1",
  connectionId: connId,
  actorId: "u1",
  eventId,
});

beforeEach(async () => {
  store = new InMemoryStore();
  fake = new FakeGoogleOAuth();
  events = [];
  warnings = [];
  g = createGoogle({
    store,
    keyProvider: new LocalKeyProvider(),
    callbackUrl: "https://hrms.io/cb",
    oauthGateway: fake,
    onEvent: (e) => {
      events.push(e);
    },
    logger: {
      warn: (m: string) => {
        warnings.push(m);
      },
      error: () => {},
    },
  });
  await g.clients.configure({ tenantId: "t1", ...cfg });
  const { url } = await g.oauth.createAuthUrl({
    tenantId: "t1",
    actorId: "u1",
    services: ["gmail", "calendar"],
  });
  const { code, state } = fake.consent(url, careers);
  connId = (await g.oauth.handleCallback({ code, state })).connection.id;
  events.length = 0;
  cal = new FakeCalendar({ organizerEmail: careers.email });
});

describe("toNormalized", () => {
  it("reconstructs the create input, so the stored fingerprint matches", async () => {
    const id = await booked();
    const stored = cal.events.get(id)!;
    const n = toNormalized(stored);
    expect(n).toEqual({
      title: "Interview: Jane Doe",
      description: "Panel interview",
      start: D("2030-01-07T09:00:00Z"),
      end: D("2030-01-07T10:00:00Z"),
      timeZone: "Africa/Nairobi",
      attendees: [
        {
          email: "jane@applicant.com",
          displayName: "Jane Doe",
          optional: false,
        },
        { email: "panel@sunculture.io", displayName: null, optional: true },
      ],
      meeting: { type: "in_person", location: "HQ, Room 4" },
      guestsCanSeeOtherGuests: false,
    });
    expect(fingerprint(n)).toBe(
      stored.extendedProperties?.private?.mshindiFingerprint,
    );
  });

  it("drops organizer/self attendees and reads Meet from conferenceData", () => {
    const n = toNormalized({
      id: "x",
      summary: "T",
      start: { dateTime: "2030-01-07T09:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2030-01-07T10:00:00Z", timeZone: "UTC" },
      attendees: [
        { email: "careers@sunculture.io", organizer: true, self: true },
        { email: "a@b.com", responseStatus: "accepted" },
      ],
      conferenceData: { conferenceSolution: { key: { type: "hangoutsMeet" } } },
    });
    expect(n.description).toBeNull();
    expect(n.attendees).toEqual([
      { email: "a@b.com", displayName: null, optional: false },
    ]);
    expect(n.meeting).toEqual({ type: "google_meet" });
    expect(n.guestsCanSeeOtherGuests).toBe(false);
  });
});

describe("updateEvent — reschedule", () => {
  it("moves the time with one patch, one update notification, one updated event", async () => {
    const id = await booked();
    const v = await svc().updateEvent({
      ...ids(id),
      changes: {
        start: D("2030-01-08T09:00:00Z"),
        end: D("2030-01-08T10:00:00Z"),
      },
    });
    expect(v.start).toEqual(D("2030-01-08T09:00:00Z"));
    expect(v.end).toEqual(D("2030-01-08T10:00:00Z"));
    expect(ops()).toEqual(["get:", "patch:all"]);
    expect(kinds("update")).toHaveLength(1);
    const stored = cal.events.get(id)!;
    expect(stored.start).toEqual({
      dateTime: "2030-01-08T09:00:00.000Z",
      timeZone: "Africa/Nairobi",
    });
    const priv = stored.extendedProperties?.private;
    expect(priv?.mshindiKey).toBe("interview-42");
    expect(priv?.mshindiTenant).toBe("t1");
    expect(priv?.mshindiFingerprint).toBe(fingerprint(toNormalized(stored)));
    const upd = ofType("calendar_event.updated");
    expect(upd).toHaveLength(1);
    expect(upd[0]).toMatchObject({
      tenantId: "t1",
      actorId: "u1",
      connectionId: connId,
      eventId: id,
      title: "Interview: Jane Doe",
      start: D("2030-01-08T09:00:00Z"),
      end: D("2030-01-08T10:00:00Z"),
      changed: ["end", "start"],
    });
  });

  it("changed lists only keys whose value differs; patch carries only those fields", async () => {
    const id = await booked();
    let seen: Record<string, unknown> | undefined;
    const transport = {
      ...cal,
      freeBusy: cal.freeBusy.bind(cal),
      insert: cal.insert.bind(cal),
      get: cal.get.bind(cal),
      delete: cal.delete.bind(cal),
      patch: (p: Parameters<FakeCalendar["patch"]>[0]) => {
        seen = p.patch as Record<string, unknown>;
        return cal.patch(p);
      },
    };
    await createCalendar(g, { transport, sleep: async () => {} }).updateEvent({
      ...ids(id),
      changes: {
        title: "Interview: Jane Doe (rescheduled)",
        start: D("2030-01-07T09:00:00Z"),
        guestsCanSeeOtherGuests: false,
      },
    });
    expect(Object.keys(seen!).sort()).toEqual(
      ["extendedProperties", "summary"].sort(),
    );
    expect(ofType("calendar_event.updated")[0]).toMatchObject({
      changed: ["title"],
    });
  });

  it("time-zone only change re-sends start and end", async () => {
    const id = await booked();
    const v = await svc().updateEvent({
      ...ids(id),
      changes: { timeZone: "Europe/London" },
    });
    expect(v.timeZone).toBe("Europe/London");
    expect(cal.events.get(id)!.end?.timeZone).toBe("Europe/London");
  });

  it("description: null clears it", async () => {
    const id = await booked();
    await svc().updateEvent({ ...ids(id), changes: { description: null } });
    expect(toNormalized(cal.events.get(id)!).description).toBeNull();
    expect(ofType("calendar_event.updated")[0]).toMatchObject({
      changed: ["description"],
    });
  });

  it("[RF 5] kept guests keep their RSVP, new guests start at needs_action, removed are dropped", async () => {
    const id = await booked();
    const stored = cal.events.get(id)!;
    stored.attendees![0]!.responseStatus = "accepted";
    stored.attendees![1]!.responseStatus = "declined";
    stored.attendees!.unshift({
      email: careers.email,
      organizer: true,
      self: true,
      responseStatus: "accepted",
    });
    const v = await svc().updateEvent({
      ...ids(id),
      changes: {
        attendees: [
          { email: "Jane@Applicant.com", displayName: "Jane Doe" },
          { email: "new@applicant.com" },
        ],
      },
    });
    // RSVPs match case-insensitively; the caller's spelling is what is sent.
    expect(v.attendees).toEqual([
      {
        email: "Jane@applicant.com",
        displayName: "Jane Doe",
        optional: false,
        response: "accepted",
      },
      {
        email: "new@applicant.com",
        displayName: null,
        optional: false,
        response: "needs_action",
      },
    ]);
    const after = cal.events.get(id)!.attendees!;
    expect(
      after.find((a) => a.email === "new@applicant.com"),
    ).not.toHaveProperty("responseStatus");
    expect(after.some((a) => a.email === "panel@sunculture.io")).toBe(false);
    // The organizer's own attendee entry survives.
    expect(after[0]).toMatchObject({ email: careers.email, organizer: true });
    expect(kinds("update")).toHaveLength(1);
    expect(ofType("calendar_event.updated")[0]).toMatchObject({
      changed: ["attendees"],
      attendees: ["Jane@applicant.com", "new@applicant.com"],
    });
  });

  it("organizer in the new attendee list is dropped", async () => {
    const id = await booked();
    const v = await svc().updateEvent({
      ...ids(id),
      changes: {
        attendees: [{ email: "jane@applicant.com" }, { email: careers.email }],
      },
    });
    expect(v.attendees.map((a) => a.email)).toEqual(["jane@applicant.com"]);
  });

  it("sendUpdates none → no notification; external_only maps", async () => {
    const id = await booked();
    await svc().updateEvent({
      ...ids(id),
      changes: { start: D("2030-01-07T08:00:00Z") },
      sendUpdates: "none",
    });
    await svc().updateEvent({
      ...ids(id),
      changes: { start: D("2030-01-07T07:00:00Z") },
      sendUpdates: "external_only",
    });
    expect(patches().map((c) => c.sendUpdates)).toEqual([
      "none",
      "externalOnly",
    ]);
    expect(kinds("update")).toEqual([
      { eventId: id, kind: "update", to: ["jane@applicant.com"] },
    ]);
  });
});

describe("updateEvent — no-op", () => {
  it("same values → current view, zero patches, no event", async () => {
    const id = await booked();
    const v = await svc().updateEvent({
      ...ids(id),
      changes: {
        start: D("2030-01-07T09:00:00Z"),
        title: "Interview: Jane Doe",
        attendees: [
          { email: "panel@sunculture.io", optional: true },
          { email: "jane@applicant.com", displayName: "Jane Doe" },
        ],
      },
    });
    expect(v.eventId).toBe(id);
    expect(patches()).toHaveLength(0);
    expect(cal.notifications).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("empty changes → no patch, no event", async () => {
    const id = await booked();
    await svc().updateEvent({ ...ids(id), changes: {} });
    expect(patches()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe("updateEvent — verify-then-retry", () => {
  it("patch landed but the response was lost → resolves, one patch, one notification", async () => {
    const id = await booked();
    cal.failNext("patch", net("ECONNRESET"), { afterApply: true });
    const v = await svc().updateEvent({
      ...ids(id),
      changes: {
        start: D("2030-01-07T11:00:00Z"),
        end: D("2030-01-07T12:00:00Z"),
      },
    });
    expect(v.start).toEqual(D("2030-01-07T11:00:00Z"));
    expect(ops()).toEqual(["get:", "patch:all", "get:"]);
    expect(kinds("update")).toHaveLength(1);
    expect(ofType("calendar_event.updated")).toHaveLength(1);
  });

  it("patch failed before landing → re-patched once, one notification", async () => {
    const id = await booked();
    cal.failNext("patch", net("ECONNRESET"));
    await svc().updateEvent({
      ...ids(id),
      changes: { start: D("2030-01-07T08:00:00Z") },
    });
    expect(ops()).toEqual(["get:", "patch:all", "get:", "patch:all"]);
    expect(kinds("update")).toHaveLength(1);
    expect(ofType("calendar_event.updated")).toHaveLength(1);
  });

  it("gives up after 3 attempts with a sanitized error and a failed event", async () => {
    const id = await booked();
    cal.failNext("patch", net("ECONNRESET"), { times: 3 });
    const err = await svc()
      .updateEvent({
        ...ids(id),
        changes: { start: D("2030-01-07T08:00:00Z") },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleLibError);
    expect(patches()).toHaveLength(3);
    expect(cal.notifications).toHaveLength(0);
    expect(ofType("calendar_event.failed")).toEqual([
      expect.objectContaining({ operation: "update" }),
    ]);
    expect(ofType("calendar_event.updated")).toHaveLength(0);
  });

  it("landed patch, then 401 on the verify get → refresh re-run still emits updated once", async () => {
    const id2 = await booked();
    // get #1 = initial read (ok), get #2 = verify after the lost patch (401).
    let gets = 0;
    const transport = {
      freeBusy: cal.freeBusy.bind(cal),
      insert: cal.insert.bind(cal),
      delete: cal.delete.bind(cal),
      patch: cal.patch.bind(cal),
      get: (p: Parameters<FakeCalendar["get"]>[0]) => {
        gets++;
        if (gets === 2) return Promise.reject(unauthorized());
        return cal.get(p);
      },
    };
    cal.failNext("patch", net("ECONNRESET"), { afterApply: true });
    await createCalendar(g, { transport, sleep: async () => {} }).updateEvent({
      ...ids(id2),
      changes: { start: D("2030-01-07T08:00:00Z") },
    });
    expect(patches()).toHaveLength(1);
    expect(kinds("update")).toHaveLength(1);
    expect(ofType("calendar_event.updated")).toEqual([
      expect.objectContaining({ changed: ["start"] }),
    ]);
  });
});

describe("updateEvent — meeting switch", () => {
  it("in-person → Meet gets a meetUrl with a fresh requestId; Meet → in-person drops it", async () => {
    const id = await booked({ meeting: { type: "google_meet" } });
    const firstReq =
      cal.events.get(id)!.conferenceData?.createRequest?.requestId;
    expect(firstReq).toBeDefined();

    const inPerson = await svc().updateEvent({
      ...ids(id),
      changes: { meeting: { type: "in_person", location: "HQ, Room 4" } },
    });
    expect(inPerson.meeting).toEqual({
      type: "in_person",
      location: "HQ, Room 4",
    });
    expect(cal.events.get(id)!.conferenceData).toBeUndefined();

    const meet = await svc().updateEvent({
      ...ids(id),
      changes: { meeting: { type: "google_meet" } },
    });
    expect(meet.meeting).toMatchObject({ type: "google_meet" });
    expect((meet.meeting as { meetUrl: string | null }).meetUrl).toMatch(
      /^https:\/\/meet\.google\.com\//,
    );
    const secondReq =
      cal.events.get(id)!.conferenceData?.createRequest?.requestId;
    expect(secondReq).toBeDefined();
    expect(secondReq).not.toBe(firstReq);
    expect(cal.events.get(id)!.location ?? null).toBeNull();
    expect(kinds("update")).toHaveLength(2);
    expect(
      ofType("calendar_event.updated").map(
        (e) => (e as { changed: string[] }).changed,
      ),
    ).toEqual([["meeting"], ["meeting"]]);
  });

  it("pending conference is polled until the link arrives", async () => {
    const id = await booked();
    cal.setConferenceBehaviour("pending", 1);
    const v = await svc().updateEvent({
      ...ids(id),
      changes: { meeting: { type: "google_meet" } },
    });
    expect((v.meeting as { meetUrl: string | null }).meetUrl).not.toBeNull();
  });

  it("conference failure → no rollback, meetUrl null, warning without payload", async () => {
    const id = await booked();
    cal.setConferenceBehaviour("failure");
    const v = await svc().updateEvent({
      ...ids(id),
      changes: { meeting: { type: "google_meet" } },
    });
    expect(v.meeting).toEqual({ type: "google_meet", meetUrl: null });
    expect(cal.events.get(id)!.status).toBe("confirmed");
    expect(kinds("update")).toHaveLength(1);
    expect(kinds("cancel")).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(id);
    expect(warnings[0]).not.toContain("jane");
    expect(ofType("calendar_event.updated")).toHaveLength(1);
  });
});

describe("updateEvent — guards", () => {
  it("cancelled event → EventCancelledError, failed event", async () => {
    const id = await booked();
    await svc().cancelEvent(ids(id));
    events.length = 0;
    await expect(
      svc().updateEvent({
        ...ids(id),
        changes: { start: D("2030-01-07T08:00:00Z") },
      }),
    ).rejects.toBeInstanceOf(EventCancelledError);
    expect(ofType("calendar_event.failed")).toEqual([
      expect.objectContaining({
        operation: "update",
        errorCode: "event_cancelled",
      }),
    ]);
  });

  it("missing event → EventNotFoundError", async () => {
    await expect(
      svc().updateEvent({ ...ids("nosuchevent"), changes: { title: "x" } }),
    ).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it("invalid changes → InvalidEventError before any transport call, no event", async () => {
    const id = await booked();
    await expect(
      svc().updateEvent({ ...ids(id), changes: { title: "" } }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    await expect(
      svc().updateEvent({
        ...ids(id),
        changes: {},
        sendUpdates: "loud" as never,
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    await expect(
      svc().updateEvent({ ...ids(id), actorId: "", changes: {} }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(cal.calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("merged end before start → InvalidEventError, no patch, failed event", async () => {
    const id = await booked();
    await expect(
      svc().updateEvent({
        ...ids(id),
        changes: { start: D("2030-01-07T10:30:00Z") },
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    await expect(
      svc().updateEvent({
        ...ids(id),
        changes: { end: D("2030-01-08T09:00:01Z") },
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(patches()).toHaveLength(0);
    expect(ofType("calendar_event.failed")).toHaveLength(2);
  });
});

describe("ownership (I9)", () => {
  const foreign = (id: string, priv?: Record<string, string>) =>
    cal.events.set(id, {
      id,
      status: "confirmed",
      summary: "Dentist",
      start: { dateTime: "2030-01-07T09:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2030-01-07T10:00:00Z", timeZone: "UTC" },
      attendees: [{ email: "a@b.com" }],
      ...(priv && { extendedProperties: { private: priv } }),
    });

  it("unmanaged id → EventNotManagedError for update and cancel, untouched", async () => {
    foreign("handmade1");
    foreign("othertenant1", { mshindiGoogle: "v1", mshindiTenant: "t2" });
    for (const id of ["handmade1", "othertenant1"]) {
      await expect(
        svc().updateEvent({ ...ids(id), changes: { title: "Mine now" } }),
      ).rejects.toBeInstanceOf(EventNotManagedError);
      await expect(svc().cancelEvent(ids(id))).rejects.toBeInstanceOf(
        EventNotManagedError,
      );
      expect(cal.events.get(id)!.summary).toBe("Dentist");
      expect(cal.events.get(id)!.status).toBe("confirmed");
    }
    expect(cal.calls.every((c) => c.op === "get")).toBe(true);
  });
});

describe("cancelEvent", () => {
  it("cancel twice → second is a no-op; one cancel notification, one cancelled event", async () => {
    const id = await booked();
    await svc().cancelEvent(ids(id));
    await svc().cancelEvent(ids(id));
    expect(ops()).toEqual(["get:", "delete:all", "get:"]);
    expect(kinds("cancel")).toHaveLength(1);
    const c = ofType("calendar_event.cancelled");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      tenantId: "t1",
      actorId: "u1",
      connectionId: connId,
      eventId: id,
      title: "Interview: Jane Doe",
      attendees: ["jane@applicant.com", "panel@sunculture.io"],
      start: D("2030-01-07T09:00:00Z"),
      end: D("2030-01-07T10:00:00Z"),
    });
  });

  it("passes the caller's sendUpdates", async () => {
    const id = await booked();
    await svc().cancelEvent({ ...ids(id), sendUpdates: "none" });
    expect(ops()).toEqual(["get:", "delete:none"]);
    expect(cal.notifications).toHaveLength(0);
    expect(ofType("calendar_event.cancelled")).toHaveLength(1);
  });

  it("delete landed but the response was lost → retry sees 410 → success, emitted once", async () => {
    const id = await booked();
    cal.failNext("delete", net("ECONNRESET"), { afterApply: true });
    await svc().cancelEvent(ids(id));
    expect(ops()).toEqual(["get:", "delete:all", "delete:all"]);
    expect(kinds("cancel")).toHaveLength(1);
    expect(ofType("calendar_event.cancelled")).toHaveLength(1);
    expect(ofType("calendar_event.failed")).toHaveLength(0);
  });

  it("missing event → EventNotFoundError with a failed event", async () => {
    await expect(svc().cancelEvent(ids("nosuchevent"))).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    expect(ofType("calendar_event.failed")).toEqual([
      expect.objectContaining({
        operation: "cancel",
        errorCode: "event_not_found",
      }),
    ]);
  });

  it("invalid input → InvalidEventError before any transport call", async () => {
    await expect(
      svc().cancelEvent({ ...ids(""), sendUpdates: "all" }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    await expect(
      svc().cancelEvent({ ...ids("abcde"), actorId: "" }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(cal.calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("[I1] bearer token never reaches the failed event or the error", async () => {
    const id = await booked();
    cal.failNext(
      "delete",
      Object.assign(new Error("Authorization: Bearer ya29.secret"), {
        response: {
          status: 403,
          data: {
            error: { message: "nope", errors: [{ reason: "forbidden" }] },
          },
        },
        config: { headers: { Authorization: "Bearer ya29.secret" } },
      }),
    );
    const err = await svc()
      .cancelEvent(ids(id))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleLibError);
    expect((err as Error).message).not.toContain("ya29");
    expect(String((err as { cause?: unknown }).cause)).not.toContain("ya29");
    expect(JSON.stringify(events)).not.toContain("ya29");
  });
});
