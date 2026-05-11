import type { CalendarSyncRequest, MeetingAttendee, MeetingRecord } from "@listen/shared";

import { fetchWithTimeout } from "../http/fetchWithTimeout";

function uniqueAttendees(attendees: MeetingAttendee[]): MeetingAttendee[] {
  const seen = new Set<string>();
  return attendees.filter((attendee) => {
    const key = `${attendee.email ?? ""}:${attendee.fullName.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function inferOrganizationDomain(meeting: MeetingRecord): string | undefined {
  if (meeting.organizerEmail?.includes("@")) {
    return meeting.organizerEmail.split("@")[1]?.toLowerCase();
  }

  const attendeeWithDomain = meeting.attendees?.find((attendee) => attendee.organizationDomain);
  return attendeeWithDomain?.organizationDomain;
}

export class CalendarSyncClient {
  constructor(private readonly baseUrl: string) {}

  async syncMeetings(meetings: MeetingRecord[]): Promise<void> {
    for (const meeting of meetings) {
      await this.syncMeeting(meeting);
    }
  }

  private async syncMeeting(meeting: MeetingRecord): Promise<void> {
    const organizerDomain = inferOrganizationDomain(meeting);
    const attendees = uniqueAttendees(
      (meeting.attendees ?? []).map((attendee) => ({
        fullName: attendee.fullName,
        email: attendee.email,
        title: attendee.title,
        linkedInUrl: attendee.linkedInUrl,
        organizationDomain: attendee.organizationDomain,
        organizationName: attendee.organizationName,
        role: attendee.email && attendee.email === meeting.organizerEmail
          ? "host"
          : attendee.organizationDomain && organizerDomain && attendee.organizationDomain === organizerDomain
            ? "internal"
            : "guest",
      })),
    );

    const payload: CalendarSyncRequest = {
      organization: {
        name: process.env.SUPABASE_ORGANIZATION_SLUG?.trim() || "default-org",
        domain: organizerDomain,
      },
      meeting: {
        externalId: meeting.externalId ?? meeting.id,
        title: meeting.title,
        startsAt: meeting.startsAt,
        endsAt: meeting.endsAt,
        source: "calendar",
        organizerEmail: meeting.organizerEmail,
        joinUrl: meeting.joinUrl,
        notes: meeting.notes,
        context: null,
      },
      attendees,
    };

    const response = await fetchWithTimeout(`${this.baseUrl}/api/admin/sync/calendar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Calendar sync failed with status ${response.status}`);
    }
  }
}