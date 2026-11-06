import { createHash } from "node:crypto";
import type { NormalizedEvent } from "./validate.js";

const B32HEX = "0123456789abcdefghijklmnopqrstuv";

/** RFC 4648 base32hex, lowercase, no padding. */
function base32hex(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32HEX[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Deterministic Google event id (`[a-v0-9]{32}`) for one
 * (tenant, organizer mailbox, idempotency key). Organizer case is ignored.
 */
export function deriveEventId(
  tenantId: string,
  organizerEmail: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(
      `mshindi-google/v1|${tenantId}|${organizerEmail.toLowerCase()}|${idempotencyKey}`,
      "utf8",
    )
    .digest();
  return base32hex(digest).slice(0, 32);
}

/**
 * Hex sha256 (32 chars) over a canonical form of the event. Attendee order and
 * displayName do not affect it.
 */
export function fingerprint(e: NormalizedEvent): string {
  const attendees = e.attendees
    .map((a): [string, boolean] => [a.email.toLowerCase(), a.optional])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const meeting =
    e.meeting.type === "in_person"
      ? { type: "in_person", location: e.meeting.location }
      : { type: "google_meet" };
  const canonical = JSON.stringify({
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    timeZone: e.timeZone,
    title: e.title,
    description: e.description,
    meeting,
    guestsCanSeeOtherGuests: e.guestsCanSeeOtherGuests,
    attendees,
  });
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, 32);
}
