# `@mshindi-labs/google/calendar` — Design

**Status:** Draft · **Date:** 2026-11-05 · **Owner:** Mshindi Labs
**Builds on:** `docs/SPEC.md` (v1 core + Gmail). Every invariant there (I1–I7) applies here
unchanged unless this document says otherwise.

## 1. Intent

A hiring manager in a multi-tenant HRMS clicks **Schedule interview** for an applicant,
picks a panel of colleagues, sees when they are free (with suggested slots), and books
the interview. The event is created on the **tenant's shared mailbox calendar**
(e.g. `careers@sunculture.io`) — the same connection that already sends ATS email — with
the applicant and panel as guests. Google sends the invites. Later the HRMS can
reschedule or cancel it, and shows each guest's RSVP when someone opens the interview
page.

The HRMS example is the motivating case, not the boundary: the API is "schedule a
meeting from a tenant mailbox with internal attendees and external guests", with no
HR vocabulary in it.

## 2. Goals, non-goals, anti-goals

### Goals

1. New subpath `@mshindi-labs/google/calendar`, built on the existing core: same tenant
   OAuth client, same encrypted refresh token, same `GoogleConnection`, same token
   manager, events emitter and error base.
2. **Availability**: free/busy for a list of internal attendees over a window.
3. **Slot suggestions**: common free slots for a duration, inside per-person working
   hours, honouring buffers and minimum notice.
4. **Create** an event with guests, either a Google Meet link or an in-person location.
5. **Reschedule** (change time / location / meeting type) and **cancel**, with Google
   notifying all guests.
6. **Read status**: current time, status, meet link and each guest's RSVP.
7. **Guest-list visibility flag** per event, hidden by default.
8. Never create the same event twice (the calendar analogue of I7).

### Non-goals (v1)

- Applicant self-booking links or public booking pages (manager always picks the slot).
- Push notifications / watch channels / webhooks. Status is pulled on demand.
- Free/busy for people outside the tenant's Google Workspace (they come back `unknown`).
- Reading, listing, or editing any event the library did not create.
- Recurring events, room/resource booking, reminders customization, attachments.
- A local copy of events in the database. Google is the source of truth; the host
  stores the returned event ID on its own interview record.
