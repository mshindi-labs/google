import { beforeEach, describe, expect, it } from "vitest";
import {
  ConferencingUnavailableError,
  EventConflictError,
  GoogleLibError,
  InvalidEventError,
} from "../../src/core/errors.js";
import { createGoogle } from "../../src/core/create-google.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { deriveEventId } from "../../src/calendar/ids.js";
import { createCalendar } from "../../src/calendar/service.js";
import type { CalendarTransport } from "../../src/calendar/transport.js";
import type { CreateEventInput } from "../../src/calendar/validate.js";
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
let sleeps: number[];
let g: ReturnType<typeof createGoogle>;
let cal: FakeCalendar;
let connId: string;

const svc = () =>
  createCalendar(g, {
    transport: cal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });

const net = (code: string) =>
  Object.assign(new Error(`socket failure ${code}`), { code });

const D = (s: string) => new Date(s);
const input = (over: Partial<CreateEventInput> = {}): CreateEventInput => ({
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
  meeting: { type: "google_meet" },
  ...over,
});
const inPerson = (over: Partial<CreateEventInput> = {}) =>
  input({ meeting: { type: "in_person", location: "HQ, Room 4" }, ...over });

const invites = () => cal.notifications.filter((n) => n.kind === "invite");
const ofType = (t: GoogleEvent["type"]) => events.filter((e) => e.type === t);
const ops = () => cal.calls.map((c) => `${c.op}:${c.sendUpdates ?? ""}`);

