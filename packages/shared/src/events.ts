import { z } from "zod";

const AudioSourceKindSchema = z.enum(["system", "microphone"]);
const CallFunctionSchema = z.enum(["sales", "recruiting", "partnership", "internal"]);
const CalendarProviderSchema = z.enum(["google", "microsoft", "mock"]);
const MeetingProviderSchema = z.enum(["google_meet", "microsoft_teams", "zoom", "generic"]);
const SessionStopReasonSchema = z.enum([
  "manual",
  "calendar_end",
  "meeting_window_closed",
  "audio_inactive",
  "provider_end_state",
  "unknown",
]);

export const MeetingContextSchema = z.object({
  callFunction: CallFunctionSchema,
  callType: z.string(),
  callGoal: z.string(),
  userRole: z.string(),
  guestRole: z.string(),
  desiredOutcome: z.string(),
  notes: z.string(),
});

export const TranslationParticipantPreferenceSchema = z.object({
  language: z.string().min(1),
  voiceEnabled: z.boolean(),
  voiceName: z.string().min(1).nullable().optional(),
});

export const SessionParticipantTranslationPreferencesSchema = z.object({
  host: TranslationParticipantPreferenceSchema,
  guest: TranslationParticipantPreferenceSchema,
});

const MeetingAttendeeEventSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().optional(),
});

export const SessionStartEventSchema = z.object({
  kind: z.literal("session_start"),
  sessionId: z.string(),
  meetingId: z.string(),
  expectedEndAt: z.string(),
  meetingTitle: z.string(),
  meetingProvider: MeetingProviderSchema,
  calendarProvider: CalendarProviderSchema,
  meetingContext: MeetingContextSchema.nullable(),
  attendees: z.array(MeetingAttendeeEventSchema).optional(),
  participantPreferences: SessionParticipantTranslationPreferencesSchema.optional(),
});

export const SessionStopEventSchema = z.object({
  kind: z.literal("session_stop"),
  sessionId: z.string(),
  reason: SessionStopReasonSchema,
});

export const AudioChunkEventSchema = z.object({
  kind: z.literal("audio_chunk"),
  sessionId: z.string(),
  source: AudioSourceKindSchema,
  sampleRate: z.number().int().positive(),
  payloadBase64: z.string(),
  createdAt: z.string(),
});

export const DebugTranscriptEventSchema = z.object({
  kind: z.literal("debug_transcript"),
  sessionId: z.string(),
  source: AudioSourceKindSchema,
  speakerId: z.number().int().nullable().optional(),
  speakerLabel: z.string().nullable().optional(),
  text: z.string().min(1),
  createdAt: z.string(),
});

export const TranscriptSegmentEventSchema = z.object({
  kind: z.literal("transcript_segment"),
  sessionId: z.string(),
  segmentId: z.string(),
  source: AudioSourceKindSchema,
  speakerId: z.number().int().nullable().optional(),
  speakerLabel: z.string().nullable().optional(),
  text: z.string(),
  isFinal: z.boolean(),
  createdAt: z.string(),
});

export const TranslatedSegmentEventSchema = z.object({
  kind: z.literal("translated_segment"),
  sessionId: z.string(),
  segmentId: z.string(),
  translatedText: z.string().min(1),
  translatedLanguage: z.string().min(1),
  createdAt: z.string(),
});

export const TranslationStatusEventSchema = z.object({
  kind: z.literal("translation_status"),
  sessionId: z.string(),
  status: z.enum(["idle", "starting", "active", "error"]),
  detail: z.string(),
  createdAt: z.string(),
});

export const ParticipantPreferencesUpdatedEventSchema = z.object({
  kind: z.literal("participant_preferences_updated"),
  sessionId: z.string(),
  participantPreferences: SessionParticipantTranslationPreferencesSchema,
  createdAt: z.string(),
});

export const CoachingPromptEventSchema = z.object({
  kind: z.literal("coaching_prompt"),
  sessionId: z.string(),
  promptId: z.string(),
  speakerId: z.number().int().nullable().optional(),
  speakerLabel: z.string().nullable().optional(),
  severity: z.enum(["info", "warning"]),
  title: z.string(),
  message: z.string(),
  createdAt: z.string(),
});

export const SummaryReadyEventSchema = z.object({
  kind: z.literal("summary_ready"),
  sessionId: z.string(),
  headline: z.string(),
  decisions: z.array(z.string()),
  actionItems: z.array(z.string()),
  openQuestions: z.array(z.string()),
  coachingRecap: z.array(z.string()),
  completedAt: z.string(),
});

export const ListenInboundEventSchema = z.discriminatedUnion("kind", [
  SessionStartEventSchema,
  SessionStopEventSchema,
  AudioChunkEventSchema,
  DebugTranscriptEventSchema,
]);

export const ListenOutboundEventSchema = z.discriminatedUnion("kind", [
  TranscriptSegmentEventSchema,
  TranslatedSegmentEventSchema,
  TranslationStatusEventSchema,
  ParticipantPreferencesUpdatedEventSchema,
  CoachingPromptEventSchema,
  SummaryReadyEventSchema,
]);

export type ListenInboundEvent = z.infer<typeof ListenInboundEventSchema>;
export type ListenOutboundEvent = z.infer<typeof ListenOutboundEventSchema>;
