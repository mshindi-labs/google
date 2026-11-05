export { createGmail } from "./send.js";
export type { GmailOptions, SendResult } from "./send.js";
export {
  createGmailApiTransport,
  UPLOAD_THRESHOLD_BYTES,
} from "./transport.js";
export type { GmailTransport } from "./transport.js";
export { classifySendError, withSendRetry } from "./retry.js";
export type { SendErrorClass } from "./retry.js";
export { MAX_ATTACHMENT_BYTES } from "./mime.js";
export type { SendInput, Address, Attachment } from "./validate.js";
