import { hostname } from "node:os";
import { PassThrough, Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { MessageTooLargeError } from "../../src/core/errors.js";
import { buildMime, MAX_ATTACHMENT_BYTES } from "../../src/gmail/mime.js";
import type { NormalizedMessage } from "../../src/gmail/validate.js";

const UNICODE_BREAKS = new RegExp("[\\u2028\\u2029\\u0085]");
const FROM = { name: "SunCulture Careers", address: "careers@sunculture.io" };
const msg = (patch: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  fromName: null,
  to: [{ name: null, address: "jane@example.com" }],
  cc: [],
  bcc: [],
  replyTo: null,
  subject: "Hello",
  html: null,
  text: "body",
  attachments: [],
  headers: {},
  thread: { threadId: null, inReplyTo: null, references: [] },
  ...patch,
});
const rawOf = async (m: NormalizedMessage, from = FROM) =>
  (await buildMime(m, from)).toString("utf8");
const headerLines = (raw: string, name: string) =>
  raw
    .split("\r\n\r\n")[0]!
    .split("\r\n")
    .filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));

describe("buildMime", () => {
  it("sets From to the connection address with display name", async () => {
    const parsed = await simpleParser(await buildMime(msg(), FROM));
    expect(parsed.from?.value[0]).toEqual({
      name: "SunCulture Careers",
      address: "careers@sunculture.io",
    });
  });

  it("omits the display name when null", async () => {
    const parsed = await simpleParser(
      await buildMime(msg(), { name: null, address: "careers@sunculture.io" }),
    );
    expect(parsed.from?.value[0]).toEqual({
      name: "",
      address: "careers@sunculture.io",
    });
  });

  it("generates a text part from html", async () => {
    const parsed = await simpleParser(
      await buildMime(
        msg({ html: "<p>Hello <b>world</b></p>", text: null }),
        FROM,
      ),
    );
    expect(parsed.text).toContain("Hello world");
    expect(parsed.html).toContain("<b>world</b>");
  });

  it("keeps a provided text part instead of converting", async () => {
    const parsed = await simpleParser(
      await buildMime(msg({ html: "<p>HTML</p>", text: "custom" }), FROM),
    );
    expect(parsed.text?.trim()).toBe("custom");
  });

  it("encodes non-ASCII subject and names (RFC 2047)", async () => {
    const m = msg({
      subject: "Ofa ya kazi ✅",
      to: [{ name: "Wanjirũ", address: "w@example.com" }],
    });
    const buf = await buildMime(m, { name: "Wanjirũ", address: FROM.address });
    expect(buf.toString("utf8")).toMatch(/^Subject: =\?UTF-8\?/m);
    const parsed = await simpleParser(buf);
    expect(parsed.subject).toBe("Ofa ya kazi ✅");
    expect(parsed.from?.value[0]?.name).toBe("Wanjirũ");
    expect(parsed.to).toMatchObject({ value: [{ name: "Wanjirũ" }] });
  });

  it("includes Bcc header for Gmail routing", async () => {
    const raw = await rawOf(
      msg({ bcc: [{ name: null, address: "b@example.com" }] }),
    );
    expect(headerLines(raw, "Bcc")).toEqual(["Bcc: b@example.com"]);
  });

  it("passes cc and reply-to", async () => {
    const parsed = await simpleParser(
      await buildMime(
        msg({
          cc: [{ name: "C", address: "c@example.com" }],
          replyTo: { name: "R", address: "r@example.com" },
        }),
        FROM,
      ),
    );
    expect(parsed.cc).toMatchObject({ value: [{ address: "c@example.com" }] });
    expect(parsed.replyTo).toMatchObject({
      value: [{ name: "R", address: "r@example.com" }],
    });
  });

  it("sets In-Reply-To and References", async () => {
    const parsed = await simpleParser(
      await buildMime(
        msg({
          thread: {
            threadId: "t1",
            inReplyTo: "<a@x.io>",
            references: ["<a@x.io>", "<b@x.io>"],
          },
        }),
        FROM,
      ),
    );
    expect(parsed.inReplyTo).toBe("<a@x.io>");
    expect(parsed.references).toEqual(["<a@x.io>", "<b@x.io>"]);
  });

  it("passes custom X- headers", async () => {
    const raw = await rawOf(msg({ headers: { "X-Job-Id": "42" } }));
    expect(headerLines(raw, "X-Job-Id")).toEqual(["X-Job-ID: 42"]);
  });

  it("includes attachments with content type", async () => {
    const parsed = await simpleParser(
      await buildMime(
        msg({
          attachments: [
            {
              filename: "offer.pdf",
              content: Buffer.from("%PDF-1.4 hi"),
              contentType: "application/pdf",
            },
            {
              filename: "streamed.txt",
              content: Readable.from([Buffer.from("streamed data")]),
              contentType: null,
            },
          ],
        }),
        FROM,
      ),
    );
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "offer.pdf",
      contentType: "application/pdf",
    });
    expect(parsed.attachments[0]?.content.toString()).toBe("%PDF-1.4 hi");
    expect(parsed.attachments[1]?.content.toString()).toBe("streamed data");
  });

  it("rejects attachments over 25 MiB before building", async () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(26_214_400);
    const big = Buffer.alloc(26_214_401);
    await expect(
      buildMime(
        msg({
          attachments: [
            { filename: "big.bin", content: big, contentType: null },
          ],
        }),
        FROM,
      ),
    ).rejects.toMatchObject({
      name: expect.any(String),
      code: "message_too_large",
      limit: 26_214_400,
      bytes: 26_214_401,
    });
  });

  it("sums several buffers against the limit", async () => {
    const half = Buffer.alloc(13_107_201);
    const a = { filename: "a", content: half, contentType: null };
    const err = await buildMime(
      msg({ attachments: [a, { ...a, filename: "b" }] }),
      FROM,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageTooLargeError);
  });

  it("rejects an oversized stream without buffering it all", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    let pushed = 0;
    const stream = new Readable({
      read() {
        pushed += 1;
        this.push(pushed > 1000 ? null : chunk);
      },
    });
    const err = (await buildMime(
      msg({
        attachments: [
          { filename: "s.bin", content: stream, contentType: null },
        ],
      }),
      FROM,
    ).catch((e: unknown) => e)) as MessageTooLargeError;
    expect(err).toBeInstanceOf(MessageTooLargeError);
    expect(err.limit).toBe(26_214_400);
    expect(err.bytes).toBeGreaterThan(26_214_400);
    expect(err.bytes).toBeLessThan(26_214_400 + 2 * 1024 * 1024 + 1);
    expect(stream.destroyed).toBe(true);
    expect(pushed).toBeLessThan(100);
  });

  it("counts buffer attachments toward the stream budget", async () => {
    const stream = new PassThrough();
    stream.end(Buffer.alloc(1024));
    const err = await buildMime(
      msg({
        attachments: [
          {
            filename: "a",
            content: Buffer.alloc(26_214_400),
            contentType: null,
          },
          { filename: "s", content: stream, contentType: null },
        ],
      }),
      FROM,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageTooLargeError);
    expect((err as MessageTooLargeError).bytes).toBe(26_214_400 + 1024);
  });

  it("raw output never contains a bare LF line injection", async () => {
    const raw = await rawOf(
      msg({
        subject: "Hi there",
        bcc: [{ name: null, address: "b@example.com" }],
        headers: { "X-Note": "a b" },
      }),
    );
    expect(raw).not.toMatch(/(?<!\r)\n/);
    expect(raw.match(/^Bcc:/gim)).toHaveLength(1);
  });

  it("sets an explicit Message-ID on the sender domain, no X-Mailer, no hostname", async () => {
    const raw = await rawOf(msg());
    const ids = headerLines(raw, "Message-ID");
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^Message-ID: <[0-9a-f-]{36}@sunculture\.io>$/i);
    expect(raw).not.toMatch(/^X-Mailer:/im);
    expect(raw.toLowerCase()).not.toContain(hostname().toLowerCase());
  });

  it("keeps U+2028/U+2029/U+0085 in subject and names on one header line", async () => {
    const evil = "A\u2028B\u2029C\u0085D";
    const buf = await buildMime(
      msg({
        subject: `${evil}: Bcc: x@evil.io`,
        to: [{ name: evil, address: "w@example.com" }],
      }),
      { name: evil, address: FROM.address },
    );
    const raw = buf.toString("utf8");
    expect(headerLines(raw, "Subject")).toHaveLength(1);
    expect(headerLines(raw, "Subject")[0]).toMatch(/^Subject: =\?UTF-8\?/);
    const head = raw.split("\r\n\r\n")[0]!;
    // Every header line is a known header or a folded continuation.
    for (const l of head.split("\r\n")) {
      expect(l).toMatch(
        /^(?:[ \t]|(?:From|To|Subject|Message-ID|Date|MIME-Version|Content-Type|Content-Transfer-Encoding):)/,
      );
    }
    expect(head).not.toMatch(UNICODE_BREAKS);
    const parsed = await simpleParser(buf);
    expect(parsed.subject).toBe(`${evil}: Bcc: x@evil.io`);
    expect(parsed.bcc).toBeUndefined();
  });

  it("does not let U+2028 in thread ids create a header line", async () => {
    const buf = await buildMime(
      msg({
        thread: {
          threadId: null,
          inReplyTo: "<a\u2028Bcc: x@evil.io@x.io>",
          references: [
            "<b\u2029X-Evil: 1@x.io>",
            "<c\u0085Bcc: y@evil.io@x.io>",
          ],
        },
      }),
      FROM,
    );
    const head = buf.toString("utf8").split("\r\n\r\n")[0]!;
    expect(headerLines(head, "In-Reply-To")).toHaveLength(1);
    expect(headerLines(head, "References")).toHaveLength(1);
    expect(headerLines(head, "Bcc")).toHaveLength(0);
    expect(headerLines(head, "X-Evil")).toHaveLength(0);
    for (const l of head.split("\r\n")) {
      expect(l).toMatch(/^(?:[ \t]|[A-Za-z][A-Za-z0-9-]*:)/);
    }
    expect(head).not.toMatch(UNICODE_BREAKS);
  });

  it("does not let U+2028 in a custom header value create a header line", async () => {
    const raw = await rawOf(
      msg({ headers: { "X-Note": "a\u2028Bcc: x@evil.io" } }),
    );
    const head = raw.split("\r\n\r\n")[0]!;
    expect(headerLines(head, "Bcc")).toHaveLength(0);
    expect(headerLines(head, "X-Note")).toHaveLength(1);
    expect(head).not.toMatch(UNICODE_BREAKS);
  });
});
