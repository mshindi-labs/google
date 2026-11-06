# Scheduling interviews with Google Calendar

How to book, reschedule and cancel interviews as a connected Google Workspace mailbox
using `@mshindi-labs/google/calendar`. The examples follow an HRMS interview flow;
adapt the names to your application.

The service only touches events it created itself. Every event is stamped with a
private marker and the tenant id, and a read or change of anything else (or of another
tenant's event) fails with `event_not_managed`.

## 1. Set up

**Install the peer.** `@googleapis/calendar` is an optional peer, loaded on first use.
The supported range is `>=14.0.0 <21.0.0`. v19 and v20 need Node 22, so on Node 18 or 20
pin v16 (the version the library is tested against):

```sh
npm i @googleapis/calendar@^16   # Node 18 / 20
npm i @googleapis/calendar       # Node 22+
```

**Tenant admin.** In the Google Cloud project, enable the **Google Calendar API** (see
[tenant-setup](./tenant-setup.md), step 2). The library asks for two scopes:

- `calendar.events.owned` creates, reads, changes and deletes events on the connected
  mailbox's own calendar.
- `calendar.events.freebusy` reads other people's free/busy (no event details).

It never asks for the full `calendar` scope.

**Connect or reconnect the mailbox.** A mailbox connected for Gmail only must consent
again to add the Calendar scopes. Pass the existing `connectionId` so the scopes are
added to that connection instead of creating a second one:

```ts
const { url } = await google.oauth.createAuthUrl({
  tenantId,
  actorId,
  services: ["gmail", "calendar"],
  intendedEmail: "careers@example.com",
  connectionId, // add scopes to the existing connection
});
```

Until the connection has both Calendar scopes, calendar calls throw
`missing_scope`.

**Create the service.**

```ts
import { createCalendar } from "@mshindi-labs/google/calendar";

const calendar = createCalendar(google);
```

The mailbox you connect is the organizer. Events are created on its primary calendar.

## 2. The interview flow

### Find a time

```ts
const { slots, unknownAttendees } = await calendar.suggestSlots({
  tenantId,
  actorId,
  connectionId,
  attendees: ["panelist1@example.com", "panelist2@example.com"],
  window: {
    start: new Date("2026-12-01T00:00:00Z"),
    end: new Date("2026-12-08T00:00:00Z"),
  },
  durationMinutes: 45,
  workingHours: {
    timeZone: "Africa/Nairobi",
    days: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
    },
  },
});
```

Optional knobs: `bufferMinutes` (0 to 240), `stepMinutes` (5 to 60, default 15),
`minNoticeMinutes` (default 60), `maxResults` (1 to 50, default 10) and
`workingHoursByAttendee`. The window may be at most 31 days. `getAvailability` returns
the raw busy blocks per person if you want to draw your own picker. Its result is keyed
by the **fully lowercased** address, so look people up with `email.toLowerCase()`.

If anyone's availability is `unknown`, `suggestSlots` returns **no suggestions** and
lists them in `unknownAttendees`. It will not offer a time it cannot verify. See
[section 4](#4-why-someone-shows-as-unknown).

### Book it

```ts
const event = await calendar.createEvent({
  tenantId,
  actorId,
  connectionId,
  idempotencyKey: interview.id,
  title: "Interview: Jane Doe, Backend Engineer",
  start: slot.start,
  end: slot.end,
  timeZone: "Africa/Nairobi",
  attendees: [
    { email: "jane@applicant.com", displayName: "Jane Doe" },
    { email: "panelist1@example.com" },
    { email: "panelist2@example.com", optional: true },
  ],
  meeting: { type: "google_meet" }, // or { type: "in_person", location: "HQ, 4th floor" }
  guestsCanSeeOtherGuests: false,
});

await db.interviews.update(interview.id, { eventId: event.eventId });
```

Store `event.eventId`. It is your handle for every later call. `event.created` is
`false` when the call was a replay of an earlier one.

**The idempotency key** is your interview row id. Calling `createEvent` again with the
same key never creates a second event and never re-sends invitations, so it is safe to
retry after a timeout, a crash or a double-click, even from two servers at once.

- A replay with the same key and the same details returns the existing event.
- The same key with **different** details throws `EventConflictError`
  (`event_conflict`). To change an event that exists, call `updateEvent`.
- **Re-booking a cancelled interview needs a new key.** A cancelled event still owns its
  key; reusing it throws `event_conflict`. Mint a fresh key (for example
  `${interview.id}:2`) for the new booking.
- Retrying the **original** `createEvent` after the event was rescheduled also throws
  `event_conflict` (its details no longer match). Treat it as "already booked" and read
  the event with `getEvent`.

**Google Meet.** For `google_meet`, the event is created without notifying anyone. The
library waits (up to about 10 seconds) for Google to finish making the link, and only
sends the invitations once the conference status is `success` **and** a video link
exists. So guests never receive an invitation with no link.

If Google cannot create the conference, the event is withdrawn silently (nobody was
emailed) and the call throws `ConferencingUnavailableError`
(`conferencing_unavailable`). Retry with a **new** idempotency key, or fall back to an
in-person or phone interview.

If that withdrawal itself fails (the cleanup delete errors too), the error is still
`ConferencingUnavailableError` and a warning is logged, but a pending event may remain on
the organizer's calendar. Its guests were never invited. Replaying the call with the
**same** key retries the withdrawal.

If a Meet create was interrupted half way and you replay it, the replaying call finishes
the job and its `sendUpdates` decides who is notified.

`sendUpdates` is `"all"` (default), `"external_only"` (guests outside the organizer's
domain) or `"none"`.

### Show the page: RSVP status

```ts
const view = await calendar.getEvent({ tenantId, connectionId, eventId });
// view.attendees[i].response: "needs_action" | "accepted" | "declined" | "tentative"
// view.status: "confirmed" | "tentative" | "cancelled"
```

Call `getEvent` when the interview page opens. RSVP status is pull-only: there are no
webhooks, so nothing updates until you ask. `view.meeting` carries the `meetUrl`
(it is `null` if the link is not ready).

### Reschedule or change

```ts
await calendar.updateEvent({
  tenantId,
  actorId,
  connectionId,
  eventId,
  changes: { start: newStart, end: newEnd },
});
```

`changes` may contain `start`, `end`, `timeZone`, `title`, `description` (`null`
clears it), `attendees`, `meeting` and `guestsCanSeeOtherGuests`. Only what you list
changes.

- **`changes.attendees` is the full desired guest list**, not a delta. Guests who stay
  keep their RSVP. An attendee given without a `displayName` keeps the name Google
  already has.
- **No-op when nothing differs.** The library compares your request with Google's
  current copy, not with what it last wrote. If someone already moved the event by hand
  in Google Calendar, a request to move it to the same time does nothing, and a request
  for a different time still goes through. A manual edit never swallows your reschedule.
- **Switching to Meet** on update notifies guests immediately and does not roll back if
  the link fails: the call succeeds and `meeting.meetUrl` is `null`. Request
  `google_meet` again to repair it.
- **Last writer wins** between two concurrent updates. Serialize updates per interview
  in your application if that matters.
- An update on a cancelled event throws `EventCancelledError` (`event_cancelled`).

### Cancel

```ts
await calendar.cancelEvent({ tenantId, actorId, connectionId, eventId });
```

Cancelling is idempotent: cancelling twice succeeds twice, and only the first call
notifies guests.

## 3. Guest list visibility

`guestsCanSeeOtherGuests` defaults to **`false`**: a candidate sees themself and the
organizer, not the panel. This also hides the panelists **from each other**, so
panelists cannot see who else is interviewing.

This is a user-interface setting in Google Calendar, not a security boundary. A guest
can still see the invitation emails sent to them, and Google may reveal other guests in
some views. Do not rely on it to keep an address secret. Set it to `true` for events
where the whole list is fine to share.

## 4. Why someone shows as `unknown`

`getAvailability` reports each address as `{ status: "ok", busy }` or
`{ status: "unknown", reason }`, where `reason` is `not_found` (no such calendar),
`no_access` (the calendar is not shared with the organizer) or `error`.

People inside the organization are only visible if the Workspace admin allows it: in the
Admin console, **Apps > Google Workspace > Calendar > Sharing settings**, set
**Internal** sharing to at least **Share all information** or **Only free/busy
information** for the organization ("share free/busy within the organisation").
External addresses are usually `unknown`.

Treat `unknown` as "ask a human". `suggestSlots` deliberately returns no slots rather
than guess.

## 5. Audit events

`onEvent` receives:

| Event                      | When                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `calendar_event.created`   | Invitations went out for a new event                       |
| `calendar_event.updated`   | An update changed the event (carries `changed` field list) |
| `calendar_event.cancelled` | An event was cancelled                                     |
| `calendar_event.failed`    | Create, update or cancel failed (`operation`, `errorCode`) |

Events carry attendee addresses and the title, never descriptions, tokens or links.
With `redactRecipients`, attendee addresses are replaced by `sha256(lowercase(address))`.

Reads (`getEvent`, `getAvailability`, `suggestSlots`) emit nothing. Input validation
errors thrown before any token is fetched also emit nothing.

One rare edge case: if a crash or a lost response overlaps with concurrent calls,
`calendar_event.created` may be emitted twice or not at all for an event, but the
invitations are always sent exactly once. Do not use the audit trail as the only record
of what was booked; store the `eventId` yourself.

## 6. Errors

| Code                       | Class                          | Meaning                                           |
| -------------------------- | ------------------------------ | ------------------------------------------------- |
| `invalid_event`            | `InvalidEventError { field }`  | Bad input; `field` names it                       |
| `event_not_found`          | `EventNotFoundError`           | No such event                                     |
| `event_not_managed`        | `EventNotManagedError`         | Not created by this library for this tenant       |
| `event_cancelled`          | `EventCancelledError`          | The event is cancelled (update refused)           |
| `event_conflict`           | `EventConflictError`           | Same key, different details; or concurrent change |
| `conferencing_unavailable` | `ConferencingUnavailableError` | Meet could not be created; retry with a new key   |

Plus the usual `missing_scope`, `connection_revoked`, `rate_limited` and `google_api`.
Match on `err.code`.

## 7. Testing your integration

`FakeCalendar` from `@mshindi-labs/google/testing` is an in-memory Calendar transport.
Pass it to `createCalendar` so tests never call Google:

```ts
import { createCalendar } from "@mshindi-labs/google/calendar";
import { FakeCalendar } from "@mshindi-labs/google/testing";

const cal = new FakeCalendar({ organizerEmail: "careers@example.com" });
cal.setFreeBusy("panelist1@example.com", [
  { start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" },
]);
const calendar = createCalendar(google, { transport: cal });

const event = await calendar.createEvent({ ...booking });
expect(cal.notifications.filter((n) => n.kind === "invite")).toHaveLength(1);
```

`google` is a `createGoogle` instance with a connected mailbox (in tests, use
`InMemoryStore`, `LocalKeyProvider` and `FakeGoogleOAuth` from the same entry point).
`cal.events`, `cal.calls` and `cal.notifications` show what happened.
`setConferenceBehaviour("pending" | "failure")` simulates a slow or failing Meet link, and
`failNext(op, error, { afterApply })` injects a failure, optionally after the change was
applied (a lost response).

## 8. Before production: live checks

The library was built against Google's documented behavior and tested with a fake
transport. These behaviors could not be confirmed offline. Run each check once against a
real tenant (a test mailbox and one or two test colleagues are enough) before you rely
on the feature. Where Google behaves differently there is a fallback.

1. **Scopes are sufficient.** With only `calendar.events.owned`, create, get, update and
   cancel an event, including a Meet event (`conferenceDataVersion=1`). With
   `calendar.events.freebusy`, read the free/busy of another user in your domain.
   _Fallback:_ if either is refused, request `calendar.events` and/or
   `calendar.readonly` instead. Never use the full `calendar` scope.
2. **Restricted free/busy sharing.** Pick a colleague whose calendar sharing is
   restricted and query them. Check whether Google returns an error for them or an
   empty busy list with no error (they would look free). If it looks free, tenants must
   keep the Workspace "share free/busy within the organisation" setting on (section 4).
3. **Free/busy window cap.** Query a window longer than the library's 31-day cap and
   confirm Google accepts at most that much. The library rejects wider windows itself;
   confirm 31 days actually works.
4. **Cancelled events keep their marker.** Cancel an event, then `getEvent` it. Google
   must still return the private marker on the cancelled event. Cancelling twice, and
   detecting a conflicting replay of a cancelled booking, depend on it.
5. **Invitations really go out on release.** Create a Meet event and confirm each guest
   receives exactly one invitation, and only after the link exists. The library inserts
   with no notification and then patches with `sendUpdates=all`; verify that patch emails
   every attendee. _Fallback_ (design §5.3.1): insert the Meet event **without**
   attendees in phase 1, then patch the attendee list in with the caller's `sendUpdates`
   when releasing (Google notifies attendees added by a patch).
6. **Private markers merge.** After an update, confirm the tenant, key and invite
   markers are all still present (`events.patch` must merge the private properties
   key by key, not replace them). If they are replaced, `event_not_managed` appears
   after the first update.
7. **Clearing fields.** Update an event with `description: null`, and switch an event
   from Meet to in-person. The description must clear and the Meet link must go away.
8. **Concurrency guard.** Confirm `events.patch` and `events.delete` reject a stale
   `If-Match` etag with HTTP 412. This stops two servers from releasing invitations
   twice.
9. **Auth library compatibility.** Confirm calls succeed with the `google-auth-library`
   version your app resolves next to your `@googleapis/calendar` version (v16 is what
   the library is tested with).
10. **Display names.** Check whether Google fills in `displayName` for directory users
    you invite without one. If it does not, a reschedule retried after a lost response
    may send one redundant update email. This is harmless but worth knowing.
