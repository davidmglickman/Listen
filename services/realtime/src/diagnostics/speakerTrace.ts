import type { AudioSourceKind } from "@listen/shared";

export type SpeakerResolutionDecision =
  | "microphone"
  | "existing_speaker_id"
  | "recent_guest_reuse"
  | "new_guest_from_attendee"
  | "new_guest_fallback"
  | "unresolved_generic_guest";

export interface SpeakerResolutionTrace {
  source: AudioSourceKind;
  originalSpeakerId: number | null;
  resolvedSpeakerId: number | null;
  resolvedSpeakerLabel: string;
  uniqueSpeakerCount: number;
  decision: SpeakerResolutionDecision;
  occurredAt: string;
  textPreview: string;
}

const MAX_PREVIEW_LENGTH = 120;

export function clipTraceTextPreview(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}