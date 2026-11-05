import { Readable } from "node:stream";
import { OAuth2Client } from "google-auth-library";
import { GoogleApiError } from "../core/errors.js";
import { loadPeer } from "../core/peer.js";

/** Raw messages above this size go through the media upload endpoint. */
export const UPLOAD_THRESHOLD_BYTES = 5_242_880;

export interface GmailTransport {
  send(p: {
    accessToken: string;
    raw: Buffer;
    threadId: string | null;
  }): Promise<{ messageId: string; threadId: string }>;
}

type GmailModule = {
  gmail(opts: { version: "v1"; auth: unknown }): {
    users: {
      messages: {
        send(params: Record<string, unknown>): Promise<{
          data: { id?: string | null; threadId?: string | null };
        }>;
      };
    };
  };
};

/**
 * Sends through the Gmail API. Errors are thrown as-is (gaxios errors carry the
 * request config, including the bearer token); `send` classifies them and only
 * ever rethrows sanitized GoogleLibError instances.
 */
export function createGmailApiTransport(): GmailTransport {
  return {
    async send({ accessToken, raw, threadId }) {
      const mod = await loadPeer<
        Partial<GmailModule> & { default?: GmailModule }
      >("@googleapis/gmail");
      const { gmail } = (mod.gmail ? mod : mod.default) as GmailModule;
      const auth = new OAuth2Client();
      auth.setCredentials({ access_token: accessToken });
      const api = gmail({ version: "v1", auth });
      const thread = threadId === null ? {} : { threadId };
      const { data } =
        raw.length <= UPLOAD_THRESHOLD_BYTES
          ? await api.users.messages.send({
              userId: "me",
              requestBody: { raw: raw.toString("base64url"), ...thread },
            })
          : await api.users.messages.send({
              userId: "me",
              requestBody: { ...thread },
              media: { mimeType: "message/rfc822", body: Readable.from(raw) },
            });
      if (!data?.id || !data.threadId) {
        throw new GoogleApiError(200, "missing_message_id");
      }
      return { messageId: data.id, threadId: data.threadId };
    },
  };
}
