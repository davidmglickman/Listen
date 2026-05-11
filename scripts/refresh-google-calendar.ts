import { existsSync } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import { CalendarService } from "../apps/desktop/src/main/calendar/calendarService";
import { MeetingResearchClient } from "../apps/desktop/src/main/calendar/meetingResearchClient";
import { CalendarSyncClient } from "../apps/desktop/src/main/calendar/calendarSyncClient";
import { SessionStore } from "../apps/desktop/src/main/storage/sessionStore";

function resolveEnvPath(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  dotenv.config({ path: resolveEnvPath() });

  const databasePath = process.env.LISTEN_DB_PATH?.trim() || path.resolve(process.cwd(), "data", "listen.db");
  const realtimeBaseUrl = `http://localhost:${process.env.LISTEN_REALTIME_PORT ?? 8787}`;
  const sessionStore = new SessionStore(databasePath);
  const syncClient = new CalendarSyncClient(realtimeBaseUrl);
  const researchClient = new MeetingResearchClient(realtimeBaseUrl);
  const calendarService = new CalendarService(
    sessionStore,
    async () => undefined,
    (meetings) => syncClient.syncMeetings(meetings),
    () => researchClient.listMeetingResearch(100),
  );

  const persisted = await calendarService.initialize();
  if (!persisted.auth.google) {
    throw new Error("No stored Google auth token found.");
  }

  const meetings = await calendarService.refreshUpcomingMeetings();
  console.log(`MEETING_COUNT=${meetings.length}`);
  for (const meeting of meetings) {
    console.log(`MEETING=${meeting.title} | ${meeting.startsAt} | ${meeting.externalId ?? meeting.id} | ${meeting.joinUrl}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});