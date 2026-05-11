import { randomUUID } from "node:crypto";

import type { CoachingPrompt, TranscriptSegment } from "@listen/shared";

import { buildCoachMessageWithAi, type CoachingMessageContext, type CoachingRuleType } from "./llmCoach";

function countFillers(text: string): number {
  const matches = text.match(/\b(um|uh|like|you know)\b/gi);
  return matches?.length ?? 0;
}

function detectRule(segment: TranscriptSegment): CoachingRuleType | null {
  if (countFillers(segment.text) >= 2) {
    return "filler";
  }

  if (segment.text.length >= 180) {
    return "long_answer";
  }

  return null;
}

export async function detectCoachingPrompts(segment: TranscriptSegment, context: CoachingMessageContext = {}): Promise<CoachingPrompt[]> {
  if (!segment.isFinal || segment.source !== "microphone") {
    return [];
  }

  const rule = detectRule(segment);
  if (!rule) {
    return [];
  }

  const coachMessage = await buildCoachMessageWithAi(rule, segment.text, context);
  if (!coachMessage) {
    return [];
  }

  return [
    {
      id: randomUUID(),
      sessionId: segment.sessionId,
      speakerId: segment.speakerId,
      speakerLabel: segment.speakerLabel,
      severity: rule === "filler" ? "warning" : "info",
      title: coachMessage.title,
      message: coachMessage.message,
      createdAt: new Date().toISOString(),
    },
  ];
}
