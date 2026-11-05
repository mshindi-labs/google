import { loadPeer } from "../core/peer.js";
import type { GmailTransport } from "../gmail/transport.js";

export type CapturedMessage = {
  raw: Buffer;
  threadId: string | null;
  parsed: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    html: string | null;
    text: string | null;
    attachments: { filename: string; contentType: string; size: number }[];
  };
};

type AddrObj = { value: { address?: string }[] };
type Parsed = {
  from?: AddrObj;
  to?: AddrObj | AddrObj[];
  cc?: AddrObj | AddrObj[];
  bcc?: AddrObj | AddrObj[];
  subject?: string;
  html?: string | false;
  text?: string;
  attachments: { filename?: string; contentType: string; size: number }[];
};
type MailParser = { simpleParser(raw: Buffer): Promise<Parsed> };

const addresses = (a: AddrObj | AddrObj[] | undefined): string[] =>
  (a === undefined ? [] : Array.isArray(a) ? a : [a])
    .flatMap((o) => o.value)
    .flatMap((v) => (v.address ? [v.address] : []));

/** In-memory Gmail transport for tests: records and parses every message. */
export class CaptureTransport implements GmailTransport {
  readonly messages: CapturedMessage[] = [];
  private n = 0;

  async send(p: {
    accessToken: string;
    raw: Buffer;
    threadId: string | null;
  }): Promise<{ messageId: string; threadId: string }> {
    const mod = await loadPeer<Partial<MailParser> & { default?: MailParser }>(
      "mailparser",
    );
    const { simpleParser } = (
      mod.simpleParser ? mod : mod.default
    ) as MailParser;
    const parsed = await simpleParser(p.raw);
    const id = `capture-${++this.n}`;
    this.messages.push({
      raw: p.raw,
      threadId: p.threadId,
      parsed: {
        from: addresses(parsed.from)[0] ?? "",
        to: addresses(parsed.to),
        cc: addresses(parsed.cc),
        bcc: addresses(parsed.bcc),
        subject: parsed.subject ?? "",
        html:
          parsed.html === false || parsed.html === undefined
            ? null
            : parsed.html,
        text: parsed.text ?? null,
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename ?? "",
          contentType: a.contentType,
          size: a.size,
        })),
      },
    });
    return { messageId: id, threadId: p.threadId ?? id };
  }

  clear(): void {
    this.messages.length = 0;
  }

  find(pred: (m: CapturedMessage) => boolean): CapturedMessage | undefined {
    return this.messages.find(pred);
  }
}
