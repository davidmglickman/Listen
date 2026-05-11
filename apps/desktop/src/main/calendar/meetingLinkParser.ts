import type { LaunchStrategy, MeetingProvider } from "@listen/shared";

const meetingUrlPattern = /https?:\/\/[^\s)\]>"]+/gi;

export function parseMeetingLink(joinUrl: string): { provider: MeetingProvider; launchStrategy: LaunchStrategy } {
  if (joinUrl.includes("meet.google.com")) {
    return { provider: "google_meet", launchStrategy: "native_app" };
  }

  if (joinUrl.includes("teams.microsoft.com")) {
    return { provider: "microsoft_teams", launchStrategy: "native_app" };
  }

  if (joinUrl.includes("zoom.us")) {
    return { provider: "zoom", launchStrategy: "native_app" };
  }

  return { provider: "generic", launchStrategy: "browser" };
}

export function extractMeetingLink(...fields: Array<string | null | undefined>): string | null {
  for (const field of fields) {
    if (!field) {
      continue;
    }

    const matches = field.match(meetingUrlPattern) ?? [];
    for (const match of matches) {
      if (match.includes("meet.google.com") || match.includes("teams.microsoft.com") || match.includes("zoom.us")) {
        return match;
      }
    }
  }

  return null;
}
