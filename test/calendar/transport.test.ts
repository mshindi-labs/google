import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  query: vi.fn(),
  calendar: vi.fn(),
}));
vi.mock("@googleapis/calendar", () => ({
  calendar: (...a: unknown[]) => {
    h.calendar(...a);
    return {
      events: { insert: h.insert, get: h.get, patch: h.patch, delete: h.del },
      freebusy: { query: h.query },
    };
  },
}));

import { createCalendarApiTransport } from "../../src/calendar/transport.js";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
});

describe("createCalendarApiTransport", () => {
  it("builds the client with the access token", async () => {
    h.get.mockResolvedValue({ data: { id: "e1" } });
    await createCalendarApiTransport().get({
      accessToken: "tok",
      eventId: "e1",
    });
    const arg = h.calendar.mock.calls[0]![0];
    expect(arg.version).toBe("v3");
    expect((await arg.auth.getAccessToken()).token).toBe("tok");
  });

  it("insert passes calendarId, requestBody, sendUpdates, conferenceDataVersion", async () => {
    h.insert.mockResolvedValue({ data: { id: "e1" } });
    const event = { id: "e1", summary: "S" };
    const out = await createCalendarApiTransport().insert({
      accessToken: "t",
      event,
      sendUpdates: "externalOnly",
      conferenceDataVersion: 1,
    });
    expect(h.insert).toHaveBeenCalledWith({
      calendarId: "primary",
      requestBody: event,
      sendUpdates: "externalOnly",
      conferenceDataVersion: 1,
    });
    expect(out).toEqual({ id: "e1" });
  });

  it("get passes calendarId and eventId", async () => {
    h.get.mockResolvedValue({ data: { id: "e2" } });
    const out = await createCalendarApiTransport().get({
      accessToken: "t",
      eventId: "e2",
    });
    expect(h.get).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "e2",
    });
    expect(out).toEqual({ id: "e2" });
  });

  it("patch passes requestBody, sendUpdates, conferenceDataVersion", async () => {
    h.patch.mockResolvedValue({ data: { id: "e3" } });
    await createCalendarApiTransport().patch({
      accessToken: "t",
      eventId: "e3",
      patch: { summary: "N" },
      sendUpdates: "none",
      conferenceDataVersion: 0,
    });
    expect(h.patch).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "e3",
      requestBody: { summary: "N" },
      sendUpdates: "none",
      conferenceDataVersion: 0,
    });
  });

  it("patch sends If-Match only when ifMatch is given", async () => {
    h.patch.mockResolvedValue({ data: { id: "e3" } });
    const t = createCalendarApiTransport();
    const p = {
      accessToken: "t",
      eventId: "e3",
      patch: { summary: "N" },
      sendUpdates: "none" as const,
      conferenceDataVersion: 1 as const,
    };
    await t.patch({ ...p, ifMatch: '"etag-1"' });
    expect(h.patch).toHaveBeenLastCalledWith(expect.any(Object), {
      headers: { "If-Match": '"etag-1"' },
    });
    await t.patch(p);
    expect(h.patch.mock.lastCall).toHaveLength(1);
  });

  it("delete sends If-Match only when ifMatch is given", async () => {
    h.del.mockResolvedValue({ data: "" });
    const t = createCalendarApiTransport();
    const p = { accessToken: "t", eventId: "e4", sendUpdates: "none" as const };
    await t.delete({ ...p, ifMatch: '"etag-2"' });
    expect(h.del).toHaveBeenLastCalledWith(
      { calendarId: "primary", eventId: "e4", sendUpdates: "none" },
      { headers: { "If-Match": '"etag-2"' } },
    );
    await t.delete(p);
    expect(h.del.mock.lastCall).toHaveLength(1);
  });

  it("delete passes sendUpdates", async () => {
    h.del.mockResolvedValue({ data: "" });
    await expect(
      createCalendarApiTransport().delete({
        accessToken: "t",
        eventId: "e4",
        sendUpdates: "all",
      }),
    ).resolves.toBeUndefined();
    expect(h.del).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "e4",
      sendUpdates: "all",
    });
  });

  it("freeBusy sends items and reshapes per email, defaulting missing arrays", async () => {
    h.query.mockResolvedValue({
      data: {
        calendars: {
          "a@x.com": { busy: [{ start: "s", end: "e" }] },
          "b@x.com": { errors: [{ reason: "notFound" }] },
        },
      },
    });
    const out = await createCalendarApiTransport().freeBusy({
      accessToken: "t",
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
      emails: ["a@x.com", "b@x.com", "c@x.com"],
    });
    expect(h.query).toHaveBeenCalledWith({
      requestBody: {
        timeMin: "2026-01-01T00:00:00Z",
        timeMax: "2026-01-02T00:00:00Z",
        items: [{ id: "a@x.com" }, { id: "b@x.com" }, { id: "c@x.com" }],
      },
    });
    expect(out).toEqual({
      "a@x.com": { busy: [{ start: "s", end: "e" }], errors: [] },
      "b@x.com": { busy: [], errors: [{ reason: "notFound" }] },
    });
  });
});
