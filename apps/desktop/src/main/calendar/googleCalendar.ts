import { createHash } from "node:crypto";

import type { CalendarConnection, MeetingRecord } from "@listen/shared";

import type { StoredOAuthToken } from "../storage/sessionStore";
import { fetchWithTimeout } from "../http/fetchWithTimeout";
import { extractMeetingLink, parseMeetingLink } from "./meetingLinkParser";

const genericMeetingLink = {
  provider: "generic",
  launchStrategy: "browser",
} as const;

interface GoogleCalendarDateTime {
  date?: string;
  dateTime?: string;
}

interface GoogleCalendarAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  responseStatus?: string;
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  attendees?: GoogleCalendarAttendee[];
  organizer?: {
    email?: string;
    displayName?: string;
  };
  start?: GoogleCalendarDateTime;
  end?: GoogleCalendarDateTime;
}

interface GoogleCalendarResponse {
  items?: GoogleCalendarEvent[];
}

function toIsoString(value: GoogleCalendarDateTime | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value.dateTime) {
    return new Date(value.dateTime).toISOString();
  }

  if (value.date) {
    return new Date(`${value.date}T00:00:00.000Z`).toISOString();
  }

  return null;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

export class GoogleCalendarProvider {
  private readonly calendarId = process.env.GOOGLE_CALENDAR_ID?.trim() || "primary";

  getConnection(token: StoredOAuthToken | null, status?: string): CalendarConnection {
    if (!token) {
      return {
        provider: "google",
        connected: false,
        accountLabel: "Google not connected",
      };
    }

    return {
      provider: "google",
      connected: true,
      accountLabel: status ?? token.accountLabel ?? `Google calendar ${this.calendarId}`,
    };
  }

  async getUpcomingMeetings(accessToken: string): Promise<MeetingRecord[]> {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
    const calendarId = encodeURIComponent(this.calendarId);
    const endpoint = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=100`;
    const response = await fetchWithTimeout(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Google calendar fetch failed with status ${response.status}`);
    }

    const payload = (await response.json()) as GoogleCalendarResponse;
    return (payload.items ?? [])
      .map((event) => {
        const joinUrl = extractMeetingLink(event.hangoutLink, event.location, event.description) ?? "";
        const startsAt = toIsoString(event.start);
        const endsAt = toIsoString(event.end);
        if (!startsAt || !endsAt) {
          return null;
        }

        const parsed = joinUrl ? parseMeetingLink(joinUrl) : genericMeetingLink;
        return {
          id: `google-${event.id}-${createHash("sha1").update(joinUrl || `${startsAt}-${endsAt}`).digest("hex").slice(0, 8)}`,
          externalId: event.id,
          title: event.summary?.trim() || "Google Calendar meeting",
          startsAt,
          endsAt,
          joinUrl,
          provider: parsed.provider,
          calendarProvider: "google",
          launchStrategy: parsed.launchStrategy,
          organizerEmail: event.organizer?.email,
          attendees: (event.attendees ?? []).map((attendee) => ({
            fullName: attendee.displayName?.trim() || attendee.email?.trim() || "Guest",
            email: attendee.email?.trim(),
            organizationDomain: attendee.email?.includes("@") ? attendee.email.split("@")[1]?.toLowerCase() : undefined,
          })),
          notes: event.location ?? event.description,
        } satisfies MeetingRecord;
      })
      .filter(isDefined);
  }
}
