import type { CoachingPrompt, CoachingSettings, MeetingContext, SessionSummary, TranscriptSegment } from "@listen/shared";

import { buildConversationTopics } from "../conversation/topics";
import { buildConversationTurns } from "../conversation/turns";
import { getAiRuntimeConfig } from "../runtime/runtimeSecrets";

function formatSpeakerPrefix(segment: TranscriptSegment): string {
  return segment.speakerLabel ? `${segment.speakerLabel}: ` : "";
}

function formatTurnPrefix(speakerLabel: string | null): string {
  return speakerLabel ? `${speakerLabel}: ` : "";
}

function formatPromptTitle(prompt: CoachingPrompt): string {
  return prompt.speakerLabel ? `${prompt.speakerLabel}: ${prompt.title}` : prompt.title;
}

function buildFallbackSummary(
  sessionId: string,
  transcript: TranscriptSegment[],
  prompts: CoachingPrompt[],
): SessionSummary {
  const turns = buildConversationTurns(transcript);
  const headlineTurn = turns.at(-1);
  const headline = headlineTurn
    ? `${formatTurnPrefix(headlineTurn.speakerLabel)}${headlineTurn.text}`
    : "Meeting ended with no transcript content yet.";

  return {
    sessionId,
    headline,
    decisions: turns.slice(-3).map((turn) => `${formatTurnPrefix(turn.speakerLabel)}${turn.text}`),
    actionItems: [],
    openQuestions: [],
    coachingRecap: prompts.slice(-3).map((prompt) => formatPromptTitle(prompt)),
    completedAt: new Date().toISOString(),
  };
}

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return getAiRuntimeConfig();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function parseSummaryPayload(content: string): Pick<SessionSummary, "headline" | "decisions" | "actionItems" | "openQuestions"> {
  const parsed = JSON.parse(content) as Record<string, unknown>;

  return {
    headline: typeof parsed.headline === "string" && parsed.headline.trim()
      ? parsed.headline.trim()
      : "Meeting ended with no transcript content yet.",
    decisions: normalizeStringList(parsed.decisions),
    actionItems: normalizeStringList(parsed.actionItems),
    openQuestions: normalizeStringList(parsed.openQuestions),
  };
}

async function buildAiSummary(
  sessionId: string,
  transcript: TranscriptSegment[],
  prompts: CoachingPrompt[],
  meetingContext: MeetingContext | null,
  guidance: { orgGuidance: string | null; userGuidance: string | null; settings: CoachingSettings },
): Promise<SessionSummary | null> {
  const aiConfig = getAiConfig();
  if (!aiConfig.apiKey) {
    return null;
  }

  const transcriptWindow = buildConversationTurns(transcript)
    .slice(-20)
    .map((turn) => ({
      speaker: turn.speakerLabel || turn.source,
      text: turn.text,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    }));
  const topicWindow = buildConversationTopics(transcript)
    .slice(-6)
    .map((topic) => ({
      title: topic.title,
      startedAt: topic.startedAt,
      endedAt: topic.endedAt,
      keywords: topic.keywords,
      turns: topic.turns.map((turn) => ({
        speaker: turn.speakerLabel || turn.source,
        text: turn.text,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      })),
    }));
  const promptWindow = prompts.slice(-10).map((prompt) => ({
    speaker: prompt.speakerLabel || null,
    title: prompt.title,
    message: prompt.message,
    severity: prompt.severity,
  }));

  const response = await fetch(`${aiConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: aiConfig.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You summarize meetings for a coaching product. Respond with strict JSON only containing headline, decisions, actionItems, openQuestions. Keep each item concise, use speaker labels when present, and do not invent facts.",
        },
        {
          role: "user",
          content: JSON.stringify({
            meetingContext,
            coachingGuidance: guidance,
            recentTranscript: transcriptWindow,
            conversationTopics: topicWindow,
            coachingPrompts: promptWindow,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "meeting_summary",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              decisions: { type: "array", items: { type: "string" } },
              actionItems: { type: "array", items: { type: "string" } },
              openQuestions: { type: "array", items: { type: "string" } },
            },
            required: ["headline", "decisions", "actionItems", "openQuestions"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`AI summary request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };
  const rawContent = payload.choices?.[0]?.message?.content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : rawContent;

  if (!content || typeof content !== "string") {
    throw new Error("AI summary response did not include content.");
  }

  const parsed = parseSummaryPayload(content);
  return {
    sessionId,
    headline: parsed.headline,
    decisions: parsed.decisions,
    actionItems: parsed.actionItems,
    openQuestions: parsed.openQuestions,
    coachingRecap: prompts.slice(-3).map((prompt) => formatPromptTitle(prompt)),
    completedAt: new Date().toISOString(),
  };
}

export async function summarizeSession(
  sessionId: string,
  transcript: TranscriptSegment[],
  prompts: CoachingPrompt[],
  meetingContext: MeetingContext | null,
  guidance: { orgGuidance: string | null; userGuidance: string | null; settings: CoachingSettings },
): Promise<SessionSummary> {
  try {
    const aiSummary = await buildAiSummary(sessionId, transcript, prompts, meetingContext, guidance);
    if (aiSummary) {
      return aiSummary;
    }
  } catch (error) {
    console.warn("AI summary generation failed. Falling back to heuristic summary.", error);
  };

  return buildFallbackSummary(sessionId, transcript, prompts);
}
