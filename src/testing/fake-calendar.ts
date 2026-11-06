import type {
  CalendarTransport,
  GEvent,
  GoogleSendUpdates,
} from "../calendar/transport.js";

type Op = "freeBusy" | "insert" | "get" | "patch" | "delete";
type Busy = { start: string; end: string };
type ConferenceBehaviour = "success" | "pending" | "failure";

export type FakeNotification = {
  eventId: string;
  kind: "invite" | "update" | "cancel";
  to: string[];
};

export type FakeCall = {
  op: string;
  sendUpdates?: string;
  emails?: string[];
};

const clone = <T>(v: T): T => structuredClone(v);

function httpError(status: number, reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    response: {
      status,
      data: { error: { code: status, message, errors: [{ reason }] } },
    },
  });
}

const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** In-memory Google Calendar transport for tests (single `primary` calendar). */
export class FakeCalendar implements CalendarTransport {
  readonly events = new Map<string, GEvent>();
  readonly calls: FakeCall[] = [];
  readonly notifications: FakeNotification[] = [];

  private readonly organizerEmail: string;
  private readonly busy = new Map<string, Busy[] | { error: string }>();
  private readonly failures = new Map<
    Op,
    { error: unknown; afterApply: boolean }[]
  >();
  private conference: ConferenceBehaviour = "success";
  private pendingGets = 1;
  private readonly pendingLeft = new Map<string, number>();
  private etagN = 0;
  private meetN = 0;

  constructor(opts: { organizerEmail?: string } = {}) {
    this.organizerEmail = opts.organizerEmail ?? "organizer@example.com";
  }

  setFreeBusy(
    email: string,
    busy: Busy[] | { error: "notFound" | "forbidden" },
  ): void {
    this.busy.set(email, busy);
  }

  setConferenceBehaviour(b: ConferenceBehaviour, pendingGets = 1): void {
    this.conference = b;
    this.pendingGets = pendingGets;
  }

  failNext(
    op: Op,
    error: unknown,
    opts: { afterApply?: boolean; times?: number } = {},
  ): void {
    const q = this.failures.get(op) ?? [];
    for (let i = 0; i < (opts.times ?? 1); i++) {
      q.push({ error, afterApply: opts.afterApply ?? false });
    }
    this.failures.set(op, q);
  }