- A separate panel-only event with private notes. Descriptions are always
  applicant-safe (host's responsibility; the library does not inspect meaning).
- App-level authorization ("may this manager schedule as careers@?") — host decides,
  as for Gmail.

### Anti-goals (a failure even if it technically works)

- A retry or double-click producing **two invites** to an applicant.
- Treating "couldn't read this person's calendar" as "free" and suggesting a slot.
- Showing the panel's work emails to the applicant when the host didn't ask for it.
- Wrong local times because of DST or a missing time zone.
- The library touching the rest of `careers@`'s calendar.
- Any new secret in env vars, or plaintext tokens anywhere (I1).

## 3. Constraints

- Node ≥ 18, ESM + CJS via tsup, same release pipeline (release-please, OIDC publish).
- Calendar API client is an **optional peer dependency** `@googleapis/calendar`, loaded
  with `loadPeer` exactly like `@googleapis/gmail`.
- No date/time library dependency: time-zone maths uses `Intl.DateTimeFormat`
  (full ICU ships with Node ≥ 13).
- No store/schema changes: no new tables, no migration. (Adding events to the audit
  table needs no schema change — it stores JSON.)
- Library calls take only IDs and plain data from the host — never tokens.

## 4. Scopes and connecting

Add a `calendar` service to the scope registry (`src/core/scopes.ts`):

| Service    | Scopes                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar` | `https://www.googleapis.com/auth/calendar.events.owned` (create/change/delete events on calendars the account owns) and `https://www.googleapis.com/auth/calendar.events.freebusy` (see availability on calendars the account can see) |

**Builder must verify** both scope strings and that `freebusy.query` for _other users in
the same domain_ works with `calendar.events.freebusy` and that `events.insert/patch/
delete` (including `conferenceDataVersion=1`) work with `calendar.events.owned`. If the
granular scopes don't cover these, fall back to the narrowest scope that does
(`calendar.events` and `calendar.readonly` respectively — **not** `calendar.freebusy`,
which only covers the account's own calendars), record the evidence, and update this
table. Never fall back to full `calendar`.

**Existing mailboxes** (already connected for Gmail) gain Calendar by re-consenting:
`createAuthUrl({ tenantId, actorId, services: ['gmail', 'calendar'], connectionId,
intendedEmail })`. This path already exists (`include_granted_scopes`, scope merge,
`connection.scopes_added`). Nothing new in the OAuth flow; the callback's per-service
scope check (§6.4 step 8 of SPEC) covers the new service automatically.

The tenant's Google Cloud project must also enable the **Google Calendar API**; the
tenant-setup guide gets that step and the two scopes on the consent screen.

Every Calendar call checks `assertServiceScopes(connection.scopes, ['calendar'])` and
throws `MissingScopeError` before calling Google, so the host can show a
"reconnect careers@ to enable scheduling" prompt.

## 5. API

```ts
import { createCalendar } from '@mshindi-labs/google/calendar';
const calendar = createCalendar(google, { transport? });
```

All methods take `{ tenantId, connectionId, actorId, ... }`; `tenantId`/`connectionId`
resolve the connection through the token manager exactly as Gmail does (revoked /
missing / wrong-tenant connections fail closed with the existing errors).

### 5.1 Availability

```ts
calendar.getAvailability({
  tenantId, connectionId, actorId,
  attendees: string[],          // emails, 1..50, de-duplicated case-insensitively
  window: { start: Date; end: Date },  // end > start, max 31 days (verify Google's limit)
}): Promise<{
  [email: string]:
    | { status: 'ok'; busy: { start: Date; end: Date }[] }   // sorted, merged
    | { status: 'unknown'; reason: 'not_found' | 'no_access' | 'error' };
}>;
```

Uses `freebusy.query` against each attendee's primary calendar. Google's per-calendar
`errors` array maps to `unknown`. Only start/end leave Google — no titles.

**Known risk — verify live before relying on it:** for an in-domain user whose
free/busy sharing is restricted, Google may return an empty `busy` list with no
`errors`, which is indistinguishable from "free all window". The plan must include a
manual check against such a user. If it reproduces, document it prominently in the
guide (tenants must keep the Workspace default "share free/busy within the
organisation"); the library cannot detect it from the response alone.

### 5.2 Slot suggestions

```ts
calendar.suggestSlots({
  tenantId, connectionId, actorId,
  attendees: string[],
  window: { start: Date; end: Date },
  durationMinutes: number,                 // 5..480
  workingHours: WorkingHours,              // tenant default
  workingHoursByAttendee?: Record<string, WorkingHours>,  // overrides
  bufferMinutes?: number,                  // default 0; padding around existing busy blocks
  stepMinutes?: number,                    // default 15; candidate start alignment
  minNoticeMinutes?: number,               // default 60; nothing starting sooner than now+this
  maxResults?: number,                     // default 10, max 50
}): Promise<{
  slots: { start: Date; end: Date }[];     // earliest first
  unknownAttendees: string[];              // non-empty ⇒ slots is []
}>;

type WorkingHours = {
  timeZone: string;                        // IANA, validated via Intl
  days: Partial<Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun',
          { start: 'HH:MM'; end: 'HH:MM' }[]>>;
};
```

- Implemented as `getAvailability` + an exported **pure** function
  `findCommonSlots(input)` (no I/O, `now` passed in) so it can be tested exhaustively and
  reused with busy data from elsewhere.
- If any attendee is `unknown`, return no slots and list them. Never treat unknown as
  free (anti-goal). The host may drop that attendee and ask again.
- A slot must lie entirely inside every attendee's working hours **in that attendee's
  own time zone**, and not overlap any busy block widened by `bufferMinutes`.
- Candidate starts are aligned to `stepMinutes` in the tenant `workingHours.timeZone`
  (so 09:00, 09:15… local), DST-correct: a local wall time that doesn't exist (spring
  forward) is skipped; a repeated one (fall back) is used once, first occurrence.

### 5.3 Create

```ts
calendar.createEvent({
  tenantId, connectionId, actorId,
  idempotencyKey: string,                  // host's stable key, e.g. interview row id
  title: string,                           // 1..255, no control chars
  description?: string,                    // plain text, ≤ 8 KiB
  start: Date, end: Date,                  // end > start
  timeZone: string,                        // IANA; shown to guests
  attendees: { email: string; displayName?: string; optional?: boolean }[], // 1..100
  meeting: { type: 'google_meet' } | { type: 'in_person'; location: string },
  guestsCanSeeOtherGuests?: boolean,       // default false
  sendUpdates?: 'all' | 'external_only' | 'none',  // default 'all'
}): Promise<CalendarEventView>;
```

- Organizer is the connection's account; attendees validated (email syntax, CR/LF/NUL
  rejected, de-duplicated, organizer's own address removed).
- Always set `guestsCanInviteOthers=false`, `guestsCanModify=false`; set
  `guestsCanSeeOtherGuests` from the flag. Doc note: hiding also hides panelists from
  each other; it is enforced by Google's UI and invite emails, not a security boundary.
- `google_meet` → `conferenceData.createRequest` with `hangoutsMeet` and
  `conferenceDataVersion=1`. Every create request uses a **fresh random `requestId`**
  (Google de-duplicates by it, so a reused one would never make a new conference, e.g.
  when switching in-person → Meet later). If Google returns the conference as `pending`,
  `meetUrl` is `null` and fills in on a later `getEvent`. Meet failure handling: see
  §5.3.1 (open question for the owner).
- Private extended properties stamp ownership:
  `mshindiGoogle: 'v1'`, `tenantId`, `idempotencyKey`, and `fingerprint` (sha256 of the
  normalized create input).
- `sendUpdates` maps to Google's values `all` / `externalOnly` / `none`.

**No duplicate invites (I8, new):** the event id is derived deterministically:
`id = base32hex(sha256("mshindi-google/v1|" + tenantId + "|" + lowercase(organizerEmail) + "|" + idempotencyKey))`
truncated to 32 chars (Google allows `[a-v0-9]{5,1024}`, unique per calendar). The
organizer email, not `connectionId`, is hashed because the event lives on that mailbox's
calendar and a disconnect/reconnect must not change the id. Insert with that id. Then:

- Network errors, timeouts and 5xx on insert are retried (bounded: 3 attempts,
  exponential backoff with jitter; 429 follows Gmail's `Retry-After` rule). This is a
  deliberate difference from Gmail's I7: retrying is safe here because Google rejects a
  second insert of the same id.
- `409 duplicate` → `events.get` the id:
  - stamp matches this tenant + key, same `fingerprint`, not cancelled → success
    (`created: false`); no second `calendar_event.created` event is emitted.
  - stamp matches but `fingerprint` differs (same key, different time/guests) →
    `EventConflictError`: the host should call `updateEvent` to change a booked
    interview, not replay create.
  - stamp matches but event is cancelled → `EventConflictError`; a re-booked interview
    needs a new idempotency key (my call — Google could undelete, but silently reviving
    a cancelled invite is surprising).
  - stamp missing or for another tenant → `EventConflictError` (fail closed).

#### 5.3.1 Meet creation: invite only once the link is ready (decided by owner)

`events.insert` sends invites immediately when `sendUpdates=all`, and a failed conference
request does not reject the insert (the event is created with
`conferenceData.createRequest.status = failure`; only a calendar that disallows
`hangoutsMeet` gets a 400). So for `google_meet` the create is two-phase:

1. **Insert silently**: deterministic id, full body including attendees,
   `sendUpdates=none`, conference create request, private stamp with
   `inviteState: 'pending'`.
2. **Confirm the conference**: if the insert response's conference status is `success`,
   continue. If `pending`, poll `events.get` (bounded: up to ~10 s total, backoff). If
   `failure`, or still pending at the deadline → delete the event with `sendUpdates=none`
   (guests never hear about it) and throw `ConferencingUnavailableError`.
3. **Send invites**: `events.patch` setting `inviteState: 'sent'` with the caller's
   `sendUpdates` (default `all`), which makes Google send the invitations.

Replay (409 path) of an event whose stamp says `inviteState: 'pending'` resumes at
step 2 — so a crash between steps never leaves guests uninvited or invited twice.
`in_person` events skip all this: a single insert with the caller's `sendUpdates` and
`inviteState: 'sent'`. **Builder must verify live** that a patch with `sendUpdates=all`
on an event inserted with `sendUpdates=none` actually emails invitations to every
attendee; if Google does not, fall back to: step 1 inserts _without_ attendees, and step
3 patches the attendee list in with `sendUpdates` (attendees added by patch are
notified). Record which was used.

A cancelled conference-failure event leaves its id burned (Google keeps cancelled ids),
so the host retries with a new idempotency key; the error says so.

### 5.4 Reschedule

```ts
calendar.updateEvent({
  tenantId, connectionId, actorId, eventId,
  changes: { start?, end?, timeZone?, title?, description?, attendees?, meeting?,
             guestsCanSeeOtherGuests? },
  sendUpdates?: 'all' | 'external_only' | 'none',  // default 'all'
}): Promise<CalendarEventView>;
```

`events.get` first: must exist, carry our private properties with this `tenantId`
(else `EventNotManagedError`), and not be cancelled (else `EventCancelledError`).
Then `events.patch` with only the changed fields (patch merges, so fields changed by
hand in Google's UI and not named in `changes` survive); switching `in_person →
google_meet` adds a conference request (fresh `requestId`), the reverse sends
`conferenceData: null` with `conferenceDataVersion=1`.

- **No `If-Match`** (my call): the etag changes on every guest RSVP, so etag guarding
  would produce frequent false conflicts, and a retried patch whose first attempt landed
  would fail with 412. Patching the same values twice is idempotent, so patch retries
  follow the insert retry policy above.
- `changes.attendees` is the **full desired guest list**. The library merges it with the
  current event: kept guests keep their `responseStatus`, removed guests are dropped
  (Google notifies them per `sendUpdates`), new guests start at `needs_action`.
- `idempotencyKey` and the ownership stamp are never changed; `fingerprint` is updated to
  the new state.

### 5.5 Cancel

```ts
calendar.cancelEvent({ tenantId, connectionId, actorId, eventId,
  sendUpdates?: 'all' | 'external_only' | 'none' }): Promise<void>;
```

Same ownership check, then `events.delete`. Already cancelled / `410 Gone` → success
(idempotent).

### 5.6 Status

```ts
calendar.getEvent({ tenantId, connectionId, eventId }): Promise<CalendarEventView>;

type CalendarEventView = {
  eventId: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  title: string;
  start: Date; end: Date; timeZone: string;
  meeting: { type: 'google_meet'; meetUrl: string | null }
         | { type: 'in_person'; location: string };
  guestsCanSeeOtherGuests: boolean;
  attendees: { email: string; displayName: string | null; optional: boolean;
               response: 'needs_action' | 'accepted' | 'declined' | 'tentative' }[];
  htmlLink: string;
  updatedAt: Date;
};
```

Ownership check applies (a non-library event id → `EventNotManagedError`).
`getEvent` takes no `actorId` and emits no event (reads aren't audited, same as
`connections.get`).

## 6. Transport and testing

- `CalendarTransport` interface (freeBusy, insert, get, patch, delete) with a default
  `createCalendarApiTransport()` over `@googleapis/calendar`. As with Gmail, raw gaxios
  errors carry the bearer token; the service layer classifies them and only ever throws
  sanitized `GoogleLibError`s (I1).
- 401 → force-refresh once, then mark the connection revoked (identical to Gmail).
- `/testing` gains `FakeCalendar`: an in-memory `CalendarTransport` that honours ids,
  409 duplicates, etags, cancellation, conference `pending → success`, per-attendee
  free/busy fixtures and `unknown` errors, plus fault injection (fail-after-insert).

## 7. Events and errors

New `GoogleEvent` variants (emitted through the existing emitter; `redactRecipients`
hashes attendee emails exactly like message recipients; titles included, descriptions
never):

- `calendar_event.created` / `calendar_event.updated` / `calendar_event.cancelled`
  `{ tenantId, actorId, connectionId, eventId, attendees, title, start, end, at }`
  (`updated` adds `changed: string[]` field names)
- `calendar_event.failed` `{ tenantId, actorId, connectionId, operation, errorCode, at }`

`getAvailability` / `suggestSlots` emit nothing (high-volume reads; the busy data is
already privacy-light).

New errors (all extend `GoogleLibError`):

| Code                       | Class                                           |
| -------------------------- | ----------------------------------------------- |
| `invalid_event`            | `InvalidEventError { field }`                   |
| `event_not_found`          | `EventNotFoundError`                            |
| `event_not_managed`        | `EventNotManagedError`                          |
| `event_cancelled`          | `EventCancelledError`                           |
| `event_conflict`           | `EventConflictError` (idempotency id collision) |
| `conferencing_unavailable` | `ConferencingUnavailableError`                  |

Rate limits and fallbacks reuse `RateLimitedError`, `GoogleApiError`.

## 8. Invariants added

| #   | Invariant                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| I8  | A given `(tenantId, connectionId, idempotencyKey)` produces at most one calendar event, whatever retries, timeouts or duplicate calls happen. |
| I9  | The library reads or changes only events carrying its own private ownership stamp for the same tenant.                                        |

## 9. Docs

- New `docs/guides/calendar-scheduling.md`: enabling the Calendar API, reconnecting a
  mailbox with the `calendar` service, the interview flow end-to-end (availability →
  suggestions → create → store event id → status on page open → reschedule/cancel),
  idempotency keys for re-bookings, the guest-visibility caveat, Workspace free/busy
  sharing setting and why someone shows as `unknown`.
- Update `tenant-setup.md` (API + scopes), README (new subpath), SPEC §6.3 registry table
  and §3 layout.

## 10. Decided vs. left to the builder

**Decided with the user:** shared mailbox is organizer; panel always internal
employees; availability visible with suggestions; reschedule, cancel and RSVP in scope;
pull-only status; Meet by default, in-person sometimes; guest list hidden unless the
per-event flag is on; one shared, applicant-safe event; manager always picks the slot
(no self-booking).

**Calls I made (please check):** hidden-by-default guest list; tenant default working
hours with per-attendee overrides passed in by the host; unknown free/busy ⇒ no
suggestions; deterministic event ids from a host idempotency key plus the organizer
email; ownership stamp + fingerprint via private extended properties; replaying create
with changed data is an error (use `updateEvent`); cancelled events aren't revived;
retries on insert/patch (unlike Gmail) because both are idempotent here; no etag guard
on reschedule; `changes.attendees` is a full list with RSVPs preserved; no local event
table; no audit events for reads or replayed creates; the granular
`calendar.events.owned` + `calendar.events.freebusy` scopes (pending verification);
31-day availability window cap (verify live); defaults (15-min step, 60-min notice,
10 results).

**Must be verified live during build:** scope coverage (§4), the free/busy
restricted-sharing behaviour (§5.1), the availability window cap, and that cancelled
events keep `extendedProperties.private`.

**Left to the builder:** internal file layout under `src/calendar/`, the
`findCommonSlots` algorithm, validation limits not pinned above, and the exact shape of
`FakeCalendar` fixtures.
