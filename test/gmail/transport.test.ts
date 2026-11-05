import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn(), gmail: vi.fn() }));
vi.mock("@googleapis/gmail", () => ({
  gmail: (...a: unknown[]) => {
    h.gmail(...a);
    return { users: { messages: { send: h.send } } };
  },
}));

import { SendOutcomeUnknownError } from "../../src/core/errors.js";
import {
  UPLOAD_THRESHOLD_BYTES,
  createGmailApiTransport,
} from "../../src/gmail/transport.js";

beforeEach(() => {
  h.send.mockReset();
  h.gmail.mockReset();
  h.send.mockResolvedValue({ data: { id: "m1", threadId: "t1" } });
});

describe("createGmailApiTransport", () => {
  it("exposes the 5 MiB threshold", () => {
    expect(UPLOAD_THRESHOLD_BYTES).toBe(5_242_880);
  });

  it("uses raw for ≤5 MiB and media upload above", async () => {
    const t = createGmailApiTransport();
    const small = Buffer.alloc(UPLOAD_THRESHOLD_BYTES, 97);
    await t.send({ accessToken: "tok", raw: small, threadId: null });
    const a = h.send.mock.calls[0]![0];
    expect(a.userId).toBe("me");
    expect(a.requestBody).toEqual({ raw: small.toString("base64url") });
    expect(a.media).toBeUndefined();

    const big = Buffer.alloc(UPLOAD_THRESHOLD_BYTES + 1, 98);
    await t.send({ accessToken: "tok", raw: big, threadId: null });
    const b = h.send.mock.calls[1]![0];
    expect(b.requestBody).toEqual({});
    expect(b.media.mimeType).toBe("message/rfc822");
    expect(b.media.body).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const c of b.media.body) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
  });

  it("passes threadId", async () => {
    const t = createGmailApiTransport();
    await t.send({
      accessToken: "tok",
      raw: Buffer.from("x"),
      threadId: "th9",
    });
    expect(h.send.mock.calls[0]![0].requestBody.threadId).toBe("th9");
    await t.send({
      accessToken: "tok",
      raw: Buffer.alloc(UPLOAD_THRESHOLD_BYTES + 1),
      threadId: "th9",
    });
    expect(h.send.mock.calls[1]![0].requestBody).toEqual({ threadId: "th9" });
  });

  it("builds the client with the access token", async () => {
    await createGmailApiTransport().send({
      accessToken: "tok",
      raw: Buffer.from("x"),
      threadId: null,
    });
    const arg = h.gmail.mock.calls[0]![0];
    expect(arg.version).toBe("v1");
    expect((await arg.auth.getAccessToken()).token).toBe("tok");
  });

  it("maps the response to { messageId: data.id, threadId: data.threadId }", async () => {
    await expect(
      createGmailApiTransport().send({
        accessToken: "tok",
        raw: Buffer.from("x"),
        threadId: null,
      }),
    ).resolves.toEqual({ messageId: "m1", threadId: "t1" });
  });

  it("treats a 200 without threadId as success (request threadId, else id)", async () => {
    h.send.mockResolvedValue({ data: { id: "m1" } });
    const t = createGmailApiTransport();
    await expect(
      t.send({ accessToken: "tok", raw: Buffer.from("x"), threadId: "th9" }),
    ).resolves.toEqual({ messageId: "m1", threadId: "th9" });
    await expect(
      t.send({ accessToken: "tok", raw: Buffer.from("x"), threadId: null }),
    ).resolves.toEqual({ messageId: "m1", threadId: "m1" });
  });

  it("a 200 without an id is SendOutcomeUnknownError", async () => {
    h.send.mockResolvedValue({ data: { threadId: "t1" } });
    await expect(
      createGmailApiTransport().send({
        accessToken: "tok",
        raw: Buffer.from("x"),
        threadId: null,
      }),
    ).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });
});
