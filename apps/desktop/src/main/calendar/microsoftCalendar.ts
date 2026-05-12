import type { CalendarConnection, MeetingRecord } from "@listen/shared";

import type { StoredOAuthToken } from "../storage/sessionStore";
import { extractMeetingLink, parseMeetingLink } from "./meetingLinkParser";

const genericMeetingLink = {
  provider: "generic",
  launchStrategy: "browser",
} as const;

interface MicrosoftDateTimeTimeZone {
  dateTime: string;
}

interface MicrosoftOnlineMeeting {
  joinUrl?: string;
}

interface MicrosoftCalendarEvent {
  id: string;
  subject?: string;
  attendees?: Array<{
    emailAddress?: {
      address?: string;
      name?: string;
    };
  }>;
  organizer?: {
    emailAddress?: {
      address?: string;
      name?: string;
    };
  };
  bodyPreview?: string;
  location?: {
    displayName?: string;
  };
  onlineMeeting?: MicrosoftOnlineMeeting;
  onlineMeetingUrl?: string;
  start?: MicrosoftDateTimeTimeZone;
  end?: MicrosoftDateTimeTimeZone;
}

interface MicrosoftCalendarResponse {
  value?: MicrosoftCalendarEvent[];
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

export class MicrosoftCalendarProvider {
  getConnection(token: StoredOAuthToken | null, status?: string): CalendarConnection {
    if (!token) {
      return {
        provider: "microsoft",
        connected: false,
        accountLabel: "Microsoft 365 not connected",
      };
    }

    return {
      provider: "microsoft",
      connected: true,
      accountLabel: status ?? token.accountLabel ?? "Microsoft 365 calendar",
    };
  }

  async getUpcomingMeetings(accessToken: string): Promise<MeetingRecord[]> {
    const startDateTime = new Date().toISOString();
    const endDateTime = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
    const endpoint = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$top=100&$select=id,subject,bodyPreview,location,onlineMeeting,onlineMeetingUrl,start,end,attendees,organizer`;
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Microsoft calendar fetch failed with status ${response.status}`);
    }

    const payload = (await response.json()) as MicrosoftCalendarResponse;
    return (payload.value ?? [])
      .map((event) => {
        const joinUrl = extractMeetingLink(event.onlineMeeting?.joinUrl, event.onlineMeetingUrl, event.location?.displayName, event.bodyPreview) ?? "";
        if (!event.start?.dateTime || !event.end?.dateTime) {
          return null;
        }

        const parsed = joinUrl ? parseMeetingLink(joinUrl) : genericMeetingLink;
        return {
          id: `microsoft-${event.id}`,
          externalId: event.id,
          title: event.subject?.trim() || "Microsoft 365 meeting",
          startsAt: new Date(event.start.dateTime).toISOString(),
          endsAt: new Date(event.end.dateTime).toISOString(),
          joinUrl,
          provider: parsed.provider,
          calendarProvider: "microsoft",
          launchStrategy: parsed.launchStrategy,
          organizerEmail: event.organizer?.emailAddress?.address?.trim(),
          attendees: (event.attendees ?? []).map((attendee) => ({
            fullName: attendee.emailAddress?.name?.trim() || attendee.emailAddress?.address?.trim() || "Guest",
            email: attendee.emailAddress?.address?.trim(),
            organizationDomain: attendee.emailAddress?.address?.includes("@")
              ? attendee.emailAddress.address.split("@")[1]?.toLowerCase()
              : undefined,
          })),
          notes: event.location?.displayName ?? event.bodyPreview,
        } satisfies MeetingRecord;
      })
      .filter(isDefined);
  }
}
