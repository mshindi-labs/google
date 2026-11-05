import { describe, expect, it } from "vitest";
import { validateSendInput, type SendInput } from "../../src/gmail/validate.js";

const base: SendInput = {
  tenantId: "t",
  connectionId: "c",
  actorId: "a",
  to: ["j@a.io"],
  subject: "Hi",
  text: "body",
};
const opts = { blockedExtensions: ["exe", ".BAT"] };
const run = (patch: Partial<SendInput>) =>
  validateSendInput({ ...base, ...patch } as SendInput, opts);
const bad = (patch: Partial<SendInput>, field: string) =>
  expect(() => run(patch)).toThrow(
    expect.objectContaining({ code: "invalid_message", field }),
  );

describe("validateSendInput", () => {
  it.each([
    ["subject", { subject: "Hi\r\nBcc: x@evil.io" }, "subject"],
    [
      "to name",
      { to: [{ name: "Jane\nBcc: x@evil.io", address: "j@a.io" }] },
      "to[0].name",
    ],
    ["address", { to: ["j@a.io\r\nBcc:x@evil.io"] }, "to[0]"],
    [
      "object address",
      { to: ["ok@a.io", { name: "N", address: "j@a.io\n" }] },
      "to[1].address",
    ],
    ["cc", { cc: ["a\0@b.io"] }, "cc[0]"],
    ["bcc name", { bcc: [{ name: "x\r", address: "a@b.io" }] }, "bcc[0].name"],
    ["replyTo", { replyTo: "a@b.io\n" }, "replyTo"],
    [
      "replyTo name",
      { replyTo: { name: "a\n", address: "a@b.io" } },
      "replyTo.name",
    ],
    ["header value", { headers: { "X-App": "a\nb" } }, "headers.X-App"],
    [
      "filename",
      { attachments: [{ filename: "a\r\n.pdf", content: Buffer.from("x") }] },
      "attachments[0].filename",
    ],
    [
      "contentType crlf",
      {
        attachments: [
          {
            filename: "a.pdf",
            content: Buffer.from("x"),
            contentType: "a/b\n",
          },
        ],
      },
      "attachments[0].contentType",
    ],
    ["threadId", { thread: { threadId: "a\nb" } }, "thread.threadId"],
    ["inReplyTo", { thread: { inReplyTo: "<a>\r" } }, "thread.inReplyTo"],
    [
      "references",
      { thread: { references: ["<a@b>\r\nX: y"] } },
      "thread.references[0]",
    ],
  ])("rejects CR/LF/NUL in %s", (_l, patch, field) =>
    bad(patch as Partial<SendInput>, field),
  );

  it.each([
    "From",
    "Bcc",
    "Sender",
    "Return-Path",
    "DKIM-Signature",
    "Received",
    "X Bad",
  ])("rejects header %s", (h) =>
    bad({ headers: { [h]: "v" } }, `headers.${h}`),
  );
  it("accepts X- headers", () =>
    expect(run({ headers: { "X-App-Id": "1" } }).headers).toEqual({
      "X-App-Id": "1",
    }));

  it.each([
    "Jane <j@a.io>",
    "a@b",
    "a b@c.io",
    "a@@b.io",
    "a,b@c.io",
    "a@b.io;",
    '"a"@b.io',
    "(a)@b.io",
    "a@b.io\\",
    "",
    `${"a".repeat(250)}@b.io`,
  ])("rejects address %j", (a) => bad({ to: [a] }, "to[0]"));
  it("rejects bad object address with .address path", () =>
    bad({ to: [{ name: "N", address: "nope" }] }, "to[0].address"));

  it("lower-cases the domain only", () => {
    const m = run({
      to: [{ name: "Z", address: "Jane.Doe@Example.COM" }, "A@B.Io"],
    });
    expect(m.to).toEqual([
      { name: "Z", address: "Jane.Doe@example.com" },
      { name: null, address: "A@b.io" },
    ]);
  });

  it("requires a recipient", () => {
    bad({ to: [] }, "to");
    bad({ to: undefined }, "to");
    expect(run({ to: undefined, bcc: ["a@b.io"] }).bcc).toHaveLength(1);
  });
  it("requires html or text (empty counts as missing)", () => {
    bad({ text: undefined }, "html");
    bad({ text: "", html: "" }, "html");
    expect(run({ text: undefined, html: "<p>x</p>" }).html).toBe("<p>x</p>");
  });
  it("allows an empty subject", () =>
    expect(run({ subject: "" }).subject).toBe(""));

  it("strips path segments from filenames", () =>
    expect(
      run({
        attachments: [
          { filename: "..\\..\\etc/passwd.pdf", content: Buffer.from("x") },
        ],
      }).attachments[0]!.filename,
    ).toBe("passwd.pdf"));
  it("strips control chars and defaults empty filename", () => {
    const m = run({
      attachments: [
        { filename: "a\u0001b.pdf", content: Buffer.from("x") },
        { filename: "/", content: Buffer.from("x") },
      ],
    });
    expect(m.attachments.map((a) => a.filename)).toEqual([
      "ab.pdf",
      "attachment",
    ]);
  });
  it("blocks configured extensions case-insensitively, last extension only", () => {
    const f = (filename: string) =>
      run({ attachments: [{ filename, content: Buffer.from("x") }] });
    expect(() => f("CV.EXE")).toThrow(
      expect.objectContaining({ field: "attachments[0].filename" }),
    );
    expect(() => f("x.bat")).toThrow(
      expect.objectContaining({ field: "attachments[0].filename" }),
    );
    expect(() => f("cv.exe.pdf")).not.toThrow();
    expect(() => f("cv.pdf.exe")).toThrow();
  });
  it("validates contentType", () => {
    const f = (contentType: string) =>
      run({
        attachments: [
          { filename: "a.pdf", content: Buffer.from("x"), contentType },
        ],
      });
    expect(f("application/pdf").attachments[0]!.contentType).toBe(
      "application/pdf",
    );
    expect(() => f("application/pdf; x=y")).toThrow(
      expect.objectContaining({ field: "attachments[0].contentType" }),
    );
  });

  it("accepts non-ASCII names and subjects", () => {
    const m = run({
      fromName: "Wanjirũ Kamau",
      subject: "Ofa ya kazi ✅",
      to: [{ name: "Zoë Ñúñez", address: "zoe@x.io" }],
    });
    expect(m.subject).toBe("Ofa ya kazi ✅");
    expect(m.fromName).toBe("Wanjirũ Kamau");
    expect(m.to[0]!.name).toBe("Zoë Ñúñez");
  });
  it("caps and cleans fromName", () => {
    expect(run({ fromName: " A\u0000B\u0085 " }).fromName).toBe("AB");
    expect(run({ fromName: "x".repeat(150) }).fromName).toHaveLength(100);
    expect(run({ fromName: " \u0001 " }).fromName).toBeNull();
    expect(run({}).fromName).toBeNull();
  });

  it("normalizes defaults", () => {
    const m = run({});
    expect(m).toMatchObject({
      cc: [],
      bcc: [],
      replyTo: null,
      html: null,
      text: "body",
      attachments: [],
      headers: {},
      thread: { threadId: null, inReplyTo: null, references: [] },
    });
  });
});
