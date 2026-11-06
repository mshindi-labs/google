import { describe, expect, it } from "vitest";
import { classifyCalendarError } from "../../src/calendar/retry.js";
import type { GEvent } from "../../src/calendar/transport.js";
import { FakeCalendar } from "../../src/testing/index.js";

const T = "tok";
const ev = (over: Partial<GEvent> = {}): GEvent => ({
  id: "evt1",
  summary: "Hi",
  start: { dateTime: "2026-11-10T10:00:00Z" },
  end: { dateTime: "2026-11-10T11:00:00Z" },
  attendees: [{ email: "a@example.com" }, { email: "b@other.org" }],
  extendedProperties: {
    private: { mshindiGoogle: "v1", mshindiInvite: "pending" },
  },
  ...over,
});
const ins = (
  f: FakeCalendar,
  e: GEvent,
  su: "all" | "externalOnly" | "none" = "all",
  v: 0 | 1 = 0,
) =>
  f.insert({
    accessToken: T,
    event: e,
    sendUpdates: su,
    conferenceDataVersion: v,
  });
const status = async (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: { response: { status: number } }) => e.response.status,
  );

describe("FakeCalendar", () => {
  it("inserts a deep copy and generates metadata", async () => {
    const f = new FakeCalendar();
    const input = ev();
    const out = await ins(f, input);
    expect(out.etag).toBeTruthy();
    expect(out.htmlLink).toBeTruthy();
    expect(out.updated).toBeTruthy();
    input.summary = "mutated";
    out.summary = "mutated2";
    expect(f.events.get("evt1")?.summary).toBe("Hi");
    const got = await f.get({ accessToken: T, eventId: "evt1" });
    got.summary = "x";
    expect(f.events.get("evt1")?.summary).toBe("Hi");
  });

  it("409 on reused id, including cancelled; classified duplicate", async () => {
    const f = new FakeCalendar();
    await ins(f, ev());
    expect(await status(ins(f, ev()))).toBe(409);
    await f.delete({ accessToken: T, eventId: "evt1", sendUpdates: "none" });
    expect(await status(ins(f, ev()))).toBe(409);
    const err = await ins(f, ev()).catch((e) => e);
    expect(classifyCalendarError(err).kind).toBe("duplicate");
  });

  it("get: 404 unknown; cancelled keeps extendedProperties", async () => {
    const f = new FakeCalendar();
    expect(await status(f.get({ accessToken: T, eventId: "nope" }))).toBe(404);
    await ins(f, ev());
    await f.delete({ accessToken: T, eventId: "evt1", sendUpdates: "none" });
    const g = await f.get({ accessToken: T, eventId: "evt1" });
    expect(g.status).toBe("cancelled");
    expect(g.extendedProperties?.private?.mshindiGoogle).toBe("v1");
  });

  it("delete: 410 when already cancelled, 404 unknown", async () => {
    const f = new FakeCalendar();
    await ins(f, ev());
    await f.delete({ accessToken: T, eventId: "evt1", sendUpdates: "none" });
    const p = f.delete({
      accessToken: T,
      eventId: "evt1",
      sendUpdates: "none",
    });
    expect(await status(p)).toBe(410);
    expect(
      await status(
        f.delete({ accessToken: T, eventId: "zz", sendUpdates: "none" }),
      ),
    ).toBe(404);
    const err = await f
      .delete({ accessToken: T, eventId: "evt1", sendUpdates: "none" })
      .catch((e) => e);
    expect(classifyCalendarError(err).kind).toBe("gone");
  });

  it("notifications: invite on insert, none when sendUpdates none", async () => {
    const f = new FakeCalendar();
    await ins(f, ev());
    await ins(f, ev({ id: "e2" }), "none");
    expect(f.notifications).toEqual([
      { eventId: "evt1", kind: "invite", to: ["a@example.com", "b@other.org"] },
    ]);
  });

  it("externalOnly notifies only other-domain attendees", async () => {
    const f = new FakeCalendar({ organizerEmail: "me@example.com" });
    await ins(f, ev(), "externalOnly");
    expect(f.notifications[0]?.to).toEqual(["b@other.org"]);
  });

  it("no attendees: no invite", async () => {
    const f = new FakeCalendar();
    await ins(f, ev({ attendees: undefined }));
    expect(f.notifications).toEqual([]);
  });

  it("patch merges fields and private props key-wise", async () => {
    const f = new FakeCalendar();
    await ins(f, ev(), "none");
    const out = await f.patch({
      accessToken: T,
      eventId: "evt1",
      patch: {
        summary: "New",
        extendedProperties: { private: { mshindiKey: "k" } },
      },
      sendUpdates: "all",
      conferenceDataVersion: 0,
    });
    expect(out.summary).toBe("New");
    expect(out.attendees).toHaveLength(2);
    expect(out.extendedProperties?.private).toEqual({
      mshindiGoogle: "v1",
      mshindiInvite: "pending",
      mshindiKey: "k",
    });
    expect(f.notifications).toEqual([]);
    expect(
      await status(
        f.patch({
          accessToken: T,
          eventId: "x",
          patch: {},
          sendUpdates: "none",
          conferenceDataVersion: 0,
        }),
      ),
    ).toBe(404);
  });

  it("patch emits update for time/location/attendees changes", async () => {
    const f = new FakeCalendar();
    await ins(f, ev(), "none");
    await f.patch({
      accessToken: T,
      eventId: "evt1",
      patch: { location: "Room 1" },
      sendUpdates: "all",
      conferenceDataVersion: 0,
    });
    expect(f.notifications).toEqual([
      { eventId: "evt1", kind: "update", to: ["a@example.com", "b@other.org"] },
    ]);
    await f.patch({
      accessToken: T,
      eventId: "evt1",
      patch: { location: "Room 2" },
      sendUpdates: "none",
      conferenceDataVersion: 0,
    });
    expect(f.notifications).toHaveLength(1);
  });

  it("patch flipping mshindiInvite pending to sent emits invite", async () => {
    const f = new FakeCalendar();
    await ins(f, ev(), "none");
    await f.patch({
      accessToken: T,
      eventId: "evt1",
      patch: { extendedProperties: { private: { mshindiInvite: "sent" } } },
      sendUpdates: "all",
      conferenceDataVersion: 0,
    });
    expect(f.notifications).toEqual([
      { eventId: "evt1", kind: "invite", to: ["a@example.com", "b@other.org"] },
    ]);
  });

  it("delete emits cancel unless none", async () => {
    const f = new FakeCalendar();
    await ins(f, ev(), "none");
    await f.delete({ accessToken: T, eventId: "evt1", sendUpdates: "all" });
    expect(f.notifications).toEqual([
      { eventId: "evt1", kind: "cancel", to: ["a@example.com", "b@other.org"] },
    ]);
  });

  it("conference success adds meet entry point; version 0 ignores request", async () => {
    const f = new FakeCalendar();
    const cd = {
      createRequest: {
        requestId: "r",
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
    const out = await ins(f, ev({ conferenceData: cd }), "none", 1);
    expect(out.conferenceData?.createRequest?.status?.statusCode).toBe(
      "success",
    );
    expect(out.conferenceData?.conferenceSolution?.key?.type).toBe(
      "hangoutsMeet",
    );
    expect(out.conferenceData?.entryPoints?.[0]?.uri).toMatch(
      /^https:\/\/meet\.google\.com\/fake-/,
    );
    const out0 = await ins(f, ev({ id: "e0", conferenceData: cd }), "none", 0);
    expect(out0.conferenceData?.createRequest).toBeUndefined();
    expect(out0.conferenceData?.entryPoints).toBeUndefined();
  });

  it("conference pending flips to success after pendingGets; failure stays failed", async () => {
    const f = new FakeCalendar();
    const cd = { createRequest: { requestId: "r" } };
    f.setConferenceBehaviour("pending", 2);
    const out = await ins(f, ev({ conferenceData: cd }), "none", 1);
    expect(out.conferenceData?.createRequest?.status?.statusCode).toBe(
      "pending",
    );
    expect(out.conferenceData?.entryPoints).toBeUndefined();
    const g = () => f.get({ accessToken: T, eventId: "evt1" });
    expect((await g()).conferenceData?.createRequest?.status?.statusCode).toBe(
      "pending",
    );
    expect((await g()).conferenceData?.createRequest?.status?.statusCode).toBe(
      "pending",
    );
    const last = await g();
    expect(last.conferenceData?.createRequest?.status?.statusCode).toBe(
      "success",
    );
    expect(last.conferenceData?.entryPoints?.[0]?.entryPointType).toBe("video");
    f.setConferenceBehaviour("failure");
    const bad = await ins(f, ev({ id: "e2", conferenceData: cd }), "none", 1);
    expect(bad.conferenceData?.createRequest?.status?.statusCode).toBe(
      "failure",
    );
    expect(bad.conferenceData?.entryPoints).toBeUndefined();
  });

  it("patch conferenceData null removes it; patch with createRequest adds meet", async () => {
    const f = new FakeCalendar();
    await ins(f, ev(), "none");
    const p = await f.patch({
      accessToken: T,
      eventId: "evt1",
      patch: { conferenceData: { createRequest: { requestId: "r" } } },
      sendUpdates: "none",
      conferenceDataVersion: 1,
    });
    expect(p.conferenceData?.entryPoints).toHaveLength(1);
    const q = await f.patch({
      accessToken: T,
      eventId: "evt1",
      patch: { conferenceData: null },
      sendUpdates: "none",
      conferenceDataVersion: 1,
    });
    expect(q.conferenceData).toBeUndefined();
  });

  it("freeBusy returns configured busy and errors; records emails", async () => {
    const f = new FakeCalendar();
    f.setFreeBusy("a@x.com", [
      { start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z" },
    ]);
    f.setFreeBusy("b@x.com", { error: "notFound" });
    f.setFreeBusy("c@x.com", { error: "forbidden" });
    const r = await f.freeBusy({
      accessToken: T,
      timeMin: "a",
      timeMax: "b",
      emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
    });
    expect(r["a@x.com"]?.busy).toHaveLength(1);
    expect(r["b@x.com"]?.errors).toEqual([{ reason: "notFound" }]);
    expect(r["c@x.com"]?.errors).toEqual([{ reason: "forbidden" }]);
    expect(r["d@x.com"]).toEqual({ busy: [], errors: [] });
    expect(f.calls[0]).toMatchObject({
      op: "freeBusy",
      emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
    });
  });

  it("failNext throws before applying by default, with times", async () => {
    const f = new FakeCalendar();
    const boom = new Error("boom");
    f.failNext("insert", boom, { times: 2 });
    await expect(ins(f, ev())).rejects.toBe(boom);
    await expect(ins(f, ev())).rejects.toBe(boom);
    expect(f.events.size).toBe(0);
    await ins(f, ev());
    expect(f.events.size).toBe(1);
  });

  it("failNext afterApply leaves the event stored and notifies", async () => {
    const f = new FakeCalendar();
    const timeout = Object.assign(new Error("t"), { code: "ETIMEDOUT" });
    f.failNext("insert", timeout, { afterApply: true });
    await expect(ins(f, ev())).rejects.toBe(timeout);
    expect(f.events.has("evt1")).toBe(true);
    expect(f.notifications).toHaveLength(1);
  });

  it("failNext queues per op", async () => {
    const f = new FakeCalendar();
    await ins(f, ev(), "none");
    f.failNext("get", new Error("g"));
    await ins(f, ev({ id: "e2" }), "none");
    await expect(f.get({ accessToken: T, eventId: "evt1" })).rejects.toThrow(
      "g",
    );
    await expect(
      f.get({ accessToken: T, eventId: "evt1" }),
    ).resolves.toBeTruthy();
  });
});
