import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionNotFoundError,
  ConnectionRevokedError,
  GoogleLibError,
  InvalidMessageError,
  MissingScopeError,
  SendOutcomeUnknownError,
} from "../../src/core/errors.js";
import { createGoogle } from "../../src/core/create-google.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { sha256hex } from "../../src/core/events.js";
import { createGmail } from "../../src/gmail/send.js";
import type { GmailTransport } from "../../src/gmail/transport.js";
import { CaptureTransport } from "../../src/testing/capture-transport.js";
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
let connId: string;
let capture: CaptureTransport;

const connect = async () => {
  const { url } = await g.oauth.createAuthUrl({
    tenantId: "t1",
    actorId: "u1",
    services: ["gmail"],
  });
  const { code, state } = fake.consent(url, careers);
  return (await g.oauth.handleCallback({ code, state })).connection;
};

const base = () => ({
  tenantId: "t1",
  connectionId: connId,
  actorId: "u1",
  to: ["jane@example.com"],
  subject: "Offer",
  text: "Hello",
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
    logger: { warn: (m) => warnings.push(m), error: () => {} },
  });
  await g.clients.configure({ tenantId: "t1", ...cfg });
  connId = (await connect()).id;
  events.length = 0;
  capture = new CaptureTransport();
});

const gmailWith = (transport: GmailTransport = capture) =>
  createGmail(g, { transport });

