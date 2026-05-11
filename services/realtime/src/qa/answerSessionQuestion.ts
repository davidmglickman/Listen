import type {
  CoachingPrompt,
  CoachingSettings,
  MeetingContext,
  OrgContextDocument,
  SessionQuestionAnswer,
  SessionSummary,
  TranscriptSegment,
} from "@listen/shared";

export interface SessionQuestionContext {
  meetingTitle: string;
  summary: SessionSummary | null;
  context: MeetingContext | null;
  transcript: TranscriptSegment[];
  coaching: CoachingPrompt[];
}

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return {
    apiKey: process.env.LISTEN_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || null,
    model: process.env.LISTEN_AI_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    baseUrl: process.env.LISTEN_AI_BASE_URL?.trim() || "https://api.openai.com/v1",
  };
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatTranscriptWindow(transcript: TranscriptSegment[]): Array<{ speaker: string; text: string; createdAt: string }> {
  return transcript
    .filter((segment) => segment.text.trim().length > 0)
    .slice(-160)
    .map((segment) => ({
      speaker: segment.speakerLabel || segment.source,
      text: clipText(segment.text, 400),
      createdAt: segment.createdAt,
    }));
}

function formatPromptWindow(prompts: CoachingPrompt[]): Array<{ title: string; message: string; speaker: string | null; createdAt: string }> {
  return prompts.slice(0, 20).map((prompt) => ({
    title: prompt.title,
    message: clipText(prompt.message, 280),
    speaker: prompt.speakerLabel || null,
    createdAt: prompt.createdAt,
  }));
}

function formatDocumentWindow(documents: OrgContextDocument[]): Array<{ title: string; sourceUrl: string | null; content: string }> {
  return documents.slice(0, 12).map((document) => ({
    title: document.title,
    sourceUrl: document.sourceUrl ?? null,
    content: clipText(document.content, 1_500),
  }));
}

async function requestAiAnswer(payload: {
  question: string;
  session: SessionQuestionContext;
  guidance: { orgGuidance: string | null; userGuidance: string | null; settings: CoachingSettings };
  documents: OrgContextDocument[];
}): Promise<SessionQuestionAnswer> {
  const aiConfig = getAiConfig();
  if (!aiConfig.apiKey) {
    throw new Error("AI Q&A is unavailable because LISTEN_AI_API_KEY is not configured.");
  }

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
            "You answer questions about a meeting using only the supplied meeting transcript, summary, coaching notes, meeting brief, and org context. Respond with strict JSON only containing answer and evidence. If the answer is not supported by the provided material, say that directly instead of guessing.",
        },
        {
          role: "user",
          content: JSON.stringify({
            question: payload.question,
            meetingTitle: payload.session.meetingTitle,
            meetingSummary: payload.session.summary,
            meetingContext: payload.session.context as MeetingContext | null,
            coachingGuidance: payload.guidance,
            orgDocuments: formatDocumentWindow(payload.documents),
            coachingPrompts: formatPromptWindow(payload.session.coaching),
            transcript: formatTranscriptWindow(payload.session.transcript),
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "session_question_answer",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
              evidence: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["answer", "evidence"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`AI Q&A request failed with status ${response.status}.`);
  }

  const responsePayload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };
  const rawContent = responsePayload.choices?.[0]?.message?.content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : rawContent;

  if (!content || typeof content !== "string") {
    throw new Error("AI Q&A response did not include content.");
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    answer: typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : "Not enough evidence in the stored meeting context.",
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 5)
      : [],
  };
}

export async function answerSessionQuestion(payload: {
  question: string;
  session: SessionQuestionContext;
  guidance: { orgGuidance: string | null; userGuidance: string | null; settings: CoachingSettings };
  documents: OrgContextDocument[];
}): Promise<SessionQuestionAnswer> {
  return requestAiAnswer(payload);
}