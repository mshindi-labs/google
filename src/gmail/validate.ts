import { posix } from "node:path";
import { sanitizeDisplayName } from "../core/connections.js";
import { normalizeEmail } from "../core/address.js";
import { InvalidMessageError } from "../core/errors.js";

export type Address = string | { name: string; address: string };
export type Attachment = {
  filename: string;
  content: Buffer | NodeJS.ReadableStream;
  contentType?: string;
};
export type SendInput = {
  tenantId: string;
  connectionId: string;
  actorId: string;
  fromName?: string;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address;
  subject: string;
  html?: string;
  text?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  thread?: { threadId?: string; inReplyTo?: string; references?: string[] };
  redactRecipients?: boolean;
};
export type MailAddress = { name: string | null; address: string };
export type NormalizedMessage = {
  fromName: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress | null;
  subject: string;
  html: string | null;
  text: string | null;
  attachments: {
    filename: string;
    content: Buffer | NodeJS.ReadableStream;
    contentType: string | null;
  }[];
  headers: Record<string, string>;
  thread: {
    threadId: string | null;
    inReplyTo: string | null;
    references: string[];
  };
};

const LINE_BREAKS = /[\r\n\0]/;
const HEADER_NAME = /^X-[A-Za-z0-9-]+$/;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const MSG_ID = /^[\x21-\x7e]+$/;
const THREAD_ID = /^[A-Za-z0-9_-]+$/;

function fail(field: string): never {
  throw new InvalidMessageError(field);
}

/** Rejects CR, LF and NUL; returns the value unchanged. */
function clean(value: unknown, field: string): string {
  if (typeof value !== "string" || LINE_BREAKS.test(value)) fail(field);
  return value;
}

/** Requires a string that fully matches `pattern`; returns it unchanged. */
function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(field);
  return value;
}

function parseAddress(raw: unknown, field: string): string {
  const v = normalizeEmail(raw);
  if (v === null) fail(field);
  return v;
}

function parseMailAddress(a: Address, path: string): MailAddress {
  if (typeof a === "string")
    return { name: null, address: parseAddress(a, path) };
  if (a === null || typeof a !== "object") fail(path);
  const name = clean(a.name, `${path}.name`);
  return {
    name: name === "" ? null : name,
    address: parseAddress(a.address, `${path}.address`),
  };
}

function parseList(list: Address[] | undefined, key: string): MailAddress[] {
  return (list ?? []).map((a, i) => parseMailAddress(a, `${key}[${i}]`));
}

function normalizeExt(e: string): string {
  return e.trim().replace(/^\./, "").toLowerCase();
}

function cleanFilename(
  raw: string,
  path: string,
  blocked: Set<string>,
): string {
  clean(raw, path);
  const base = posix.basename(raw.replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (name === "" || name === "." || name === "..") name = "attachment";
  // Windows drops trailing dots and spaces, so "cv.exe." runs as "cv.exe".
  const effective = name.replace(/[.\s]+$/, "");
  const dot = effective.lastIndexOf(".");
  if (dot >= 0 && blocked.has(effective.slice(dot + 1).toLowerCase())) {
    fail(path);
  }
  return name;
}

export function validateSendInput(
  input: SendInput,
  opts: { blockedExtensions: string[] },
): NormalizedMessage {
  const blocked = new Set(
    opts.blockedExtensions.map(normalizeExt).filter((e) => e !== ""),
  );

  const to = parseList(input.to, "to");
  const cc = parseList(input.cc, "cc");
  const bcc = parseList(input.bcc, "bcc");
  if (to.length + cc.length + bcc.length === 0) fail("to");
  const replyTo =
    input.replyTo === undefined
      ? null
      : parseMailAddress(input.replyTo, "replyTo");

  const subject = clean(input.subject, "subject");
  if (!input.html && !input.text) fail("html");

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    // Caller-supplied name: JSON-escape (no raw CR/LF) and cap before it reaches the error.
    const field = `headers[${JSON.stringify(name).slice(0, 64)}]`;
    if (!HEADER_NAME.test(name)) fail(field);
    headers[name] = clean(value, field);
  }

  const attachments = (input.attachments ?? []).map((a, i) => {
    const p = `attachments[${i}]`;
    const filename = cleanFilename(a.filename, `${p}.filename`, blocked);
    let contentType: string | null = null;
    if (a.contentType !== undefined) {
      clean(a.contentType, `${p}.contentType`);
      if (!CONTENT_TYPE.test(a.contentType)) fail(`${p}.contentType`);
      contentType = a.contentType;
    }
    return { filename, content: a.content, contentType };
  });

  const t = input.thread ?? {};
  const thread = {
    threadId:
      t.threadId === undefined
        ? null
        : matching(t.threadId, THREAD_ID, "thread.threadId"),
    inReplyTo:
      t.inReplyTo === undefined
        ? null
        : matching(t.inReplyTo, MSG_ID, "thread.inReplyTo"),
    references: (t.references ?? []).map((r, i) =>
      matching(r, MSG_ID, `thread.references[${i}]`),
    ),
  };

  return {
    fromName: sanitizeDisplayName(input.fromName ?? null),
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html: input.html ? input.html : null,
    text: input.text ? input.text : null,
    attachments,
    headers,
    thread,
  };
}
