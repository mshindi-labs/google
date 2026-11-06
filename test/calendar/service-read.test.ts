import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionRevokedError,
  EventNotFoundError,
  EventNotManagedError,
  InvalidEventError,
  MissingScopeError,
} from "../../src/core/errors.js";
import { createGoogle } from "../../src/core/create-google.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { createCalendar } from "../../src/calendar/service.js";
import type { GEvent } from "../../src/calendar/transport.js";
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
let g: ReturnType<typeof createGoogle>;
let cal: FakeCalendar;
let connId: string;

const connect = async (
  services: ("gmail" | "calendar")[],
  identity: typeof careers = careers,
) => {
  const { url } = await g.oauth.createAuthUrl({
    tenantId: "t1",
    actorId: "u1",
    services,
  });
  const { code, state } = fake.consent(url, identity);
  return (await g.oauth.handleCallback({ code, state })).connection;
};

const svc = (transport: FakeCalendar | object = cal) =>
  createCalendar(g, {
    transport: transport as FakeCalendar,
    sleep: async () => {},
    random: () => 0,
  });

const D = (s: string) => new Date(s);
const window = {
  start: D("2030-01-07T00:00:00Z"),
  end: D("2030-01-08T00:00:00Z"),
};
const base = () => ({
  tenantId: "t1",
  connectionId: connId,
  actorId: "u1",
  attendees: ["Ann@Example.com", "bob@example.com"],
  window,
});

beforeEach(async () => {
  store = new InMemoryStore();
  fake = new FakeGoogleOAuth();
  events = [];
  g = createGoogle({
    store,
    keyProvider: new LocalKeyProvider(),
    callbackUrl: "https://hrms.io/cb",
    oauthGateway: fake,
    onEvent: (e) => {
      events.push(e);
    },
    logger: { warn: () => {}, error: () => {} },
  });
  await g.clients.configure({ tenantId: "t1", ...cfg });
  connId = (await connect(["gmail", "calendar"])).id;
  events.length = 0;
  cal = new FakeCalendar();
});

describe("scopes", () => {
  it("gmail-only connection → MissingScopeError before any transport call", async () => {
    const gmailOnly = (
      await connect(["gmail"], {
        sub: "s2",
        email: "hr@sunculture.io",
        hd: "sunculture.io",
        name: "HR",
      })
    ).id;
    await expect(
      svc().getAvailability({ ...base(), connectionId: gmailOnly }),
    ).rejects.toBeInstanceOf(MissingScopeError);
    expect(cal.calls).toHaveLength(0);
  });
});

describe("getAvailability", () => {
  it("normalizes keys, maps notFound, and treats missing as unknown/error", async () => {
    cal.setFreeBusy("bob@example.com", { error: "notFound" });
    const r = await svc().getAvailability(base());
    expect(Object.keys(r)).toEqual(["ann@example.com", "bob@example.com"]);
    expect(r["ann@example.com"]).toEqual({ status: "ok", busy: [] });
    expect(r["bob@example.com"]).toEqual({
      status: "unknown",
      reason: "not_found",
    });
    const missing = {
      freeBusy: async () => ({}),
    };
    const r2 = await svc(missing).getAvailability(base());
    expect(r2["ann@example.com"]).toEqual({
      status: "unknown",
      reason: "error",
    });
  });

  it("maps forbidden → no_access", async () => {
    cal.setFreeBusy("ann@example.com", { error: "forbidden" });
    const r = await svc().getAvailability(base());
    expect(r["ann@example.com"]).toEqual({
      status: "unknown",
      reason: "no_access",
    });
  });

  it("clips to the window, sorts and merges overlapping busy", async () => {
    cal.setFreeBusy("ann@example.com", [
      { start: "2030-01-07T11:00:00Z", end: "2030-01-07T12:00:00Z" },
      { start: "2030-01-07T09:00:00Z", end: "2030-01-07T10:30:00Z" },
      { start: "2030-01-07T10:00:00Z", end: "2030-01-07T11:00:00Z" },
      { start: "2030-01-06T20:00:00Z", end: "2030-01-07T01:00:00Z" },
    ]);
    const r = await svc().getAvailability(base());
    expect(r["ann@example.com"]).toEqual({
      status: "ok",
      busy: [
        { start: D("2030-01-07T00:00:00Z"), end: D("2030-01-07T01:00:00Z") },
        { start: D("2030-01-07T09:00:00Z"), end: D("2030-01-07T12:00:00Z") },
      ],
    });
  });

  it("emits no audit events", async () => {
    await svc().getAvailability(base());
    expect(events).toEqual([]);
  });

  it("rejects invalid input", async () => {
    await expect(
      svc().getAvailability({ ...base(), attendees: [] }),
    ).rejects.toBeInstanceOf(InvalidEventError);
  });
});

