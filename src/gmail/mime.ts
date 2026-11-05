import { randomUUID } from "node:crypto";
import { MessageTooLargeError } from "../core/errors.js";
import { loadPeer } from "../core/peer.js";
import type { MailAddress, NormalizedMessage } from "./validate.js";

/** Gmail's attachment limit: 25 MiB in total. */
export const MAX_ATTACHMENT_BYTES = 26_214_400;

type NodemailerAddress = { name?: string; address: string };
type MailComposerCtor = new (options: Record<string, unknown>) => {
  compile(): {
    keepBcc: boolean;
    build(): Promise<Buffer>;
  };
};
type HtmlToText = {
  convert(html: string, options?: { wordwrap?: number | false }): string;
};

/** CommonJS peers surface as `{ default: module }` under ESM dynamic import. */
function unwrap<T>(mod: unknown): T {
  const m = mod as { default?: unknown };
  return (m.default ?? mod) as T;
}

function toAddress(a: MailAddress): NodemailerAddress {
  return a.name === null
    ? { address: a.address }
    : { name: a.name, address: a.address };
}

/** Reads a stream into memory, destroying it as soon as the budget is blown. */
async function readLimited(
  stream: NodeJS.ReadableStream,
  alreadyCounted: number,
): Promise<{ data: Buffer; total: number }> {
  const chunks: Buffer[] = [];
  let total = alreadyCounted;
  try {
    for await (const chunk of stream) {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      total += buf.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        throw new MessageTooLargeError(total, MAX_ATTACHMENT_BYTES);
      }
      chunks.push(buf);
    }
  } catch (err) {
    (stream as { destroy?: () => void }).destroy?.();
    throw err;
  }
  return { data: Buffer.concat(chunks), total };
}

/**
 * Turns a validated message into the raw RFC 5322 bytes Gmail sends.
 * Throws MessageTooLargeError before building when attachments exceed 25 MiB.
 */
export async function buildMime(
  msg: NormalizedMessage,
  from: { name: string | null; address: string },
): Promise<Buffer> {
  try {
    // Buffers first: cheap, and fails before any stream is touched.
    let total = 0;
    for (const a of msg.attachments) {
      if (Buffer.isBuffer(a.content)) total += a.content.length;
    }
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new MessageTooLargeError(total, MAX_ATTACHMENT_BYTES);
    }

    // Peers load before any stream is read, so a missing peer fails fast.
    const htmlToText =
      msg.text === null && msg.html !== null
        ? unwrap<HtmlToText>(
            await loadPeer<unknown>("html-to-text", "html-to-text"),
          )
        : null;
    const MailComposer = unwrap<MailComposerCtor>(
      await loadPeer<unknown>(
        "nodemailer/lib/mail-composer/index.js",
        "nodemailer",
      ),
    );

    const attachments: Record<string, unknown>[] = [];
    for (const a of msg.attachments) {
      let content: Buffer;
      if (Buffer.isBuffer(a.content)) {
        content = a.content;
      } else {
        const read = await readLimited(a.content, total);
        content = read.data;
        total = read.total;
      }
      attachments.push({
        filename: a.filename,
        content,
        ...(a.contentType === null ? {} : { contentType: a.contentType }),
      });
    }

    let text = msg.text;
    if (htmlToText !== null && msg.html !== null) {
      text = htmlToText.convert(msg.html, { wordwrap: 78 });
    }

    const domain = from.address.split("@").pop() as string;
    const options: Record<string, unknown> = {
      from: toAddress(from),
      to: msg.to.map(toAddress),
      cc: msg.cc.map(toAddress),
      bcc: msg.bcc.map(toAddress),
      subject: msg.subject,
      messageId: `<${randomUUID()}@${domain}>`,
      headers: msg.headers,
      attachments,
    };
    if (msg.replyTo) options.replyTo = toAddress(msg.replyTo);
    if (msg.html !== null) options.html = msg.html;
    if (text !== null) options.text = text;
    if (msg.thread.inReplyTo !== null) options.inReplyTo = msg.thread.inReplyTo;
    if (msg.thread.references.length > 0)
      options.references = msg.thread.references;

    const mail = new MailComposer(options).compile();
    // Gmail's API routes on the raw Bcc header and strips it before delivery.
    mail.keepBcc = true;
    return mail.build();
  } finally {
    // Release any stream attachment we did not (fully) consume.
    for (const a of msg.attachments) {
      if (!Buffer.isBuffer(a.content)) {
        (a.content as { destroy?: () => void }).destroy?.();
      }
    }
  }
}
