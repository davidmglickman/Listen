import { z } from "zod";
export declare const SessionStartEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"session_start">;
    sessionId: z.ZodString;
    meetingId: z.ZodString;
    expectedEndAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "session_start";
    sessionId: string;
    meetingId: string;
    expectedEndAt: string;
}, {
    kind: "session_start";
    sessionId: string;
    meetingId: string;
    expectedEndAt: string;
}>;
export declare const SessionStopEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"session_stop">;
    sessionId: z.ZodString;
    reason: z.ZodEnum<["manual", "calendar_end", "meeting_window_closed", "audio_inactive", "provider_end_state", "unknown"]>;
}, "strip", z.ZodTypeAny, {
    kind: "session_stop";
    sessionId: string;
    reason: "manual" | "calendar_end" | "meeting_window_closed" | "audio_inactive" | "provider_end_state" | "unknown";
}, {
    kind: "session_stop";
    sessionId: string;
    reason: "manual" | "calendar_end" | "meeting_window_closed" | "audio_inactive" | "provider_end_state" | "unknown";
}>;
export declare const AudioChunkEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"audio_chunk">;
    sessionId: z.ZodString;
    source: z.ZodEnum<["system", "microphone"]>;
    sampleRate: z.ZodNumber;
    payloadBase64: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "audio_chunk";
    sessionId: string;
    source: "system" | "microphone";
    sampleRate: number;
    payloadBase64: string;
    createdAt: string;
}, {
    kind: "audio_chunk";
    sessionId: string;
    source: "system" | "microphone";
    sampleRate: number;
    payloadBase64: string;
    createdAt: string;
}>;
export declare const DebugTranscriptEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"debug_transcript">;
    sessionId: z.ZodString;
    source: z.ZodEnum<["system", "microphone"]>;
    text: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "debug_transcript";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
}, {
    kind: "debug_transcript";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
}>;
export declare const TranscriptSegmentEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"transcript_segment">;
    sessionId: z.ZodString;
    segmentId: z.ZodString;
    source: z.ZodEnum<["system", "microphone"]>;
    text: z.ZodString;
    isFinal: z.ZodBoolean;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "transcript_segment";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
    segmentId: string;
    isFinal: boolean;
}, {
    kind: "transcript_segment";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
    segmentId: string;
    isFinal: boolean;
}>;
export declare const CoachingPromptEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"coaching_prompt">;
    sessionId: z.ZodString;
    promptId: z.ZodString;
    severity: z.ZodEnum<["info", "warning"]>;
    title: z.ZodString;
    message: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "coaching_prompt";
    message: string;
    sessionId: string;
    createdAt: string;
    promptId: string;
    severity: "info" | "warning";
    title: string;
}, {
    kind: "coaching_prompt";
    message: string;
    sessionId: string;
    createdAt: string;
    promptId: string;
    severity: "info" | "warning";
    title: string;
}>;
export declare const SummaryReadyEventSchema: z.ZodObject<{
    kind: z.ZodLiteral<"summary_ready">;
    sessionId: z.ZodString;
    headline: z.ZodString;
    decisions: z.ZodArray<z.ZodString, "many">;
    actionItems: z.ZodArray<z.ZodString, "many">;
    openQuestions: z.ZodArray<z.ZodString, "many">;
    coachingRecap: z.ZodArray<z.ZodString, "many">;
    completedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "summary_ready";
    sessionId: string;
    headline: string;
    decisions: string[];
    actionItems: string[];
    openQuestions: string[];
    coachingRecap: string[];
    completedAt: string;
}, {
    kind: "summary_ready";
    sessionId: string;
    headline: string;
    decisions: string[];
    actionItems: string[];
    openQuestions: string[];
    coachingRecap: string[];
    completedAt: string;
}>;
export declare const ListenInboundEventSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"session_start">;
    sessionId: z.ZodString;
    meetingId: z.ZodString;
    expectedEndAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "session_start";
    sessionId: string;
    meetingId: string;
    expectedEndAt: string;
}, {
    kind: "session_start";
    sessionId: string;
    meetingId: string;
    expectedEndAt: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"session_stop">;
    sessionId: z.ZodString;
    reason: z.ZodEnum<["manual", "calendar_end", "meeting_window_closed", "audio_inactive", "provider_end_state", "unknown"]>;
}, "strip", z.ZodTypeAny, {
    kind: "session_stop";
    sessionId: string;
    reason: "manual" | "calendar_end" | "meeting_window_closed" | "audio_inactive" | "provider_end_state" | "unknown";
}, {
    kind: "session_stop";
    sessionId: string;
    reason: "manual" | "calendar_end" | "meeting_window_closed" | "audio_inactive" | "provider_end_state" | "unknown";
}>, z.ZodObject<{
    kind: z.ZodLiteral<"audio_chunk">;
    sessionId: z.ZodString;
    source: z.ZodEnum<["system", "microphone"]>;
    sampleRate: z.ZodNumber;
    payloadBase64: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "audio_chunk";
    sessionId: string;
    source: "system" | "microphone";
    sampleRate: number;
    payloadBase64: string;
    createdAt: string;
}, {
    kind: "audio_chunk";
    sessionId: string;
    source: "system" | "microphone";
    sampleRate: number;
    payloadBase64: string;
    createdAt: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"debug_transcript">;
    sessionId: z.ZodString;
    source: z.ZodEnum<["system", "microphone"]>;
    text: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "debug_transcript";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
}, {
    kind: "debug_transcript";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
}>]>;
export declare const ListenOutboundEventSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"transcript_segment">;
    sessionId: z.ZodString;
    segmentId: z.ZodString;
    source: z.ZodEnum<["system", "microphone"]>;
    text: z.ZodString;
    isFinal: z.ZodBoolean;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "transcript_segment";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
    segmentId: string;
    isFinal: boolean;
}, {
    kind: "transcript_segment";
    sessionId: string;
    source: "system" | "microphone";
    createdAt: string;
    text: string;
    segmentId: string;
    isFinal: boolean;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"coaching_prompt">;
    sessionId: z.ZodString;
    promptId: z.ZodString;
    severity: z.ZodEnum<["info", "warning"]>;
    title: z.ZodString;
    message: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "coaching_prompt";
    message: string;
    sessionId: string;
    createdAt: string;
    promptId: string;
    severity: "info" | "warning";
    title: string;
}, {
    kind: "coaching_prompt";
    message: string;
    sessionId: string;
    createdAt: string;
    promptId: string;
    severity: "info" | "warning";
    title: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"summary_ready">;
    sessionId: z.ZodString;
    headline: z.ZodString;
    decisions: z.ZodArray<z.ZodString, "many">;
    actionItems: z.ZodArray<z.ZodString, "many">;
    openQuestions: z.ZodArray<z.ZodString, "many">;
    coachingRecap: z.ZodArray<z.ZodString, "many">;
    completedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "summary_ready";
    sessionId: string;
    headline: string;
    decisions: string[];
    actionItems: string[];
    openQuestions: string[];
    coachingRecap: string[];
    completedAt: string;
}, {
    kind: "summary_ready";
    sessionId: string;
    headline: string;
    decisions: string[];
    actionItems: string[];
    openQuestions: string[];
    coachingRecap: string[];
    completedAt: string;
}>]>;
export type ListenInboundEvent = z.infer<typeof ListenInboundEventSchema>;
export type ListenOutboundEvent = z.infer<typeof ListenOutboundEventSchema>;