describe("suggestSlots", () => {
  const wh = {
    timeZone: "UTC",
    days: { mon: [{ start: "09:00", end: "17:00" }] },
  };
  it("unknown attendee → no slots, lists unknownAttendees", async () => {
    cal.setFreeBusy("bob@example.com", { error: "notFound" });
    const r = await svc().suggestSlots({
      ...base(),
      durationMinutes: 30,
      workingHours: wh,
    });
    expect(r).toEqual({ slots: [], unknownAttendees: ["bob@example.com"] });
  });

  it("returns slots avoiding busy time", async () => {
    cal.setFreeBusy("ann@example.com", [
      { start: "2030-01-07T09:00:00Z", end: "2030-01-07T16:30:00Z" },
    ]);
    const r = await svc().suggestSlots({
      ...base(),
      durationMinutes: 30,
      workingHours: wh,
      minNoticeMinutes: 0,
    });
    expect(r.slots[0]).toEqual({
      start: D("2030-01-07T16:30:00Z"),
      end: D("2030-01-07T17:00:00Z"),
    });
  });
});

describe("getEvent", () => {
  const stamped = (tenant: string): GEvent => ({
    id: "e1",
    status: "confirmed",
    summary: "Interview",
    location: "HQ",
    start: { dateTime: "2030-01-07T10:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2030-01-07T11:00:00Z", timeZone: "UTC" },
    attendees: [
      { email: "careers@sunculture.io", organizer: true, self: true },
      { email: "ann@example.com", responseStatus: "needsAction" },
    ],
    extendedProperties: {
      private: { mshindiGoogle: "v1", mshindiTenant: tenant },
    },
    updated: "2030-01-01T00:00:00Z",
  });
  const ids = () => ({ tenantId: "t1", connectionId: connId, eventId: "e1" });

  it("returns a view of a managed event", async () => {
    cal.events.set("e1", stamped("t1"));
    const v = await svc().getEvent(ids());
    expect(v).toMatchObject({
      eventId: "e1",
      title: "Interview",
      meeting: { type: "in_person", location: "HQ" },
      attendees: [
        {
          email: "ann@example.com",
          displayName: null,
          optional: false,
          response: "needs_action",
        },
      ],
    });
    expect(v.start).toEqual(D("2030-01-07T10:00:00Z"));
  });

  it("maps Meet conference data", async () => {
    const e = stamped("t1");
    delete e.location;
    e.conferenceData = {
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [
        { entryPointType: "video", uri: "https://meet.google.com/x" },
      ],
    };
    cal.events.set("e1", e);
    expect((await svc().getEvent(ids())).meeting).toEqual({
      type: "google_meet",
      meetUrl: "https://meet.google.com/x",
    });
  });

  it("unstamped event → EventNotManagedError", async () => {
    const e = stamped("t1");
    delete e.extendedProperties;
    cal.events.set("e1", e);
    await expect(svc().getEvent(ids())).rejects.toBeInstanceOf(
      EventNotManagedError,
    );
  });

  it("another tenant's stamp → EventNotManagedError", async () => {
    cal.events.set("e1", stamped("t2"));
    await expect(svc().getEvent(ids())).rejects.toBeInstanceOf(
      EventNotManagedError,
    );
  });

  it("missing event → EventNotFoundError", async () => {
    await expect(svc().getEvent(ids())).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
  });

  it("validates ids", async () => {
    await expect(
      svc().getEvent({ ...ids(), eventId: "" }),
    ).rejects.toMatchObject({ field: "eventId" });
  });
});

describe("401 handling", () => {
  const unauth = () =>
    Object.assign(new Error("unauth"), { response: { status: 401 } });

  it("401 twice → ConnectionRevokedError and revoked status", async () => {
    const freeBusy = vi.fn(async () => {
      throw unauth();
    });
    await expect(
      svc({ freeBusy }).getAvailability(base()),
    ).rejects.toBeInstanceOf(ConnectionRevokedError);
    expect(freeBusy).toHaveBeenCalledTimes(2);
    const rec = await store.getConnection("t1", connId);
    expect(rec!.status).toBe("revoked");
    expect(events.map((e) => e.type)).toEqual(["connection.revoked"]);
  });

  it("401 then success after refresh", async () => {
    let n = 0;
    const freeBusy = vi.fn(async () => {
      if (n++ === 0) throw unauth();
      return {
        "ann@example.com": { busy: [], errors: [] },
        "bob@example.com": { busy: [], errors: [] },
      };
    });
    const r = await svc({ freeBusy }).getAvailability(base());
    expect(r["ann@example.com"]!.status).toBe("ok");
    expect(freeBusy).toHaveBeenCalledTimes(2);
  });
});
