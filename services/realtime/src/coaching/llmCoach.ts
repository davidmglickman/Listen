import type { CoachingSettings, MeetingContext } from "@listen/shared";

export type CoachingRuleType = "filler" | "long_answer";

export interface CoachingMessageContext {
  meetingContext?: MeetingContext | null;
  orgGuidance?: string | null;
  userGuidance?: string | null;
  settings?: CoachingSettings;
}

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return {
    apiKey: process.env.LISTEN_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || null,
    model: process.env.LISTEN_AI_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    baseUrl: process.env.LISTEN_AI_BASE_URL?.trim() || "https://api.openai.com/v1",
  };
}

function summarizeGuidance(label: string, guidance: string | null | undefined): string {
  if (!guidance) {
    return "";
  }

  const condensed = guidance.trim().replace(/\s+/g, " ");
  if (!condensed) {
    return "";
  }

  return `${label}: ${condensed.slice(0, 120)}${condensed.length > 120 ? "..." : ""}`;
}

function normalizePromptText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function trimSentence(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildToneInstruction(settings?: CoachingSettings): string {
  if (!settings) {
    return "";
  }

  const styleInstruction = settings.style === "challenger"
    ? "Adopt a challenger coaching style: push for sharper thinking, more rigor, and stronger next moves."
    : settings.style === "direct"
      ? "Adopt a direct coaching style: concise, unsentimental, and immediately actionable."
      : "Adopt a supportive coaching style: calm, confidence-building, and constructive without sounding soft or vague.";

  const directnessInstruction = settings.directness === "blunt"
    ? "Use blunt directness: say the correction plainly and avoid hedging or extra cushioning."
    : settings.directness === "gentle"
      ? "Use gentle directness: keep the advice clear but phrase it with tact and composure."
      : "Use balanced directness: be clear and specific without sounding harsh.";

  return `${styleInstruction} ${directnessInstruction}`.trim();
}

function applyToneToMessage(message: string, settings?: CoachingSettings): string {
  const normalized = trimSentence(message);
  if (!settings || !normalized) {
    return normalized;
  }

  if (settings.style === "challenger") {
    if (settings.directness === "gentle") {
      return `Push a bit harder here: ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
    }

    if (settings.directness === "blunt") {
      return `Push harder. ${normalized}`;
    }

    return `Raise the bar here: ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
  }

  if (settings.style === "direct") {
    if (settings.directness === "gentle") {
      return `Next move: ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
    }

    return normalized;
  }

  if (settings.directness === "blunt") {
    return `Do this now: ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
  }

  if (settings.directness === "gentle") {
    return `Try this next: ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
  }

  return `Try this: ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
}

function applyToneToTitle(title: string, settings?: CoachingSettings): string {
  const normalized = trimSentence(title);
  if (!settings || !normalized) {
    return normalized;
  }

  if (settings.style === "challenger") {
    return settings.directness === "gentle" ? `Higher bar: ${normalized}` : `Challenge: ${normalized}`;
  }

  if (settings.style === "direct") {
    return settings.directness === "gentle" ? `Next move: ${normalized}` : normalized;
  }

  return settings.directness === "blunt" ? `Do this: ${normalized}` : normalized;
}

function tuneCoachCopy(message: { title: string; message: string }, settings?: CoachingSettings): { title: string; message: string } {
  if (!settings) {
    return message;
  }

  return {
    title: applyToneToTitle(message.title, settings),
    message: applyToneToMessage(message.message, settings),
  };
}

function buildContextAwareMessage(ruleType: CoachingRuleType, meetingContext?: MeetingContext | null): { title: string; message: string } {
  const callFunction = meetingContext?.callFunction ?? null;
  const callType = meetingContext?.callType.toLowerCase() ?? "";
  const desiredOutcome = meetingContext?.desiredOutcome?.trim();

  if (ruleType === "filler") {
    if (callFunction === "sales" && callType.includes("discovery")) {
      return {
        title: "Pause, then ask the next discovery question",
        message: "Drop the filler and create space. Ask one direct question that uncovers pain, process, or timing.",
      };
    }

    if (callFunction === "sales" && callType.includes("demo")) {
      return {
        title: "Tighten the demo narration",
        message: "Lead with the relevant outcome, then show the proof. Avoid filler before the key value statement.",
      };
    }

    if (callFunction === "recruiting") {
      return {
        title: "Slow down and get evidence",
        message: "Pause instead of filling space, then ask for one concrete example that proves the skill you are testing.",
      };
    }

    if (callFunction === "partnership") {
      return {
        title: "Keep the value exchange crisp",
        message: "Cut the filler and restate the mutual value in one sentence before moving forward.",
      };
    }

    if (callFunction === "internal") {
      return {
        title: "Deliver the point cleanly",
        message: "Pause briefly and give the update directly. Internal calls reward clarity more than narration.",
      };
    }
  }

  const defaultMessage = ruleType === "filler"
    ? {
        title: "Tighten delivery",
        message: "Too many filler words in the last response. Pause briefly before the next sentence.",
      }
    : {
        title: "Lead with the answer",
        message: "The last response is running long. Start with the direct answer, then add one detail.",
      };

  if (!desiredOutcome) {
    return defaultMessage;
  }

  return {
    title: defaultMessage.title,
    message: `${defaultMessage.message} Keep steering back to the desired outcome: ${desiredOutcome}`,
  };
}

export function buildCoachMessage(ruleType: CoachingRuleType, context: CoachingMessageContext = {}): { title: string; message: string } {
  const baseMessage = buildContextAwareMessage(ruleType, context.meetingContext);
  const guidance = [summarizeGuidance("Org focus", context.orgGuidance), summarizeGuidance("Personal focus", context.userGuidance)]
    .filter(Boolean)
    .join(" ");
  const settingsLine = context.settings
    ? `Coaching style: ${context.settings.style}. Directness: ${context.settings.directness}. Frequency: ${context.settings.frequency}.`
    : "";

  if (!guidance && !settingsLine) {
    return tuneCoachCopy(baseMessage, context.settings);
  }

  return tuneCoachCopy({
    title: baseMessage.title,
    message: `${baseMessage.message} ${settingsLine} ${guidance}`.trim(),
  }, context.settings);
}

export async function buildCoachMessageWithAi(
  ruleType: CoachingRuleType,
  transcriptText: string,
  context: CoachingMessageContext = {},
): Promise<{ title: string; message: string } | null> {
  const fallback = buildCoachMessage(ruleType, context);
  const aiConfig = getAiConfig();
  if (!aiConfig.apiKey) {
    return null;
  }

  try {
    const response = await fetch(`${aiConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              `You decide whether a live coaching nudge is actually worth showing. Respond with strict JSON only containing shouldEmit, title, and message. Set shouldEmit to false when the advice would be obvious, repetitive, weak, or not actionable enough to interrupt the user. Only emit when the coaching is specific and valuable. ${buildToneInstruction(context.settings)}`.trim(),
          },
          {
            role: "user",
            content: JSON.stringify({
              ruleType,
              transcriptText,
              meetingContext: context.meetingContext ?? null,
              orgGuidance: context.orgGuidance ?? null,
              userGuidance: context.userGuidance ?? null,
              settings: context.settings ?? null,
              fallback,
            }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "live_coaching_prompt",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                shouldEmit: { type: "boolean" },
                title: { type: "string" },
                message: { type: "string" },
              },
              required: ["shouldEmit", "title", "message"],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`AI coaching request failed with status ${response.status}.`);
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
      return null;
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.shouldEmit !== true) {
      return null;
    }

    const shapedFallback = tuneCoachCopy(fallback, context.settings);
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : shapedFallback.title;
    const message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : shapedFallback.message;
    const shapedResult = tuneCoachCopy({ title, message }, context.settings);

    if (
      normalizePromptText(shapedResult.title) === normalizePromptText(shapedFallback.title)
      && normalizePromptText(shapedResult.message) === normalizePromptText(shapedFallback.message)
    ) {
      return null;
    }

    return shapedResult;
  } catch (error) {
    console.warn("AI coaching generation failed. Suppressing coaching blurb for this segment.", error);
    return null;
  }
}