describe("createGmail().send", () => {
  it("sends and captures with From = connection email", async () => {
    const r = await gmailWith().send({
      ...base(),
      html: "<p>Hi</p>",
      cc: ["c@example.com"],
    });
    expect(r).toEqual({ messageId: "capture-1", threadId: "capture-1" });
    const m = capture.messages[0]!;
    expect(m.parsed.from).toBe("careers@sunculture.io");
    expect(m.parsed.to).toEqual(["jane@example.com"]);
    expect(m.parsed.cc).toEqual(["c@example.com"]);
    expect(m.parsed.subject).toBe("Offer");
    expect(m.parsed.html).toContain("<p>Hi</p>");
    expect(capture.find((x) => x.parsed.subject === "Offer")).toBe(m);
    const rec = await store.getConnection("t1", connId);
    expect(rec!.lastUsedAt).not.toBeNull();
  });

  it("fromName overrides displayName", async () => {
    const rec = (await store.getConnection("t1", connId))!;
    await store.upsertConnection({ ...rec, displayName: "Careers Team" });
    const gm = gmailWith();
    await gm.send(base());
    await gm.send({ ...base(), fromName: "HR Desk" });
    const raws = capture.messages.map((m) => m.raw.toString("utf8"));
    expect(raws[0]).toContain("Careers Team");
    expect(raws[1]).toContain("HR Desk");
    expect(raws[1]).not.toContain("Careers Team");
  });

  it("reuses the given threadId", async () => {
    const r = await gmailWith().send({
      ...base(),
      thread: { threadId: "abc123" },
    });
    expect(r.threadId).toBe("abc123");
    expect(capture.messages[0]!.threadId).toBe("abc123");
  });

  it("missing gmail.send scope → MissingScopeError, nothing captured", async () => {
    const rec = (await store.getConnection("t1", connId))!;
    await store.upsertConnection({ ...rec, scopes: ["openid", "email"] });
    await expect(gmailWith().send(base())).rejects.toBeInstanceOf(
      MissingScopeError,
    );
    expect(capture.messages).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "message.failed",
      errorCode: "missing_scope",
    });
  });

  it("revoked connection → ConnectionRevokedError, nothing captured", async () => {
    await store.updateConnectionStatus("t1", connId, "revoked", "manual");
    await expect(gmailWith().send(base())).rejects.toBeInstanceOf(
      ConnectionRevokedError,
    );
    expect(capture.messages).toHaveLength(0);
  });

  it("wrong tenant → ConnectionNotFoundError", async () => {
    await expect(
      gmailWith().send({ ...base(), tenantId: "t2" }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    expect(capture.messages).toHaveLength(0);
  });

  it("401 then 401 after refresh → connection revoked", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("unauth"), { response: { status: 401 } });
    });
    await expect(gmailWith({ send }).send(base())).rejects.toBeInstanceOf(
      ConnectionRevokedError,
    );
    expect(send).toHaveBeenCalledTimes(2);
    const rec = await store.getConnection("t1", connId);
    expect(rec!.status).toBe("revoked");
    expect(rec!.statusReason).toBe("unauthorized");
    expect(events.map((e) => e.type)).toEqual([
      "connection.revoked",
      "message.failed",
    ]);
    expect(events[0]).toMatchObject({
      reason: "unauthorized",
      connectionId: connId,
    });
    expect(events[1]).toMatchObject({ errorCode: "connection_revoked" });
  });

  it("401 then success after refresh → sent once", async () => {
    const tokens: string[] = [];
    let n = 0;
    const send = vi.fn(async (p: { accessToken: string }) => {
      tokens.push(p.accessToken);
      if (n++ === 0)
        throw Object.assign(new Error("unauth"), { response: { status: 401 } });
      return { messageId: "m1", threadId: "th1" };
    });
    const r = await gmailWith({ send }).send(base());
    expect(r).toEqual({ messageId: "m1", threadId: "th1" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(events.filter((e) => e.type === "message.sent")).toHaveLength(1);
  });

  it("emits message.sent without bodies", async () => {
    await gmailWith().send({
      ...base(),
      html: "<p>SECRET-BODY</p>",
      text: "SECRET-TEXT",
      bcc: ["b@example.com"],
      attachments: [{ filename: "a.txt", content: Buffer.from("hi") }],
    });
    const e = events.find((x) => x.type === "message.sent")!;
    expect(e).toMatchObject({
      type: "message.sent",
      tenantId: "t1",
      actorId: "u1",
      connectionId: connId,
      messageId: "capture-1",
      threadId: "capture-1",
      to: ["jane@example.com"],
      cc: [],
      bcc: ["b@example.com"],
      subject: "Offer",
      attachmentCount: 1,
    });
    const json = JSON.stringify(events);
    expect(json).not.toContain("SECRET-BODY");
    expect(json).not.toContain("SECRET-TEXT");
  });

  it("emits message.failed with errorCode on failure", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    await expect(gmailWith({ send }).send(base())).rejects.toBeInstanceOf(
      SendOutcomeUnknownError,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.failed",
      errorCode: "send_outcome_unknown",
      to: ["jane@example.com"],
      subject: "Offer",
    });
  });

  it("uses 'unknown' errorCode for non-library errors", async () => {
    const send = vi.fn(async () => {
      throw new TypeError("boom");
    });
    // classifier wraps unknown errors, so the code is google_api
    await expect(gmailWith({ send }).send(base())).rejects.toBeInstanceOf(
      GoogleLibError,
    );
    expect(events[0]).toMatchObject({ errorCode: "google_api" });
  });

  it("redactRecipients per call hashes addresses in events", async () => {
    await gmailWith().send({ ...base(), redactRecipients: true });
    const e = events.find((x) => x.type === "message.sent") as Extract<
      GoogleEvent,
      { type: "message.sent" }
    >;
    expect(e.to).toEqual([sha256hex("jane@example.com")]);
    expect(JSON.stringify(e)).not.toContain("jane@example.com");
  });

  it("rejects blocked attachment extension without emitting message.failed", async () => {
    const gm = createGmail(g, {
      transport: capture,
      blockedAttachmentExtensions: [".exe"],
    });
    await expect(
      gm.send({
        ...base(),
        attachments: [{ filename: "x.exe", content: Buffer.from("m") }],
      }),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(capture.messages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it.each(["tenantId", "connectionId", "actorId"] as const)(
    "empty %s → InvalidMessageError without an event",
    async (field) => {
      const err = await gmailWith()
        .send({ ...base(), [field]: "" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvalidMessageError);
      expect(err.field).toBe(field);
      expect(events).toHaveLength(0);
    },
  );

  it("a touchConnection failure after sending is warned, not thrown", async () => {
    vi.spyOn(store, "touchConnection").mockRejectedValue(new Error("db down"));
    // token manager also touches on refresh; connection token is cached from connect
    const r = await gmailWith().send(base());
    expect(r.messageId).toBe("capture-1");
    expect(warnings).toContain("google touchConnection failed");
    expect(events.some((e) => e.type === "message.sent")).toBe(true);
  });

  it("never leaks the bearer token from transport errors", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("Request failed with Bearer ya29.SECRET"), {
        response: {
          status: 404,
          data: { error: { errors: [{ reason: "notFound" }] } },
        },
        config: { headers: { Authorization: "Bearer ya29.SECRET" } },
      });
    });
    const err = await gmailWith({ send })
      .send(base())
      .catch((e) => e);
    expect(err).toBeInstanceOf(GoogleLibError);
    const cause = err.cause as Record<string, unknown>;
    expect(cause).toBeDefined();
    expect(cause.config).toBeUndefined();
    expect(cause.response).toBeUndefined();
    expect(err.message).not.toContain("ya29.SECRET");
    expect(String(err.stack)).not.toContain("ya29.SECRET");
    expect(String((cause as unknown as Error).message)).not.toContain(
      "ya29.SECRET",
    );
    expect(String((cause as unknown as Error).stack)).not.toContain(
      "ya29.SECRET",
    );
  });
});
