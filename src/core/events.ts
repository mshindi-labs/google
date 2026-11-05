import { createHash } from "node:crypto";
import type { CredentialStore } from "./store.js";
import type { Logger } from "./types.js";

export type GoogleEvent =
  | {
      type: "oauth_client.configured" | "oauth_client.rotated";
      tenantId: string;
      actorId: string;
      clientIdChanged: boolean;
      at: Date;
    }
  | {
      type: "connection.created" | "connection.scopes_added";
      tenantId: string;
      actorId: string;
      connectionId: string;
      email: string;
      scopes: string[];
      at: Date;
    }
  | {
      type: "connection.revoked";
      tenantId: string;
      connectionId: string;
      reason: string;
      at: Date;
    }
  | {
      type: "connection.disconnected";
      tenantId: string;
      actorId: string;
      connectionId: string;
      googleRevoke: "ok" | "failed";
      at: Date;
    }
  | {
      type: "message.sent";
      tenantId: string;
      actorId: string;
      connectionId: string;
      messageId: string;
      threadId: string;
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      attachmentCount: number;
      at: Date;
    }
  | {
      type: "message.failed";
      tenantId: string;
      actorId: string;
      connectionId: string;
      errorCode: string;
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      at: Date;
    };

export type Emit = (
  e: GoogleEvent,
  perCall?: { redactRecipients?: boolean },
) => Promise<void>;

/** sha256 of the trimmed, lowercased address, as lowercase hex. */
export function sha256hex(address: string): string {
  return createHash("sha256")
    .update(address.trim().toLowerCase(), "utf8")
    .digest("hex");
}

function redactRecipients(e: GoogleEvent): GoogleEvent {
  if (e.type !== "message.sent" && e.type !== "message.failed") return e;
  return {
    ...e,
    to: e.to.map(sha256hex),
    cc: e.cc.map(sha256hex),
    bcc: e.bcc.map(sha256hex),
  };
}

/** Never throws: handler and audit-store failures are logged without the payload. */
export function createEmitter(opts: {
  onEvent?: (e: GoogleEvent) => void | Promise<void>;
  store: CredentialStore;
  logger?: Logger;
  redactRecipients: boolean;
}): Emit {
  const fail = (type: string): void => {
    try {
      opts.logger?.error("google event handler failed", { type });
    } catch {
      // logging must never break the caller
    }
  };
  return async (event, perCall) => {
    const redact = perCall?.redactRecipients ?? opts.redactRecipients;
    const e = redact ? redactRecipients(event) : event;
    try {
      await opts.onEvent?.(e);
    } catch {
      fail(e.type);
    }
    try {
      await opts.store.insertAuditEvent?.(e);
    } catch {
      fail(e.type);
    }
  };
}
