import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  CalendarSyncRequestSchema,
  CompleteResearchJobRequestSchema,
  ListenInboundEventSchema,
  type ListenOutboundEvent,
  type TranscriptSegment,
} from "@listen/shared";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { detectCoachingPrompts } from "./coaching/rules";
import { HistoryStore } from "./history/historyStore";
import { answerSessionQuestion, type QuestionContextDocument } from "./qa/answerSessionQuestion";
import { createResearchProvider } from "./research/provider";
import { ResearchWorker } from "./research/worker";
import { createSupabaseAdminClient } from "./supabase/client";
import { SupabaseSyncService } from "./supabase/syncService";
import { buildConversationTopics } from "./conversation/topics";
import { buildConversationTurns } from "./conversation/turns";
import { getRuntimeSecretCapabilities, replacePersistedRuntimeSecrets } from "./runtime/runtimeSecrets";
import { RollingSessionState } from "./state/sessionState";
import { createStreamingTranscriptionProvider } from "./transcription/streamingProvider";

function resolveEnvPath(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

dotenv.config({ path: resolveEnvPath() });

const port = Number(process.env.PORT ?? process.env.LISTEN_REALTIME_PORT ?? 8787);
const host = process.env.HOST?.trim() || "0.0.0.0";
const publicBaseUrl = process.env.LISTEN_PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const transcriptionProvider = createStreamingTranscriptionProvider();
const sessions = new Map<string, RollingSessionState>();
const historyStore = new HistoryStore(process.env.LISTEN_DB_PATH?.trim() || path.resolve(process.cwd(), "data", "listen.db"));
replacePersistedRuntimeSecrets(historyStore.readRuntimeSecrets());
const webAppDir = path.resolve(process.cwd(), "apps", "web");
const supabaseSyncService = new SupabaseSyncService(
  createSupabaseAdminClient(),
  process.env.SUPABASE_ORGANIZATION_SLUG?.trim() || "default-org",
);
const researchWorker = new ResearchWorker(
  supabaseSyncService,
  createResearchProvider(process.env.SUPABASE_RESEARCH_PROVIDER?.trim() || "manual"),
  Number(process.env.SUPABASE_RESEARCH_POLL_MS ?? 60_000),
);

function getRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? "");
}

function normalizeQuestionContextDocuments(value: unknown): QuestionContextDocument[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce((documents, document) => {
    if (!document || typeof document !== "object") {
      return documents;
    }

    const candidate = document as {
      title?: unknown;
      content?: unknown;
      sourceUrl?: unknown;
    };
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    if (!title || !content) {
      return documents;
    }

    documents.push({
      title,
      content,
      sourceUrl: typeof candidate.sourceUrl === "string" && candidate.sourceUrl.trim() ? candidate.sourceUrl.trim() : null,
    });
    return documents;
  }, [] as QuestionContextDocument[]);
}

async function publishTranscript(ws: WebSocket, sessionState: RollingSessionState, segment: TranscriptSegment): Promise<void> {
  sessionState.appendTranscript(segment);
  send(ws, {
    kind: "transcript_segment",
    sessionId: segment.sessionId,
    segmentId: segment.id,
    source: segment.source,
    speakerId: segment.speakerId,
    speakerLabel: segment.speakerLabel,
    text: segment.text,
    isFinal: segment.isFinal,
    createdAt: segment.createdAt,
  });

  const prompts = await detectCoachingPrompts(segment, {
    meetingContext: sessionState.getMeetingContext(),
    ...sessionState.getCoachingGuidance(),
  });
  const promptsToEmit = sessionState.filterPromptsForEmission(prompts);
  sessionState.appendPrompts(promptsToEmit);
  for (const prompt of promptsToEmit) {
    send(ws, {
      kind: "coaching_prompt",
      sessionId: prompt.sessionId,
      promptId: prompt.id,
      speakerId: prompt.speakerId,
      speakerLabel: prompt.speakerLabel,
      severity: prompt.severity,
      title: prompt.title,
      message: prompt.message,
      createdAt: prompt.createdAt,
    });
  }
}

function send(ws: WebSocket, event: ListenOutboundEvent): void {
  ws.send(JSON.stringify(event));
}

