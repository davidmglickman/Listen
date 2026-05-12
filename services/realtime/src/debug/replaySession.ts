import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AudioSourceKind, ListenInboundEvent } from "@listen/shared";
import { WebSocket } from "ws";

interface ReplaySegmentInput {
  source: AudioSourceKind;
  speakerId?: number | null;
  speakerLabel?: string | null;
  text: string;
  createdAt?: string;
}

interface ReplayInputFile {
  title?: string;
  attendees?: Array<{ fullName: string; email?: string }>;
  segments?: ReplaySegmentInput[];
}

const DEFAULT_BASE_URL = process.env.LISTEN_REALTIME_DEBUG_BASE_URL?.trim() || "http://127.0.0.1:8787";
const DEFAULT_SEGMENTS: ReplaySegmentInput[] = [
  { source: "microphone", speakerLabel: "You", text: "Thanks for joining. I want to review the rollout plan and confirm owners." },
  { source: "system", speakerId: 1, speakerLabel: "Alex Morgan", text: "Sounds good. I can cover the migration work and the release timing." },
  { source: "system", speakerId: 2, speakerLabel: "Jordan Lee", text: "I have one blocker on support enablement and documentation updates." },
  { source: "microphone", speakerLabel: "You", text: "Let's split that out. First rollout timing, then support, then open risks." },
  { source: "system", speakerId: 1, speakerLabel: "Alex Morgan", text: "For rollout timing, next Tuesday is realistic if QA signs off by Friday." },
  { source: "system", speakerId: 2, speakerLabel: "Jordan Lee", text: "On support, we need a short FAQ and escalation owner before launch." },
  { source: "microphone", speakerLabel: "You", text: "Great. Decision is Tuesday target, and action item is drafting the FAQ today." },
];

function buildWebSocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, "ws").replace(/\/$/, "")}/ws`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function waitForClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
}

function sendEvent(socket: WebSocket, event: ListenInboundEvent): void {
  socket.send(JSON.stringify(event));
}

function buildSegmentTimestamp(baseTimeMs: number, index: number, explicitTimestamp?: string): string {
  if (explicitTimestamp?.trim()) {
    return explicitTimestamp;
  }

  return new Date(baseTimeMs + index * 15_000).toISOString();
}

async function loadReplayInput(filePath: string | undefined): Promise<{ title: string; attendees: Array<{ fullName: string; email?: string }>; segments: ReplaySegmentInput[] }> {
  if (!filePath) {
    return {
      title: "Replay Debug Session",
      attendees: [
        { fullName: "Alex Morgan", email: "alex@example.com" },
        { fullName: "Jordan Lee", email: "jordan@example.com" },
      ],
      segments: DEFAULT_SEGMENTS,
    };
  }

  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as ReplayInputFile;

  return {
    title: parsed.title?.trim() || "Replay Debug Session",
    attendees: (parsed.attendees ?? []).filter((attendee) => attendee.fullName.trim().length > 0),
    segments: (parsed.segments ?? []).filter((segment) => segment.text.trim().length > 0),
  };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const replayInput = await loadReplayInput(inputPath);
  const sessionId = randomUUID();
  const meetingId = `debug-${sessionId}`;
  const expectedEndAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const ws = new WebSocket(buildWebSocketUrl(DEFAULT_BASE_URL));

  await waitForOpen(ws);

  sendEvent(ws, {
    kind: "session_start",
    sessionId,
    meetingId,
    expectedEndAt,
    meetingTitle: replayInput.title,
    meetingProvider: "generic",
    calendarProvider: "mock",
    meetingContext: null,
    attendees: replayInput.attendees,
  });

  const baseTimeMs = Date.now();
  for (const [index, segment] of replayInput.segments.entries()) {
    sendEvent(ws, {
      kind: "debug_transcript",
      sessionId,
      source: segment.source,
      speakerId: segment.speakerId,
      speakerLabel: segment.speakerLabel,
      text: segment.text,
      createdAt: buildSegmentTimestamp(baseTimeMs, index, segment.createdAt),
    });
    await sleep(10);
  }

  await sleep(50);

  const debugResponse = await fetch(`${DEFAULT_BASE_URL.replace(/\/$/, "")}/api/live-sessions/${encodeURIComponent(sessionId)}/debug`);
  if (!debugResponse.ok) {
    throw new Error(`Debug snapshot request failed: ${debugResponse.status} ${await debugResponse.text()}`);
  }

  const snapshot = await debugResponse.json() as {
    sessionId: string;
    meetingId: string;
    transcriptCount: number;
    promptCount: number;
    turns: Array<{ speakerLabel: string | null; text: string; startedAt: string; endedAt: string }>;
    topics: Array<{ title: string; keywords: string[]; turns: Array<{ speakerLabel: string | null; text: string }> }>;
    speakerResolution: unknown[];
  };

  console.log(JSON.stringify({
    sessionId: snapshot.sessionId,
    meetingId: snapshot.meetingId,
    transcriptCount: snapshot.transcriptCount,
    promptCount: snapshot.promptCount,
    turnCount: snapshot.turns.length,
    topicCount: snapshot.topics.length,
    turns: snapshot.turns,
    topics: snapshot.topics,
    speakerResolutionCount: snapshot.speakerResolution.length,
    note: snapshot.speakerResolution.length
      ? undefined
      : "debug_transcript events bypass Deepgram speaker resolution, so this replay is for turn/topic inspection rather than resolver accuracy.",
  }, null, 2));

  sendEvent(ws, {
    kind: "session_stop",
    sessionId,
    reason: "manual",
  });
  ws.close();
  await waitForClosed(ws);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});