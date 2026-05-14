import type { CoachingSettings, MeetingContext } from "@listen/shared";

export type CoachingRuleType = "filler" | "long_answer";

import { getAiRuntimeConfig } from "../runtime/runtimeSecrets";

export interface CoachingMessageContext {
  meetingContext?: MeetingContext | null;
  orgGuidance?: string | null;
  userGuidance?: string | null;
  settings?: CoachingSettings;
}

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return getAiRuntimeConfig();
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

function buildEqCommunicationInstruction(): string {
  return [
    "Use an EQ-first communication lens.",
    "Favor coaching that improves trust, empathy, listening, emotional control, and shared outcomes over surface-level speech cleanup.",
    "When the meeting context is sales, treat the advice as Sales EQ coaching: prioritize buyer understanding, discovery quality, trust-building, calm confidence, and crisp next steps over delivery nitpicks.",
    "Use Seven Habits style communication principles: be proactive, begin with the desired outcome, prioritize what matters, think win-win, seek first to understand before trying to be understood, and create alignment instead of tension.",
    "Only mention filler words, pacing, or long answers when they are clearly blocking empathy, clarity, or forward motion.",
    "Prefer advice about curiosity, acknowledgment, reframing, concise ownership, calm tone, and better questions.",
  ].join(" ");
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
        title: "Pause and deepen understanding before sharing",
        message: "Pause briefly after they speak to show you're listening, then ask one focused, open-ended question about their pain points or process before moving forward.",
      };
    }

    if (callFunction === "sales" && callType.includes("demo")) {
      return {
        title: "Lead with their outcome",
        message: "Acknowledge the concern, restate the outcome they care about, and then show the part of the demo that directly answers it.",
      };
    }

    if (callFunction === "recruiting") {
      return {
        title: "Create room for their example",
        message: "Slow the pace, acknowledge what you heard, and invite one concrete example instead of filling the silence yourself.",
      };
    }

    if (callFunction === "partnership") {
      return {
        title: "Recenter on mutual value",
        message: "Briefly reset and restate the shared win in one sentence so the conversation feels collaborative, not scattered.",
      };
    }

    if (callFunction === "internal") {
      return {
        title: "Lead with calm clarity",
        message: "Pause, name the point directly, and keep your tone steady so the room can respond to the substance instead of the delivery.",
      };
    }
  }

  const defaultMessage = ruleType === "filler"
    ? {
        title: "Slow down and reconnect",
        message: "Take a beat, ground yourself, and respond in a way that shows understanding before moving to your next point.",
      }
    : {
        title: "Make space for the other side",
        message: "Shorten the next response, lead with the core point, and leave room for the other person to react or clarify.",
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
    return fallback;
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
              `You decide whether a live coaching nudge is actually worth showing. Respond with strict JSON only containing shouldEmit, title, and message. Set shouldEmit to false when the advice would be obvious, repetitive, weak, or not actionable enough to interrupt the user. Only emit when the coaching is specific and valuable. ${buildEqCommunicationInstruction()} ${buildToneInstruction(context.settings)}`.trim(),
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
      return fallback;
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
      return shapedFallback;
    }

    return shapedResult;
  } catch (error) {
    console.warn("AI coaching generation failed. Falling back to heuristic coaching blurb for this segment.", error);
    return fallback;
  }
}
