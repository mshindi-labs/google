export type TimeRange = { start: Date; end: Date };
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type WorkingHours = {
  timeZone: string;
  days: Partial<Record<Weekday, { start: string; end: string }[]>>; // "HH:MM", end may be "24:00"
};
export type SendUpdates = "all" | "external_only" | "none";
export type Meeting =
  { type: "google_meet" } | { type: "in_person"; location: string };
export type AttendeeInput = {
  email: string;
  displayName?: string;
  optional?: boolean;
};
export type AttendeeResponse =
  "needs_action" | "accepted" | "declined" | "tentative";
export type CalendarEventView = {
  eventId: string;
  status: "confirmed" | "tentative" | "cancelled";
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  meeting:
    | { type: "google_meet"; meetUrl: string | null }
    | { type: "in_person"; location: string };
  guestsCanSeeOtherGuests: boolean;
  attendees: {
    email: string;
    displayName: string | null;
    optional: boolean;
    response: "needs_action" | "accepted" | "declined" | "tentative";
  }[];
  htmlLink: string;
  updatedAt: Date;
};
export type Availability = Record<
  string,
  | { status: "ok"; busy: TimeRange[] }
  | { status: "unknown"; reason: "not_found" | "no_access" | "error" }
>;