beforeEach(async () => {
  store = new InMemoryStore();
  fake = new FakeGoogleOAuth();
  events = [];
  warnings = [];
  sleeps = [];
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

describe("createEvent — in person", () => {
  it("one insert with the caller's sendUpdates, one invite, one created event", async () => {
    const r = await svc().createEvent(inPerson());
    expect(r.created).toBe(true);
    expect(r.eventId).toBe(deriveEventId("t1", careers.email, "interview-42"));
    expect(r.meeting).toEqual({ type: "in_person", location: "HQ, Room 4" });
    expect(ops()).toEqual(["insert:all"]);
    expect(invites()).toHaveLength(1);
    const stored = cal.events.get(r.eventId)!;
    expect(stored.guestsCanInviteOthers).toBe(false);
    expect(stored.guestsCanModify).toBe(false);
    expect(stored.guestsCanSeeOtherGuests).toBe(false);
    expect(stored.location).toBe("HQ, Room 4");
    expect(stored.conferenceData).toBeUndefined();
    expect(stored.start).toEqual({
      dateTime: "2030-01-07T09:00:00.000Z",
      timeZone: "Africa/Nairobi",
    });
    expect(stored.attendees).toEqual([
      { email: "jane@applicant.com", displayName: "Jane Doe", optional: false },
      { email: "panel@sunculture.io", optional: true },
    ]);
    const priv = stored.extendedProperties?.private;
    expect(priv).toMatchObject({
      mshindiGoogle: "v1",
      mshindiTenant: "t1",
      mshindiKey: "interview-42",
      mshindiInvite: "sent",
    });
    expect(priv?.mshindiFingerprint).toMatch(/^[0-9a-f]{32}$/);
    const created = ofType("calendar_event.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenantId: "t1",
      actorId: "u1",
      connectionId: connId,
      eventId: r.eventId,
      title: "Interview: Jane Doe",
    });
  });

  it("maps external_only to externalOnly", async () => {
    await svc().createEvent(inPerson({ sendUpdates: "external_only" }));
    expect(ops()).toEqual(["insert:externalOnly"]);
    expect(invites()).toEqual([
      expect.objectContaining({ to: ["jane@applicant.com"] }),
    ]);
  });
});

describe("createEvent — Google Meet", () => {
  it("inserts silently, then releases invites by patch; one invite, meetUrl set", async () => {
    const r = await svc().createEvent(input());
    expect(ops()).toEqual(["insert:none", "patch:all"]);
    expect(invites()).toHaveLength(1);
    expect(r.created).toBe(true);
    expect(r.meeting).toEqual({
      type: "google_meet",
      meetUrl: expect.stringMatching(/^https:\/\/meet\.google\.com\//),
    });
    const stored = cal.events.get(r.eventId)!;
    expect(stored.extendedProperties?.private?.mshindiInvite).toBe("sent");
    expect(stored.conferenceData?.createRequest?.requestId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(ofType("calendar_event.created")).toHaveLength(1);
  });

  it("pending conference resolves after one get", async () => {
    cal.setConferenceBehaviour("pending", 0);
    const r = await svc().createEvent(input());
    expect(ops()).toEqual(["insert:none", "get:", "patch:all"]);
    expect(sleeps).toEqual([500]);
    expect(r.meeting).toMatchObject({ type: "google_meet" });
    expect((r.meeting as { meetUrl: string | null }).meetUrl).not.toBeNull();
    expect(invites()).toHaveLength(1);
  });

  it("conference still pending after the poll budget → cancelled, no notifications", async () => {
    cal.setConferenceBehaviour("pending", 99);
    const err = await svc()
      .createEvent(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConferencingUnavailableError);
    expect(sleeps).toEqual([500, 1000, 2000, 3000, 3500]);
    expect(cal.calls.filter((c) => c.op === "delete")).toEqual([
      { op: "delete", sendUpdates: "none" },
    ]);
    expect(cal.notifications).toHaveLength(0);
  });

  it("conference failure → event cancelled silently, ConferencingUnavailableError, zero notifications", async () => {
    cal.setConferenceBehaviour("failure");
    const err = await svc()
      .createEvent(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConferencingUnavailableError);
    expect((err as Error).message).toMatch(/new idempotency key/i);
    const id = deriveEventId("t1", careers.email, "interview-42");
    expect(cal.events.get(id)?.status).toBe("cancelled");
    expect(ops()).toEqual(["insert:none", "delete:none"]);
    expect(cal.notifications).toHaveLength(0);
    expect(ofType("calendar_event.created")).toHaveLength(0);
    expect(ofType("calendar_event.failed")).toEqual([
      expect.objectContaining({
        operation: "create",
        errorCode: "conferencing_unavailable",
      }),
    ]);
  });

  it("cleanup delete failing still throws ConferencingUnavailableError and warns", async () => {
    cal.setConferenceBehaviour("failure");
    cal.failNext(
      "delete",
      Object.assign(new Error("forbidden"), {
        response: { status: 403, data: { error: { errors: [] } } },
      }),
    );
    const err = await svc()
      .createEvent(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConferencingUnavailableError);
    expect(cal.notifications).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("replay after a conference failure → EventConflictError (id is burned)", async () => {
    cal.setConferenceBehaviour("failure");
    await expect(svc().createEvent(input())).rejects.toBeInstanceOf(
      ConferencingUnavailableError,
    );
    cal.setConferenceBehaviour("success");
    await expect(svc().createEvent(input())).rejects.toBeInstanceOf(
      EventConflictError,
    );
    expect(cal.notifications).toHaveLength(0);
  });

  it("patch landed but the response was lost → verified by get, no re-patch", async () => {
    cal.failNext("patch", net("ECONNRESET"), { afterApply: true });
    const r = await svc().createEvent(input());
    expect(ops()).toEqual(["insert:none", "patch:all", "get:"]);
    expect(invites()).toHaveLength(1);
    expect(r.created).toBe(true);
    expect(ofType("calendar_event.created")).toHaveLength(1);
  });

  it("patch failed before landing → get shows pending → patch retried once", async () => {
    cal.failNext("patch", net("ECONNRESET"));
    await svc().createEvent(input());
    expect(ops()).toEqual(["insert:none", "patch:all", "get:", "patch:all"]);
    expect(invites()).toHaveLength(1);
  });
});

describe("createEvent — idempotency", () => {
  it("[RF 1] insert landed but timed out → created: true, one invite, one created event", async () => {
    cal.failNext("insert", net("ETIMEDOUT"), { afterApply: true });
    const r = await svc().createEvent(input());
    expect(r.created).toBe(true);
    expect(invites()).toHaveLength(1);
    expect(ofType("calendar_event.created")).toHaveLength(1);
    expect(cal.events.size).toBe(1);
  });

  it("[RF 1] in person: insert landed but timed out → created: true, one invite", async () => {
    cal.failNext("insert", net("ETIMEDOUT"), { afterApply: true });
    const r = await svc().createEvent(inPerson());
    expect(r.created).toBe(true);
    expect(ops()).toEqual(["insert:all", "insert:all", "get:"]);
    expect(invites()).toHaveLength(1);
    expect(ofType("calendar_event.created")).toHaveLength(1);
  });

  it("replay in a second call → created: false, no new notification or event", async () => {
    const first = await svc().createEvent(input());
    events.length = 0;
    const again = await svc().createEvent(input());
    expect(again.created).toBe(false);
    expect(again.eventId).toBe(first.eventId);
    expect(again.meeting).toEqual(first.meeting);
    expect(invites()).toHaveLength(1);
    expect(cal.events.size).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("same key, different start → EventConflictError mentioning updateEvent", async () => {
    await svc().createEvent(input());
    const err = await svc()
      .createEvent(input({ start: D("2030-01-07T09:30:00Z") }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventConflictError);
    expect((err as Error).message).toMatch(/updateEvent/);
    expect(invites()).toHaveLength(1);
  });

  it("existing id without our stamp → EventConflictError", async () => {
    const id = deriveEventId("t1", careers.email, "interview-42");
    cal.events.set(id, { id, status: "confirmed", summary: "someone else" });
    await expect(svc().createEvent(input())).rejects.toBeInstanceOf(
      EventConflictError,
    );
    expect(cal.notifications).toHaveLength(0);
  });

  it("crash between insert and invite release, then replay → invites sent exactly once", async () => {
    cal.failNext("patch", net("ECONNRESET"), { times: 3 });
    const err = await svc()
      .createEvent(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleLibError);
    expect(cal.notifications).toHaveLength(0);
    expect(ofType("calendar_event.failed")).toHaveLength(1);

    const r = await svc().createEvent(input());
    expect(r.created).toBe(false);
    expect(invites()).toHaveLength(1);
    expect(cal.events.size).toBe(1);
    // the resuming call is the one that released the invites
    expect(ofType("calendar_event.created")).toHaveLength(1);

    await svc().createEvent(input());
    expect(invites()).toHaveLength(1);
    expect(ofType("calendar_event.created")).toHaveLength(1);
  });

  it("rejects invalid input before any transport call", async () => {
    await expect(
      svc().createEvent(input({ title: "" })),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(cal.calls).toHaveLength(0);
  });
});

describe("createEvent — I1", () => {
  it("[RF 4] bearer token never reaches the failed event or the thrown error", async () => {
    const raw = Object.assign(
      new Error("Request failed, Authorization: Bearer ya29.secret"),
      {
        response: {
          status: 403,
          data: {
            error: { message: "nope", errors: [{ reason: "forbidden" }] },
          },
        },
        config: { headers: { Authorization: "Bearer ya29.secret" } },
      },
    );
    cal.failNext("insert", raw);
    const err = await svc()
      .createEvent(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleLibError);
    const failed = ofType("calendar_event.failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain("ya29");
    expect(Object.keys(failed[0]!).sort()).toEqual(
      [
        "actorId",
        "at",
        "connectionId",
        "errorCode",
        "operation",
        "tenantId",
        "type",
      ].sort(),
    );
    const e = err as Error & { cause?: Error };
    expect(JSON.stringify(e)).not.toContain("ya29");
    expect(e.message).not.toContain("ya29");
    expect(String(e.cause)).not.toContain("ya29");
    expect(String(e.cause?.stack)).not.toContain("ya29");
  });
});

describe("createEvent — concurrent same-key calls", () => {
  /** The shared FakeCalendar, with some operations hooked for call A. */
  const wrap = (over: Partial<CalendarTransport>): CalendarTransport => ({
    freeBusy: (p) => cal.freeBusy(p),
    insert: (p) => cal.insert(p),
    get: (p) => cal.get(p),
    patch: (p) => cal.patch(p),
    delete: (p) => cal.delete(p),
    ...over,
  });
  const svcWith = (transport: CalendarTransport, sleep = async () => {}) =>
    createCalendar(g, { transport, sleep, random: () => 0 });

  it("B resumes the pending event while A is mid-poll → one invite, one created event", async () => {
    cal.setConferenceBehaviour("pending", 2);
    let b: ReturnType<ReturnType<typeof svc>["createEvent"]> | undefined;
    const callA = svcWith(cal, async () => {
      if (b === undefined) {
        b = svc().createEvent(input());
        await b;
      }
    });
    const a = await callA.createEvent(input());
    const rb = await b!;
    expect(a.eventId).toBe(rb.eventId);
    expect(a.created).toBe(true);
    expect(rb.created).toBe(false);
    expect(invites()).toHaveLength(1);
    expect(ofType("calendar_event.created")).toHaveLength(1);
    expect(ofType("calendar_event.failed")).toHaveLength(0);
    expect(cal.events.size).toBe(1);
  });

  it("B releases between A's last read and A's patch → A's If-Match fails, no second release", async () => {
    let b: ReturnType<ReturnType<typeof svc>["createEvent"]> | undefined;
    const tA = wrap({
      patch: async (p) => {
        if (b === undefined) {
          b = svc().createEvent(input());
          await b;
        }
        return cal.patch(p);
      },
    });
    const a = await svcWith(tA).createEvent(input());
    const rb = await b!;
    expect(a.eventId).toBe(rb.eventId);
    expect(a.meeting).toEqual(rb.meeting);
    expect((a.meeting as { meetUrl: string | null }).meetUrl).not.toBeNull();
    expect(cal.calls.filter((c) => c.op === "patch")).toHaveLength(2);
    expect(invites()).toHaveLength(1);
    expect(ofType("calendar_event.created")).toHaveLength(1);
  });

  it("A's withdrawal loses the race to a release elsewhere → A resolves as a replay", async () => {
    cal.setConferenceBehaviour("failure");
    const tA = wrap({
      delete: async (p) => {
        // Another same-key call got a link and released the invites meanwhile.
        const e = cal.events.get(p.eventId)!;
        e.conferenceData = {
          ...e.conferenceData,
          createRequest: {
            ...e.conferenceData?.createRequest,
            status: { statusCode: "success" },
          },
          entryPoints: [
            { entryPointType: "video", uri: "https://meet.google.com/other" },
          ],
        };
        e.extendedProperties!.private!.mshindiInvite = "sent";
        e.etag = '"released-elsewhere"';
        return cal.delete(p);
      },
    });
    const a = await svcWith(tA).createEvent(input());
    expect(a.created).toBe(false);
    expect(a.meeting).toEqual({
      type: "google_meet",
      meetUrl: "https://meet.google.com/other",
    });
    expect(cal.events.get(a.eventId)?.status).toBe("confirmed");
    expect(cal.notifications).toHaveLength(0);
    expect(ofType("calendar_event.created")).toHaveLength(0);
    expect(ofType("calendar_event.failed")).toHaveLength(0);
  });

  it("A's withdrawal finds the event already cancelled elsewhere → ConferencingUnavailableError", async () => {
    cal.setConferenceBehaviour("failure");
    const tA = wrap({
      delete: async (p) => {
        await cal.delete({
          accessToken: p.accessToken,
          eventId: p.eventId,
          sendUpdates: "none",
        });
        return cal.delete(p);
      },
    });
    const err = await svcWith(tA)
      .createEvent(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConferencingUnavailableError);
    expect(cal.notifications).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("createEvent — token refresh", () => {
  it("401 on the release patch → refresh and re-run: created true, one invite, one created event", async () => {
    cal.failNext(
      "patch",
      Object.assign(new Error("unauthorized"), {
        response: { status: 401, data: { error: { errors: [] } } },
      }),
    );
    const r = await svc().createEvent(input());
    expect(r.created).toBe(true);
    expect(ops()).toEqual([
      "insert:none",
      "patch:all",
      "insert:none",
      "get:",
      "patch:all",
    ]);
    expect(invites()).toHaveLength(1);
    expect(ofType("calendar_event.created")).toHaveLength(1);
  });
});
