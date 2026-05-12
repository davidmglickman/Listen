import type { CalendarSyncRequest, MeetingAttendee, MeetingRecord } from "@listen/shared";

import { fetchWithTimeout } from "../http/fetchWithTimeout";

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalEmail(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

function normalizeOptionalUrl(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).toString();
  } catch {
    return undefined;
  }
}

function normalizeMeetingAttendee(attendee: MeetingAttendee): MeetingAttendee {
  return {
    fullName: attendee.fullName.trim() || "Guest",
    email: normalizeOptionalEmail(attendee.email),
    title: normalizeOptionalText(attendee.title),
    linkedInUrl: normalizeOptionalUrl(attendee.linkedInUrl),
    organizationDomain: normalizeOptionalText(attendee.organizationDomain)?.toLowerCase(),
    organizationName: normalizeOptionalText(attendee.organizationName),
    role: attendee.role,
  };
}

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
    const organizerEmail = normalizeOptionalEmail(meeting.organizerEmail);
    const organizerDomain = organizerEmail?.split("@")[1]?.toLowerCase() ?? inferOrganizationDomain(meeting);
    const attendees = uniqueAttendees(
      (meeting.attendees ?? [])
        .map((attendee): MeetingAttendee => ({
          fullName: attendee.fullName,
          email: attendee.email,
          title: attendee.title,
          linkedInUrl: attendee.linkedInUrl,
          organizationDomain: attendee.organizationDomain,
          organizationName: attendee.organizationName,
          role: attendee.email && organizerEmail && attendee.email.trim().toLowerCase() === organizerEmail
            ? "host"
            : attendee.organizationDomain && organizerDomain && attendee.organizationDomain === organizerDomain
              ? "internal"
              : "guest",
        }))
        .map(normalizeMeetingAttendee),
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
        organizerEmail,
        joinUrl: normalizeOptionalUrl(meeting.joinUrl),
        notes: normalizeOptionalText(meeting.notes),
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
      const body = await response.text();
      throw new Error(`Calendar sync failed with status ${response.status}${body ? `: ${body}` : ""}`);
    }
  }
}