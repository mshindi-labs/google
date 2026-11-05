import type { GoogleCore } from "../core/create-google.js";
import { internals } from "../core/create-google.js";
import {
  ConnectionRevokedError,
  GoogleLibError,
  InvalidMessageError,
} from "../core/errors.js";
import { assertServiceScopes } from "../core/scopes.js";
import { buildMime } from "./mime.js";
import { SendUnauthorizedSignal, withSendRetry } from "./retry.js";
import { createGmailApiTransport } from "./transport.js";
import type { GmailTransport } from "./transport.js";
import { validateSendInput } from "./validate.js";
import type { SendInput } from "./validate.js";

export type GmailOptions = {
  blockedAttachmentExtensions?: string[];
  transport?: GmailTransport;
};

export type SendResult = { messageId: string; threadId: string };

export function createGmail(
  google: GoogleCore,
  opts: GmailOptions = {},
): { send(input: SendInput): Promise<SendResult> } {
  const transport = opts.transport ?? createGmailApiTransport();
  const blocked = opts.blockedAttachmentExtensions ?? [];

  return {
    async send(input) {
      const { store, tokens, emit, now, logger } = google[internals];
      for (const field of ["tenantId", "connectionId", "actorId"] as const) {
        if (typeof input[field] !== "string" || input[field] === "") {
          throw new InvalidMessageError(field);
        }
      }
      const { tenantId, connectionId, actorId } = input;
      const msg = validateSendInput(input, { blockedExtensions: blocked });
      const perCall =
        input.redactRecipients === undefined
          ? undefined
          : { redactRecipients: input.redactRecipients };
      const addrs = {
        to: msg.to.map((a) => a.address),
        cc: msg.cc.map((a) => a.address),
        bcc: msg.bcc.map((a) => a.address),
      };

      try {
        const first = await tokens.getAccessToken(tenantId, connectionId);
        const connection = first.connection;
        assertServiceScopes(connection.scopes, ["gmail"], {
          tenantId,
          connectionId,
        });
        const raw = await buildMime(msg, {
          name: input.fromName ?? connection.displayName,
          address: connection.email,
        });
        const attempt = (accessToken: string) =>
          withSendRetry(() =>
            transport.send({ accessToken, raw, threadId: msg.thread.threadId }),
          );

        let sent: SendResult;
        try {
          sent = await attempt(first.accessToken);
        } catch (err) {
          if (!(err instanceof SendUnauthorizedSignal)) throw err;
          const fresh = await tokens.getAccessToken(tenantId, connectionId, {
            forceRefresh: true,
          });
          try {
            sent = await attempt(fresh.accessToken);
          } catch (err2) {
            if (!(err2 instanceof SendUnauthorizedSignal)) throw err2;
            await store.updateConnectionStatus(
              tenantId,
              connectionId,
              "revoked",
              "unauthorized",
            );
            tokens.evict(connectionId);
            await emit({
              type: "connection.revoked",
              tenantId,
              connectionId,
              reason: "unauthorized",
              at: now(),
            });
            throw new ConnectionRevokedError("unauthorized", {
              tenantId,
              connectionId,
            });
          }
        }

        try {
          await store.touchConnection(tenantId, connectionId, now());
        } catch {
          try {
            logger?.warn("google touchConnection failed");
          } catch {
            // logging must never break the caller
          }
        }
        await emit(
          {
            type: "message.sent",
            tenantId,
            actorId,
            connectionId,
            messageId: sent.messageId,
            threadId: sent.threadId,
            ...addrs,
            subject: msg.subject,
            attachmentCount: msg.attachments.length,
            at: now(),
          },
          perCall,
        );
        return sent;
      } catch (err) {
        await emit(
          {
            type: "message.failed",
            tenantId,
            actorId,
            connectionId,
            errorCode: err instanceof GoogleLibError ? err.code : "unknown",
            ...addrs,
            subject: msg.subject,
            at: now(),
          },
          perCall,
        );
        throw err;
      }
    },
  };
}
