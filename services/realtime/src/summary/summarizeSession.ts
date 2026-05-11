import type { CoachingPrompt, CoachingSettings, MeetingContext, SessionSummary, TranscriptSegment } from "@listen/shared";

function formatSpeakerPrefix(segment: TranscriptSegment): string {
  return segment.speakerLabel ? `${segment.speakerLabel}: ` : "";
}

function formatPromptTitle(prompt: CoachingPrompt): string {
  return prompt.speakerLabel ? `${prompt.speakerLabel}: ${prompt.title}` : prompt.title;
}

function buildFallbackSummary(
  sessionId: string,
  transcript: TranscriptSegment[],
  prompts: CoachingPrompt[],
): SessionSummary {
  const nonEmptySegments = transcript.filter((segment) => segment.text.trim().length > 0);
  const headlineSegment = nonEmptySegments.at(-1);
  const headline = headlineSegment
    ? `${formatSpeakerPrefix(headlineSegment)}${headlineSegment.text}`
    : "Meeting ended with no transcript content yet.";

  return {
    sessionId,
    headline,
    decisions: nonEmptySegments.slice(0, 2).map((segment) => `${formatSpeakerPrefix(segment)}${segment.text}`),
    actionItems: [],
    openQuestions: [],
    coachingRecap: prompts.slice(-3).map((prompt) => formatPromptTitle(prompt)),
    completedAt: new Date().toISOString(),
  };
}

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return {
    apiKey: process.env.LISTEN_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || null,
    model: process.env.LISTEN_AI_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    baseUrl: process.env.LISTEN_AI_BASE_URL?.trim() || "https://api.openai.com/v1",
  };
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

  const transcriptWindow = transcript
    .filter((segment) => segment.text.trim().length > 0)
    .slice(-80)
    .map((segment) => ({
      speaker: segment.speakerLabel || segment.source,
      text: segment.text,
      createdAt: segment.createdAt,
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
            transcript: transcriptWindow,
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
