import { OAuth2Client } from "google-auth-library";
import { loadPeer } from "../core/peer.js";

export type GEvent = {
  id: string;
  status?: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    optional?: boolean;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
  }[];
  guestsCanSeeOtherGuests?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanModify?: boolean;
  conferenceData?: {
    createRequest?: {
      requestId?: string;
      conferenceSolutionKey?: { type?: string };
      status?: { statusCode?: string };
    };
    entryPoints?: { entryPointType?: string; uri?: string }[];
    conferenceSolution?: { key?: { type?: string } };
  } | null;
  extendedProperties?: { private?: Record<string, string> };
  htmlLink?: string;
  updated?: string;
};

export type GoogleSendUpdates = "all" | "externalOnly" | "none";

export interface CalendarTransport {
  freeBusy(p: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    emails: string[];
  }): Promise<
    Record<
      string,
      {
        busy: { start: string; end: string }[];
        errors: { reason: string }[];
      }
    >
  >;
  insert(p: {
    accessToken: string;
    event: GEvent;
    sendUpdates: GoogleSendUpdates;
    conferenceDataVersion: 0 | 1;
  }): Promise<GEvent>;
  get(p: { accessToken: string; eventId: string }): Promise<GEvent>;
  patch(p: {
    accessToken: string;
    eventId: string;
    patch: Partial<GEvent>;
    sendUpdates: GoogleSendUpdates;
    conferenceDataVersion: 0 | 1;
    /** Sent as `If-Match`; Google answers 412 when the event's etag differs. */
    ifMatch?: string;
  }): Promise<GEvent>;
  delete(p: {
    accessToken: string;
    eventId: string;
    sendUpdates: GoogleSendUpdates;
    /** Sent as `If-Match`; Google answers 412 when the event's etag differs. */
    ifMatch?: string;
  }): Promise<void>;
}

type Call<D> = (
  params: Record<string, unknown>,
  options?: { headers?: Record<string, string> },
) => Promise<{ data: D }>;
type CalendarApi = {
  events: {
    insert: Call<GEvent>;
    get: Call<GEvent>;
    patch: Call<GEvent>;
    delete: Call<unknown>;
  };
  freebusy: {
    query: Call<{
      calendars?: Record<
        string,
        {
          busy?: { start?: string | null; end?: string | null }[] | null;
          errors?: { reason?: string | null }[] | null;
        }
      >;
    }>;
  };
};
type CalendarModule = {
  calendar(opts: { version: "v3"; auth: unknown }): CalendarApi;
};

const CALENDAR_ID = "primary";

const ifMatchArgs = (ifMatch: string | undefined) =>
  ifMatch === undefined ? [] : [{ headers: { "If-Match": ifMatch } }];

/**
 * Talks to the Google Calendar API (always the `primary` calendar). Errors are
 * thrown as-is (gaxios errors carry the bearer token); the retry wrapper
 * classifies them so only sanitized GoogleLibError instances leave the library.
 */
export function createCalendarApiTransport(): CalendarTransport {
  const client = async (accessToken: string): Promise<CalendarApi> => {
    const mod = await loadPeer<
      Partial<CalendarModule> & { default?: CalendarModule }
    >("@googleapis/calendar");
    const { calendar } = (mod.calendar ? mod : mod.default) as CalendarModule;
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: accessToken });
    return calendar({ version: "v3", auth });
  };

  return {
    async freeBusy({ accessToken, timeMin, timeMax, emails }) {
      const api = await client(accessToken);
      const { data } = await api.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: emails.map((id) => ({ id })),
        },
      });
      const out: Record<
        string,
        {
          busy: { start: string; end: string }[];
          errors: { reason: string }[];
        }
      > = {};
      for (const [email, cal] of Object.entries(data?.calendars ?? {})) {
        out[email] = {
          busy: (cal.busy ?? []).map((b) => ({
            start: b.start ?? "",
            end: b.end ?? "",
          })),
          errors: (cal.errors ?? []).map((x) => ({ reason: x.reason ?? "" })),
        };
      }
      return out;
    },
    async insert({ accessToken, event, sendUpdates, conferenceDataVersion }) {
      const api = await client(accessToken);
      const { data } = await api.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: event,
        sendUpdates,
        conferenceDataVersion,
      });
      return data;
    },
    async get({ accessToken, eventId }) {
      const api = await client(accessToken);
      const { data } = await api.events.get({
        calendarId: CALENDAR_ID,
        eventId,
      });
      return data;
    },
    async patch({
      accessToken,
      eventId,
      patch,
      sendUpdates,
      conferenceDataVersion,
      ifMatch,
    }) {
      const api = await client(accessToken);
      const { data } = await api.events.patch(
        {
          calendarId: CALENDAR_ID,
          eventId,
          requestBody: patch,
          sendUpdates,
          conferenceDataVersion,
        },
        ...ifMatchArgs(ifMatch),
      );
      return data;
    },
    async delete({ accessToken, eventId, sendUpdates, ifMatch }) {
      const api = await client(accessToken);
      await api.events.delete(
        { calendarId: CALENDAR_ID, eventId, sendUpdates },
        ...ifMatchArgs(ifMatch),
      );
    },
  };
}
