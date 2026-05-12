"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListenOutboundEventSchema = exports.ListenInboundEventSchema = exports.SummaryReadyEventSchema = exports.CoachingPromptEventSchema = exports.TranscriptSegmentEventSchema = exports.DebugTranscriptEventSchema = exports.AudioChunkEventSchema = exports.SessionStopEventSchema = exports.SessionStartEventSchema = void 0;
const zod_1 = require("zod");
const AudioSourceKindSchema = zod_1.z.enum(["system", "microphone"]);
const SessionStopReasonSchema = zod_1.z.enum([
    "manual",
    "calendar_end",
    "meeting_window_closed",
    "audio_inactive",
    "provider_end_state",
    "unknown",
]);
exports.SessionStartEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("session_start"),
    sessionId: zod_1.z.string(),
    meetingId: zod_1.z.string(),
    expectedEndAt: zod_1.z.string(),
});
exports.SessionStopEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("session_stop"),
    sessionId: zod_1.z.string(),
    reason: SessionStopReasonSchema,
});
exports.AudioChunkEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("audio_chunk"),
    sessionId: zod_1.z.string(),
    source: AudioSourceKindSchema,
    sampleRate: zod_1.z.number().int().positive(),
    payloadBase64: zod_1.z.string(),
    createdAt: zod_1.z.string(),
});
exports.DebugTranscriptEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("debug_transcript"),
    sessionId: zod_1.z.string(),
    source: AudioSourceKindSchema,
    speakerId: zod_1.z.number().int().nullable().optional(),
    speakerLabel: zod_1.z.string().nullable().optional(),
    text: zod_1.z.string().min(1),
    createdAt: zod_1.z.string(),
});
exports.TranscriptSegmentEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("transcript_segment"),
    sessionId: zod_1.z.string(),
    segmentId: zod_1.z.string(),
    source: AudioSourceKindSchema,
    text: zod_1.z.string(),
    isFinal: zod_1.z.boolean(),
    createdAt: zod_1.z.string(),
});
exports.CoachingPromptEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("coaching_prompt"),
    sessionId: zod_1.z.string(),
    promptId: zod_1.z.string(),
    severity: zod_1.z.enum(["info", "warning"]),
    title: zod_1.z.string(),
    message: zod_1.z.string(),
    createdAt: zod_1.z.string(),
});
exports.SummaryReadyEventSchema = zod_1.z.object({
    kind: zod_1.z.literal("summary_ready"),
    sessionId: zod_1.z.string(),
    headline: zod_1.z.string(),
    decisions: zod_1.z.array(zod_1.z.string()),
    actionItems: zod_1.z.array(zod_1.z.string()),
    openQuestions: zod_1.z.array(zod_1.z.string()),
    coachingRecap: zod_1.z.array(zod_1.z.string()),
    completedAt: zod_1.z.string(),
});
exports.ListenInboundEventSchema = zod_1.z.discriminatedUnion("kind", [
    exports.SessionStartEventSchema,
    exports.SessionStopEventSchema,
    exports.AudioChunkEventSchema,
    exports.DebugTranscriptEventSchema,
]);
exports.ListenOutboundEventSchema = zod_1.z.discriminatedUnion("kind", [
    exports.TranscriptSegmentEventSchema,
    exports.CoachingPromptEventSchema,
    exports.SummaryReadyEventSchema,
]);
//# sourceMappingURL=events.js.map