app.use(express.json());
app.get("/", (_request: Request, response: Response) => {
  response.redirect("/app/");
});
app.get("/health", (_request: Request, response: Response) => {
  const runtimeSecrets = getRuntimeSecretCapabilities();
  response.json({
    ok: true,
    sessions: sessions.size,
    supabaseConfigured: supabaseSyncService.isConfigured(),
    aiConfigured: runtimeSecrets.aiConfigured,
    transcriptionConfigured: runtimeSecrets.transcriptionConfigured,
    publicBaseUrl,
    websocketUrl: `${publicBaseUrl.replace(/^http/i, "ws")}/ws`,
  });
});
app.put("/api/runtime/secrets", (request: Request, response: Response) => {
  const aiApiKey = typeof request.body?.aiApiKey === "string" ? request.body.aiApiKey : "";
  const deepgramApiKey = typeof request.body?.deepgramApiKey === "string" ? request.body.deepgramApiKey : "";
  const secrets = historyStore.writeRuntimeSecrets({
    aiApiKey: aiApiKey.trim() || null,
    deepgramApiKey: deepgramApiKey.trim() || null,
  });

  replacePersistedRuntimeSecrets(secrets);
  response.json({
    aiConfigured: Boolean(secrets.aiApiKey),
    transcriptionConfigured: Boolean(secrets.deepgramApiKey),
  });
});
app.get("/api/admin/supabase/status", (_request: Request, response: Response) => {
  response.json({
    configured: supabaseSyncService.isConfigured(),
    researchProvider: process.env.SUPABASE_RESEARCH_PROVIDER?.trim() || "manual",
  });
});
app.get("/api/admin/research/meetings", async (request: Request, response: Response) => {
  const limit = Number(request.query.limit ?? 50);
  try {
    const meetings = await supabaseSyncService.listMeetingResearch(Number.isFinite(limit) ? limit : 50);
    response.json({ meetings });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Meeting research lookup failed." });
  }
});
app.post("/api/admin/sync/calendar", async (request: Request, response: Response) => {
  const parsed = CalendarSyncRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid calendar sync payload.", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await supabaseSyncService.syncCalendarMeeting(parsed.data);
    response.status(202).json(result);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Calendar sync failed." });
  }
});
app.post("/api/admin/research/jobs/:jobId/complete", async (request: Request, response: Response) => {
  const parsed = CompleteResearchJobRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid research completion payload.", details: parsed.error.flatten() });
    return;
  }

  try {
    await supabaseSyncService.completeResearchJob(getRouteParam(request.params.jobId), parsed.data);
    response.status(204).end();
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Research completion failed." });
  }
});
app.post("/api/admin/research/run", async (_request: Request, response: Response) => {
  try {
    const result = await researchWorker.runOnce();
    response.status(200).json(result);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Research worker run failed." });
  }
});
app.get("/api/sessions", (request: Request, response: Response) => {
  const limit = Number(request.query.limit ?? 50);
  response.json({ sessions: historyStore.listSessions(Number.isFinite(limit) ? limit : 50) });
});
app.get("/api/sessions/:sessionId", (request: Request, response: Response) => {
  const session = historyStore.getSession(getRouteParam(request.params.sessionId));
  if (!session) {
    response.status(404).json({ error: "Session not found." });
    return;
  }

  response.json(session);
});
app.post("/api/sessions/:sessionId/questions", async (request: Request, response: Response) => {
  if (typeof request.body?.question !== "string" || !request.body.question.trim()) {
    response.status(400).json({ error: "Question is required." });
    return;
  }

  const session = historyStore.getSession(getRouteParam(request.params.sessionId));
  if (!session) {
    response.status(404).json({ error: "Session not found." });
    return;
  }

  try {
    const answer = await answerSessionQuestion({
      question: request.body.question.trim(),
      session,
      guidance: historyStore.getCoachingGuidance("self"),
      documents: historyStore.listOrgContextDocuments(),
    });
    response.json(answer);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Session Q&A failed." });
  }
});
app.post("/api/live-sessions/:sessionId/questions", async (request: Request, response: Response) => {
  if (typeof request.body?.question !== "string" || !request.body.question.trim()) {
    response.status(400).json({ error: "Question is required." });
    return;
  }

  const sessionState = sessions.get(getRouteParam(request.params.sessionId));
  if (!sessionState) {
    response.status(404).json({ error: "Active session not found." });
    return;
  }

  try {
    const answer = await answerSessionQuestion({
      question: request.body.question.trim(),
      session: {
        meetingTitle: sessionState.meetingId,
        summary: null,
        context: sessionState.getMeetingContext(),
        transcript: sessionState.getTranscript(),
        coaching: sessionState.getPrompts(),
      },
      guidance: sessionState.getCoachingGuidance(),
      documents: historyStore.listOrgContextDocuments(),
    });
    response.json(answer);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Live session Q&A failed." });
  }
});
app.get("/api/live-sessions/:sessionId/debug", (request: Request, response: Response) => {
  const sessionState = sessions.get(getRouteParam(request.params.sessionId));
  if (!sessionState) {
    response.status(404).json({ error: "Active session not found." });
    return;
  }

  const transcript = sessionState.getTranscript();
  response.json({
    sessionId: sessionState.sessionId,
    meetingId: sessionState.meetingId,
    transcriptCount: transcript.length,
    promptCount: sessionState.getPrompts().length,
    turns: buildConversationTurns(transcript),
    topics: buildConversationTopics(transcript),
    speakerResolution: sessionState.getSpeakerResolutionTraces(),
  });
});
app.post("/api/questions/context", async (request: Request, response: Response) => {
  if (typeof request.body?.question !== "string" || !request.body.question.trim()) {
    response.status(400).json({ error: "Question is required." });
    return;
  }

  if (typeof request.body?.title !== "string" || !request.body.title.trim()) {
    response.status(400).json({ error: "Context title is required." });
    return;
  }

  const extraDocuments = normalizeQuestionContextDocuments(request.body?.documents);

  try {
    const answer = await answerSessionQuestion({
      question: request.body.question.trim(),
      session: {
        meetingTitle: request.body.title.trim(),
        summary: request.body?.summary ?? null,
        context: request.body?.context ?? null,
        transcript: Array.isArray(request.body?.transcript) ? request.body.transcript : [],
        coaching: Array.isArray(request.body?.coaching) ? request.body.coaching : [],
      },
      guidance: historyStore.getCoachingGuidance("self"),
      documents: [...extraDocuments, ...historyStore.listOrgContextDocuments()],
    });
    response.json(answer);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Context Q&A failed." });
  }
});
app.get("/api/context", (_request: Request, response: Response) => {
  response.json({
    profiles: historyStore.listCoachingProfiles(),
    templates: historyStore.listMeetingTemplates(),
    documents: historyStore.listOrgContextDocuments(),
  });
});
app.put("/api/context/profiles/:profileId", (request: Request, response: Response) => {
  if (typeof request.body?.scope !== "string" || typeof request.body?.scopeId !== "string" || typeof request.body?.label !== "string" || typeof request.body?.guidance !== "string") {
    response.status(400).json({ error: "Invalid coaching profile payload." });
    return;
  }

  const settings = request.body?.settings;
  if (
    settings !== undefined
    && (typeof settings !== "object"
      || settings === null
      || typeof settings.style !== "string"
      || typeof settings.directness !== "string"
      || typeof settings.frequency !== "string")
  ) {
    response.status(400).json({ error: "Invalid coaching settings payload." });
    return;
  }

  const profile = historyStore.upsertCoachingProfile({
    id: getRouteParam(request.params.profileId),
    scope: request.body.scope,
    scopeId: request.body.scopeId,
    label: request.body.label,
    guidance: request.body.guidance,
    settings: request.body.settings,
    updatedAt: new Date().toISOString(),
  });
  response.json(profile);
});
app.put("/api/context/documents/:documentId", (request: Request, response: Response) => {
  if (typeof request.body?.title !== "string" || typeof request.body?.content !== "string") {
    response.status(400).json({ error: "Invalid org context document payload." });
    return;
  }

  const document = historyStore.upsertOrgContextDocument({
    id: getRouteParam(request.params.documentId),
    title: request.body.title,
    content: request.body.content,
    sourceUrl: typeof request.body?.sourceUrl === "string" ? request.body.sourceUrl : null,
    sourceName: typeof request.body?.sourceName === "string" ? request.body.sourceName : null,
    mimeType: typeof request.body?.mimeType === "string" ? request.body.mimeType : null,
    updatedAt: new Date().toISOString(),
  });
  response.json(document);
});
app.delete("/api/context/documents/:documentId", (request: Request, response: Response) => {
  historyStore.deleteOrgContextDocument(getRouteParam(request.params.documentId));
  response.json({ ok: true });
});
app.put("/api/context/templates/:templateId", (request: Request, response: Response) => {
  if (typeof request.body?.title !== "string" || typeof request.body?.context !== "object" || request.body.context === null) {
    response.status(400).json({ error: "Invalid meeting template payload." });
    return;
  }

  const template = historyStore.upsertMeetingTemplate({
    id: getRouteParam(request.params.templateId),
    title: request.body.title,
    context: request.body.context,
    updatedAt: new Date().toISOString(),
  });
  response.json(template);
});
app.delete("/api/context/templates/:templateId", (request: Request, response: Response) => {
  historyStore.deleteMeetingTemplate(getRouteParam(request.params.templateId));
  response.json({ ok: true });
});
app.use("/app", express.static(webAppDir));

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", async (rawMessage: RawData) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    const result = ListenInboundEventSchema.safeParse(parsed);
    if (!result.success) {
      return;
    }

    const event = result.data;

    if (event.kind === "session_start") {
      const sessionState = new RollingSessionState(
        event.sessionId,
        event.meetingId,
        event.expectedEndAt,
        event.meetingContext,
        historyStore.getCoachingGuidance(),
      );
      sessions.set(event.sessionId, sessionState);
      await transcriptionProvider.startSession(
        event.sessionId,
        async (providerSegment) => {
        const latestState = sessions.get(event.sessionId);
        if (!latestState) {
          return;
        }

        const segment: TranscriptSegment = {
          id: randomUUID(),
          sessionId: event.sessionId,
          source: providerSegment.source,
          speakerId: providerSegment.speakerId,
          speakerLabel: providerSegment.speakerLabel,
          text: providerSegment.text,
          isFinal: providerSegment.isFinal,
          createdAt: providerSegment.createdAt,
        };
        await publishTranscript(ws, latestState, segment);
        },
        {
          attendees: event.attendees,
          onTrace: (trace) => {
            const latestState = sessions.get(event.sessionId);
            latestState?.appendSpeakerResolutionTrace(trace);
          },
        },
      );
      return;
    }

    if (event.kind === "audio_chunk") {
      await transcriptionProvider.ingestChunk(event.sessionId, event.source, event.payloadBase64);
      return;
    }

    const sessionState = sessions.get(event.sessionId);
    if (!sessionState) {
      return;
    }

    if (event.kind === "debug_transcript") {
      const segment: TranscriptSegment = {
        id: randomUUID(),
        sessionId: event.sessionId,
        source: event.source,
        speakerId: event.speakerId ?? (event.source === "microphone" ? null : undefined),
        speakerLabel: event.speakerLabel ?? (event.source === "microphone" ? "You" : null),
        text: event.text,
        isFinal: true,
        createdAt: event.createdAt,
      };

      await publishTranscript(ws, sessionState, segment);

      return;
    }

    if (event.kind === "session_stop") {
      const summary = await sessionState.complete(event.reason);
      await transcriptionProvider.stopSession(event.sessionId);
      send(ws, {
        kind: "summary_ready",
        sessionId: summary.sessionId,
        headline: summary.headline,
        decisions: summary.decisions,
        actionItems: summary.actionItems,
        openQuestions: summary.openQuestions,
        coachingRecap: summary.coachingRecap,
        completedAt: summary.completedAt,
      });
      sessions.delete(event.sessionId);
    }
  });
});

server.listen(port, host, () => {
  researchWorker.start();
  console.log(`Listen realtime service running on ${publicBaseUrl}`);
});
