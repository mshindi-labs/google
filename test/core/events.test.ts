import { describe, expect, it, vi } from "vitest";
import { createEmitter, sha256hex } from "../../src/core/events.js";
import type { GoogleEvent } from "../../src/core/events.js";
import { InMemoryStore } from "../../src/testing/in-memory-store.js";

const sent = (): GoogleEvent => ({
  type: "message.sent",
  tenantId: "t1",
  actorId: "a1",
  connectionId: "c1",
  messageId: "m1",
  threadId: "th1",
  to: ["Jane@X.io"],
  cc: [" Bob@Y.io "],
  bcc: [],
  subject: "Hi",
  attachmentCount: 0,
  at: new Date(0),
});

const mkLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("createEmitter", () => {
  it("swallows onEvent errors and logs them", async () => {
    const logger = mkLogger();
    const emit = createEmitter({
      onEvent: () => {
        throw new Error("boom ya29.secret");
      },
      store: new InMemoryStore(),
      logger,
      redactRecipients: false,
    });
    await expect(emit(sent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("google event handler failed", {
      type: "message.sent",
    });
  });

  it("swallows async onEvent rejections", async () => {
    const logger = mkLogger();
    const emit = createEmitter({
      onEvent: async () => {
        throw new Error("x");
      },
      store: new InMemoryStore(),
      logger,
      redactRecipients: false,
    });
    await expect(emit(sent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("hashes recipients when redactRecipients", async () => {
    const onEvent = vi.fn();
    const emit = createEmitter({
      onEvent,
      store: new InMemoryStore(),
      redactRecipients: true,
    });
    await emit(sent());
    const e = onEvent.mock.calls[0]![0] as Extract<
      GoogleEvent,
      { type: "message.sent" }
    >;
    expect(e.to[0]).toBe(sha256hex("jane@x.io"));
    expect(e.cc[0]).toBe(sha256hex("bob@y.io"));
    expect(e.to[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("per-call redactRecipients overrides the global setting", async () => {
    const onEvent = vi.fn();
    const off = createEmitter({
      onEvent,
      store: new InMemoryStore(),
      redactRecipients: true,
    });
    await off(sent(), { redactRecipients: false });
    expect(onEvent.mock.calls[0]![0].to).toEqual(["Jane@X.io"]);

    const on = createEmitter({
      onEvent,
      store: new InMemoryStore(),
      redactRecipients: false,
    });
    await on(sent(), { redactRecipients: true });
    expect(onEvent.mock.calls[1]![0].to[0]).toBe(sha256hex("jane@x.io"));
  });

  it("leaves events without recipients untouched", async () => {
    const onEvent = vi.fn();
    const emit = createEmitter({
      onEvent,
      store: new InMemoryStore(),
      redactRecipients: true,
    });
    const e: GoogleEvent = {
      type: "connection.revoked",
      tenantId: "t1",
      connectionId: "c1",
      reason: "x",
      at: new Date(0),
    };
    await emit(e);
    expect(onEvent).toHaveBeenCalledWith(e);
  });

  it("writes to store.insertAuditEvent when present", async () => {
    const store = new InMemoryStore();
    const insertAuditEvent = vi.fn(async (_e: GoogleEvent) => {});
    (store as unknown as { insertAuditEvent: unknown }).insertAuditEvent =
      insertAuditEvent;
    const emit = createEmitter({ store, redactRecipients: true });
    await emit(sent());
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    const arg = insertAuditEvent.mock.calls[0]![0] as unknown as {
      to: string[];
    };
    expect(arg.to[0]).toBe(sha256hex("jane@x.io"));
  });

  it("still writes the audit event when onEvent fails, and logs store failures", async () => {
    const logger = mkLogger();
    const store = new InMemoryStore();
    const insertAuditEvent = vi.fn(async () => {
      throw new Error("db down");
    });
    (store as unknown as { insertAuditEvent: unknown }).insertAuditEvent =
      insertAuditEvent;
    const emit = createEmitter({
      onEvent: () => {
        throw new Error("x");
      },
      store,
      logger,
      redactRecipients: false,
    });
    await expect(emit(sent())).resolves.toBeUndefined();
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("hashes calendar attendees when redactRecipients", async () => {
    const seen: GoogleEvent[] = [];
    const emit = createEmitter({
      onEvent: (e) => void seen.push(e),
      store: new InMemoryStore(),
      redactRecipients: true,
    });
    await emit({
      type: "calendar_event.created",
      tenantId: "t1",
      actorId: "a1",
      connectionId: "c1",
      eventId: "e1",
      attendees: ["Ann@x.com"],
      title: "Sync",
      start: new Date(0),
      end: new Date(1),
      at: new Date(0),
    });
    expect(seen[0]).toMatchObject({ attendees: [sha256hex("ann@x.com")] });
  });
});