  async freeBusy(p: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    emails: string[];
  }): Promise<Record<string, { busy: Busy[]; errors: { reason: string }[] }>> {
    this.calls.push({ op: "freeBusy", emails: [...p.emails] });
    return this.run("freeBusy", () => {
      const out: Record<
        string,
        { busy: Busy[]; errors: { reason: string }[] }
      > = {};
      for (const email of p.emails) {
        const cfg = this.busy.get(email);
        if (cfg === undefined) out[email] = { busy: [], errors: [] };
        else if (Array.isArray(cfg))
          out[email] = { busy: clone(cfg), errors: [] };
        else out[email] = { busy: [], errors: [{ reason: cfg.error }] };
      }
      return out;
    });
  }

  async insert(p: {
    accessToken: string;
    event: GEvent;
    sendUpdates: GoogleSendUpdates;
    conferenceDataVersion: 0 | 1;
  }): Promise<GEvent> {
    this.calls.push({ op: "insert", sendUpdates: p.sendUpdates });
    return this.run("insert", () => {
      if (this.events.has(p.event.id)) {
        throw httpError(
          409,
          "duplicate",
          "The requested identifier already exists.",
        );
      }
      const ev = clone(p.event);
      ev.status ??= "confirmed";
      this.applyConference(ev, p.conferenceDataVersion);
      this.stamp(ev);
      this.events.set(ev.id, ev);
      if (p.sendUpdates !== "none" && (ev.attendees?.length ?? 0) > 0) {
        this.notify(ev, "invite", p.sendUpdates);
      }
      return clone(ev);
    });
  }

  async get(p: { accessToken: string; eventId: string }): Promise<GEvent> {
    this.calls.push({ op: "get" });
    return this.run("get", () => {
      const ev = this.events.get(p.eventId);
      if (!ev) throw httpError(404, "notFound", "Not Found");
      const reqId = ev.conferenceData?.createRequest?.requestId;
      const key = `${ev.id}:${reqId ?? ""}`;
      const left = this.pendingLeft.get(key);
      if (left !== undefined) {
        if (left > 0) {
          this.pendingLeft.set(key, left - 1);
        } else {
          this.pendingLeft.delete(key);
          this.completeConference(ev);
        }
      }
      return clone(ev);
    });
  }

  async patch(p: {
    accessToken: string;
    eventId: string;
    patch: Partial<GEvent>;
    sendUpdates: GoogleSendUpdates;
    conferenceDataVersion: 0 | 1;
    ifMatch?: string;
  }): Promise<GEvent> {
    this.calls.push({ op: "patch", sendUpdates: p.sendUpdates });
    return this.run("patch", () => {
      const ev = this.events.get(p.eventId);
      if (!ev) throw httpError(404, "notFound", "Not Found");
      this.checkIfMatch(ev, p.ifMatch);
      const before = clone(ev);
      const patch = clone(p.patch);
      const priv = patch.extendedProperties?.private;
      delete patch.extendedProperties;
      const { conferenceData, ...rest } = patch;
      Object.assign(ev, rest);
      if (priv) {
        ev.extendedProperties = {
          ...ev.extendedProperties,
          private: { ...ev.extendedProperties?.private, ...priv },
        };
      }
      if (conferenceData === null) {
        delete ev.conferenceData;
      } else if (conferenceData !== undefined) {
        ev.conferenceData = conferenceData;
        this.applyConference(ev, p.conferenceDataVersion);
      }
      this.stamp(ev);

      if (p.sendUpdates !== "none") {
        const changed = (
          ["start", "end", "location", "attendees"] as const
        ).some((k) => JSON.stringify(before[k]) !== JSON.stringify(ev[k]));
        const flipped =
          before.extendedProperties?.private?.mshindiInvite === "pending" &&
          ev.extendedProperties?.private?.mshindiInvite === "sent";
        if (flipped) this.notify(ev, "invite", p.sendUpdates);
        else if (changed) this.notify(ev, "update", p.sendUpdates);
      }
      return clone(ev);
    });
  }

  async delete(p: {
    accessToken: string;
    eventId: string;
    sendUpdates: GoogleSendUpdates;
    ifMatch?: string;
  }): Promise<void> {
    this.calls.push({ op: "delete", sendUpdates: p.sendUpdates });
    return this.run("delete", () => {
      const ev = this.events.get(p.eventId);
      if (!ev) throw httpError(404, "notFound", "Not Found");
      this.checkIfMatch(ev, p.ifMatch);
      if (ev.status === "cancelled") {
        throw httpError(410, "deleted", "Resource has been deleted");
      }
      ev.status = "cancelled";
      this.stamp(ev);
      if (p.sendUpdates !== "none") this.notify(ev, "cancel", p.sendUpdates);
    });
  }

  clear(): void {
    this.events.clear();
    this.calls.length = 0;
    this.notifications.length = 0;
  }

  private run<T>(op: Op, fn: () => T): T {
    const f = this.failures.get(op)?.shift();
    if (f && !f.afterApply) throw f.error;
    const result = fn();
    if (f) throw f.error;
    return result;
  }

  /** Google answers 412 when `If-Match` names an etag other than the current one. */
  private checkIfMatch(ev: GEvent, ifMatch: string | undefined): void {
    if (ifMatch !== undefined && ifMatch !== ev.etag) {
      throw httpError(412, "conditionNotMet", "Precondition Failed");
    }
  }

  /** Every applied mutation gets a new etag, as on Google. */
  private stamp(ev: GEvent): void {
    ev.etag = `"fake-etag-${++this.etagN}"`;
    ev.htmlLink = `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(ev.id)}`;
    ev.updated = new Date().toISOString();
  }

  private notify(
    ev: GEvent,
    kind: FakeNotification["kind"],
    mode: GoogleSendUpdates,
  ): void {
    const org = domainOf(this.organizerEmail);
    const to = (ev.attendees ?? [])
      .flatMap((a) => (a.email ? [a.email] : []))
      .filter((e) => mode !== "externalOnly" || domainOf(e) !== org);
    if (to.length > 0) this.notifications.push({ eventId: ev.id, kind, to });
  }

  /** Resolves a `createRequest` the way Google does; ignored when version is 0. */
  private applyConference(ev: GEvent, version: 0 | 1): void {
    const cd = ev.conferenceData;
    if (!cd?.createRequest) return;
    if (version !== 1) {
      delete cd.createRequest;
      if (Object.keys(cd).length === 0) delete ev.conferenceData;
      return;
    }
    cd.conferenceSolution = { key: { type: "hangoutsMeet" } };
    cd.createRequest.status = {
      statusCode: this.conference === "success" ? "success" : this.conference,
    };
    if (this.conference === "success") this.addEntryPoint(ev);
    if (this.conference === "pending") {
      this.pendingLeft.set(
        `${ev.id}:${cd.createRequest.requestId ?? ""}`,
        this.pendingGets,
      );
    }
  }

  private completeConference(ev: GEvent): void {
    const req = ev.conferenceData?.createRequest;
    if (!req) return;
    req.status = { statusCode: "success" };
    this.addEntryPoint(ev);
    this.stamp(ev);
  }

  private addEntryPoint(ev: GEvent): void {
    const cd = ev.conferenceData;
    if (!cd) return;
    cd.entryPoints = [
      {
        entryPointType: "video",
        uri: `https://meet.google.com/fake-${++this.meetN}`,
      },
    ];
  }
}
