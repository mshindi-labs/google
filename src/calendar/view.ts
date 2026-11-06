import { EventNotManagedError } from "../core/errors.js";
import type { GEvent } from "./transport.js";
import type { AttendeeResponse, CalendarEventView } from "./types.js";

const RESPONSES: Record<string, AttendeeResponse> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  needsAction: "needs_action",
};

const STATUSES = ["confirmed", "tentative", "cancelled"] as const;

/** I9: only events stamped by this library for the same tenant may be read or changed. */
export function assertManaged(e: GEvent, tenantId: string): void {
  const priv = e.extendedProperties?.private;
  if (priv?.mshindiGoogle !== "v1" || priv.mshindiTenant !== tenantId) {
    throw new EventNotManagedError();
  }
}

function meetingOf(e: GEvent): CalendarEventView["meeting"] {
  const cd = e.conferenceData;
  if (
    cd?.conferenceSolution?.key?.type === "hangoutsMeet" ||
    cd?.createRequest !== undefined
  ) {
    const video = cd?.entryPoints?.find(
      (p) => p.entryPointType === "video" && typeof p.uri === "string",
    );
    return { type: "google_meet", meetUrl: video?.uri ?? null };
  }
  return { type: "in_person", location: e.location ?? "" };
}

export function toView(e: GEvent): CalendarEventView {
  const status = STATUSES.find((s) => s === e.status) ?? "confirmed";
  return {
    eventId: e.id,
    status,
    title: e.summary ?? "",
    start: new Date(e.start?.dateTime ?? ""),
    end: new Date(e.end?.dateTime ?? ""),
    timeZone: e.start?.timeZone ?? e.end?.timeZone ?? "UTC",
    meeting: meetingOf(e),
    guestsCanSeeOtherGuests: e.guestsCanSeeOtherGuests ?? false,
    attendees: (e.attendees ?? [])
      .filter((a) => a.organizer !== true && a.self !== true && a.email)
      .map((a) => ({
        email: a.email as string,
        displayName: a.displayName ?? null,
        optional: a.optional ?? false,
        response: RESPONSES[a.responseStatus ?? ""] ?? "needs_action",
      })),
    htmlLink: e.htmlLink ?? "",
    updatedAt: new Date(e.updated ?? 0),
  };
}
