import type { AudioSourceKind } from "@listen/shared";

import {
  clipTraceTextPreview,
  type SpeakerResolutionDecision,
  type SpeakerResolutionTrace,
} from "../diagnostics/speakerTrace";
import { getDeepgramRuntimeConfig } from "../runtime/runtimeSecrets";

export interface TranscriptionSegment {
  source: AudioSourceKind;
  text: string;
  isFinal: boolean;
  speakerId?: number | null;
  speakerLabel?: string | null;
  createdAt: string;
}

interface TranscriptionAttendeeCandidate {
  fullName: string;
  email?: string;
}

export interface StreamingTranscriptionProvider {
  startSession(
    sessionId: string,
    onSegment: (segment: TranscriptionSegment) => void,
    options?: { attendees?: TranscriptionAttendeeCandidate[]; onTrace?: (trace: SpeakerResolutionTrace) => void },
  ): Promise<void>;
  ingestChunk(sessionId: string, source: AudioSourceKind, payloadBase64: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

interface DeepgramAlternative {
  transcript?: string;
}

interface DeepgramUtterance {
  transcript?: string;
  speaker?: number;
}

interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
}

interface DeepgramResponse {
  results?: {
    channels?: DeepgramChannel[];
    utterances?: DeepgramUtterance[];
  };
}

interface GuestParticipant {
  ordinal: number;
  label: string;
  lastSeenAt: string;
}

interface BufferedSourceState {
  chunks: Buffer[];
  byteLength: number;
  flushTimer: NodeJS.Timeout | null;
  flushing: boolean;
}

interface DeepgramSession {
  onSegment: (segment: TranscriptionSegment) => void;
  onTrace?: (trace: SpeakerResolutionTrace) => void;
  microphone: BufferedSourceState;
  system: BufferedSourceState;
  guestParticipants: GuestParticipant[];
  availableAttendeeNames: string[];
  nextGuestSpeakerOrdinal: number;
}

const STREAM_SAMPLE_RATE = 16_000;
const CHANNEL_COUNT = 1;
const BYTES_PER_SAMPLE = 2;
// Short 2-3s flushes are fast, but they starve diarization of enough turn-taking context.
// A larger window improves guest separation at the cost of a bit more latency.
const TARGET_FLUSH_MS = 7_500;
const TARGET_FLUSH_BYTES = STREAM_SAMPLE_RATE * CHANNEL_COUNT * BYTES_PER_SAMPLE * 8;
const GUEST_PARTICIPANT_REUSE_WINDOW_MS = 30_000;

function looksLikeEmail(value: string): boolean {
  return /@/.test(value);
}

function isUsefulAttendeeLabel(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (looksLikeEmail(normalized)) {
    return false;
  }

  return !/^guest(?:\s+\d+)?$/i.test(normalized);
}

function normalizeAttendeeNames(attendees: TranscriptionAttendeeCandidate[] | undefined): string[] {
  const seen = new Set<string>();
  const normalizedNames: string[] = [];

  for (const attendee of attendees ?? []) {
    const normalizedName = attendee.fullName.trim().replace(/\s+/g, " ");
    if (!isUsefulAttendeeLabel(normalizedName)) {
      continue;
    }

    const dedupeKey = normalizedName.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedNames.push(normalizedName);
  }

  return normalizedNames;
}

function getDeepgramModel(): string {
  return getDeepgramRuntimeConfig().model;
}

function getDeepgramLanguage(): string {
  return getDeepgramRuntimeConfig().language;
}

function createDeepgramUrl(): string {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", getDeepgramModel());
  url.searchParams.set("language", getDeepgramLanguage());
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("utterances", "true");
  url.searchParams.set("diarize", "true");
  return url.toString();
}

function getRecentGuestParticipants(session: DeepgramSession, occurredAt: string): GuestParticipant[] {
  const occurredAtMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredAtMs)) {
    return [];
  }

  return session.guestParticipants
    .filter((participant) => {
      const lastSeenAtMs = Date.parse(participant.lastSeenAt);
      return Number.isFinite(lastSeenAtMs) && occurredAtMs - lastSeenAtMs <= GUEST_PARTICIPANT_REUSE_WINDOW_MS;
    })
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
}

function createGuestParticipant(session: DeepgramSession, occurredAt: string): GuestParticipant {
  session.nextGuestSpeakerOrdinal += 1;
  const attendeeName = session.availableAttendeeNames[session.nextGuestSpeakerOrdinal - 1] ?? null;
  const participant = {
    ordinal: session.nextGuestSpeakerOrdinal,
    label: attendeeName || `Guest ${session.nextGuestSpeakerOrdinal}`,
    lastSeenAt: occurredAt,
  };
  session.guestParticipants.push(participant);
  return participant;
}

interface GuestParticipantResolution {
  participant: GuestParticipant | null;
  decision: SpeakerResolutionDecision;
}

function resolveGuestParticipant(
  session: DeepgramSession,
  source: AudioSourceKind,
  speakerId: number | null,
  occurredAt: string,
  uniqueSpeakerCount: number,
  requestSpeakerMap: Map<number, GuestParticipant | null>,
): GuestParticipantResolution {
  if (source === "microphone") {
    return {
      participant: null,
      decision: "microphone",
    };
  }

  if (typeof speakerId === "number") {
    const existingParticipant = requestSpeakerMap.get(speakerId);
    if (existingParticipant) {
      existingParticipant.lastSeenAt = occurredAt;
      return {
        participant: existingParticipant,
        decision: "existing_speaker_id",
      };
    }

    if (requestSpeakerMap.has(speakerId)) {
      return {
        participant: null,
        decision: "unresolved_generic_guest",
      };
    }
  }

  const recentParticipants = getRecentGuestParticipants(session, occurredAt);
  if (recentParticipants.length === 1 && uniqueSpeakerCount === 1) {
    const participant = recentParticipants[0];
    participant.lastSeenAt = occurredAt;
    if (typeof speakerId === "number") {
      requestSpeakerMap.set(speakerId, participant);
    }
    return {
      participant,
      decision: "recent_guest_reuse",
    };
  }

  if (uniqueSpeakerCount === 1 && recentParticipants.length > 1) {
    if (typeof speakerId === "number") {
      requestSpeakerMap.set(speakerId, null);
    }
    return {
      participant: null,
      decision: "unresolved_generic_guest",
    };
  }

  if (speakerId === null) {
    return {
      participant: null,
      decision: "unresolved_generic_guest",
    };
  }

  const participant = createGuestParticipant(session, occurredAt);
  requestSpeakerMap.set(speakerId, participant);
  return {
    participant,
    decision: participant.label.startsWith("Guest ") ? "new_guest_fallback" : "new_guest_from_attendee",
  };
}

function getSpeakerSegmentIdentity(
  session: DeepgramSession,
  source: AudioSourceKind,
  speakerId: number | null,
  occurredAt: string,
  uniqueSpeakerCount: number,
  text: string,
  requestSpeakerMap: Map<number, GuestParticipant | null>,
): Pick<TranscriptionSegment, "speakerId" | "speakerLabel"> {
  if (source === "microphone") {
    session.onTrace?.({
      source,
      originalSpeakerId: speakerId,
      resolvedSpeakerId: speakerId ?? null,
      resolvedSpeakerLabel: "You",
      uniqueSpeakerCount,
      decision: "microphone",
      occurredAt,
      textPreview: clipTraceTextPreview(text),
    });
    return {
      speakerId: speakerId ?? null,
      speakerLabel: "You",
    };
  }

  const resolution = resolveGuestParticipant(session, source, speakerId, occurredAt, uniqueSpeakerCount, requestSpeakerMap);
  if (resolution.participant) {
    session.onTrace?.({
      source,
      originalSpeakerId: speakerId,
      resolvedSpeakerId: resolution.participant.ordinal,
      resolvedSpeakerLabel: resolution.participant.label,
      uniqueSpeakerCount,
      decision: resolution.decision,
      occurredAt,
      textPreview: clipTraceTextPreview(text),
    });
    return {
      speakerId: resolution.participant.ordinal,
      speakerLabel: resolution.participant.label,
    };
  }

  session.onTrace?.({
    source,
    originalSpeakerId: speakerId,
    resolvedSpeakerId: null,
    resolvedSpeakerLabel: "Guest",
    uniqueSpeakerCount,
    decision: resolution.decision,
    occurredAt,
    textPreview: clipTraceTextPreview(text),
  });

  return {
    speakerId: null,
    speakerLabel: "Guest",
  };
}

function createSourceState(): BufferedSourceState {
  return {
    chunks: [],
    byteLength: 0,
    flushTimer: null,
    flushing: false,
  };
}

function wrapPcm16AsWav(pcmPayload: Buffer, sampleRate: number, channelCount: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channelCount * BYTES_PER_SAMPLE;
  const blockAlign = channelCount * BYTES_PER_SAMPLE;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmPayload.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmPayload.byteLength, 40);

  return Buffer.concat([header, pcmPayload]);
}

export class NoopStreamingTranscriptionProvider implements StreamingTranscriptionProvider {
  async startSession(
    _sessionId: string,
    _onSegment: (segment: TranscriptionSegment) => void,
    _options?: { attendees?: TranscriptionAttendeeCandidate[]; onTrace?: (trace: SpeakerResolutionTrace) => void },
  ): Promise<void> {
    return;
  }

  async ingestChunk(_sessionId: string, _source: AudioSourceKind, _payloadBase64: string): Promise<void> {
    return;
  }

  async stopSession(_sessionId: string): Promise<void> {
    return;
  }
}

export class DeepgramStreamingTranscriptionProvider implements StreamingTranscriptionProvider {
  private readonly sessions = new Map<string, DeepgramSession>();

  async startSession(
    sessionId: string,
    onSegment: (segment: TranscriptionSegment) => void,
    options?: { attendees?: TranscriptionAttendeeCandidate[]; onTrace?: (trace: SpeakerResolutionTrace) => void },
  ): Promise<void> {
    this.sessions.set(sessionId, {
      onSegment,
      onTrace: options?.onTrace,
      microphone: createSourceState(),
      system: createSourceState(),
      guestParticipants: [],
      availableAttendeeNames: normalizeAttendeeNames(options?.attendees),
      nextGuestSpeakerOrdinal: 0,
    });
  }

  async ingestChunk(sessionId: string, source: AudioSourceKind, payloadBase64: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const sourceState = source === "microphone" ? session.microphone : session.system;
    const chunk = Buffer.from(payloadBase64, "base64");
    if (!chunk.byteLength) {
      return;
    }

    sourceState.chunks.push(chunk);
    sourceState.byteLength += chunk.byteLength;

    if (sourceState.byteLength >= TARGET_FLUSH_BYTES) {
      await this.flushSource(sessionId, source);
      return;
    }

    if (!sourceState.flushTimer) {
      sourceState.flushTimer = setTimeout(() => {
        void this.flushSource(sessionId, source);
      }, TARGET_FLUSH_MS);
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    await this.flushSource(sessionId, "microphone");
    await this.flushSource(sessionId, "system");
    this.clearSourceState(session.microphone);
    this.clearSourceState(session.system);
    this.sessions.delete(sessionId);
  }

  private clearSourceState(sourceState: BufferedSourceState): void {
    if (sourceState.flushTimer) {
      clearTimeout(sourceState.flushTimer);
      sourceState.flushTimer = null;
    }
    sourceState.chunks = [];
    sourceState.byteLength = 0;
  }

  private async flushSource(sessionId: string, source: AudioSourceKind): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const sourceState = source === "microphone" ? session.microphone : session.system;
    if (sourceState.flushTimer) {
      clearTimeout(sourceState.flushTimer);
      sourceState.flushTimer = null;
    }

    if (sourceState.flushing || !sourceState.byteLength) {
      return;
    }

    sourceState.flushing = true;
    const payload = Buffer.concat(sourceState.chunks, sourceState.byteLength);
    const wavPayload = wrapPcm16AsWav(payload, STREAM_SAMPLE_RATE, CHANNEL_COUNT);
    sourceState.chunks = [];
    sourceState.byteLength = 0;
    const deepgramConfig = getDeepgramRuntimeConfig();

    if (!deepgramConfig.apiKey) {
      sourceState.flushing = false;
      return;
    }

    try {
      const response = await fetch(createDeepgramUrl(), {
        method: "POST",
        headers: {
          Authorization: `Token ${deepgramConfig.apiKey}`,
          "Content-Type": "audio/wav",
        },
        body: new Uint8Array(wavPayload),
      });

      if (!response.ok) {
        console.error(`[deepgram] request failed source=${source} status=${response.status} body=${await response.text()}`);
        return;
      }

      const parsed = await response.json() as DeepgramResponse;
      const utterances = parsed.results?.utterances
        ?.map((utterance) => ({
          text: utterance.transcript?.trim() ?? "",
          speakerId: typeof utterance.speaker === "number" ? utterance.speaker : null,
        }))
        .filter((utterance) => utterance.text.length > 0) ?? [];

      if (utterances.length) {
        const createdAt = new Date().toISOString();
        const uniqueSpeakerCount = new Set(
          utterances
            .map((utterance) => utterance.speakerId)
            .filter((speakerId): speakerId is number => typeof speakerId === "number"),
        ).size;
        const requestSpeakerMap = new Map<number, GuestParticipant | null>();

        for (const utterance of utterances) {
          const speakerIdentity = getSpeakerSegmentIdentity(
            session,
            source,
            utterance.speakerId,
            createdAt,
            uniqueSpeakerCount,
            utterance.text,
            requestSpeakerMap,
          );
          session.onSegment({
            source,
            speakerId: speakerIdentity.speakerId,
            speakerLabel: speakerIdentity.speakerLabel,
            text: utterance.text,
            isFinal: true,
            createdAt,
          });
        }
        return;
      }

      const text = parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (!text) {
        return;
      }

      console.log(`[deepgram] transcript source=${source} text=${text}`);
      const createdAt = new Date().toISOString();
      const speakerIdentity = getSpeakerSegmentIdentity(session, source, null, createdAt, 1, text, new Map());
      session.onSegment({
        source,
        speakerId: speakerIdentity.speakerId,
        speakerLabel: speakerIdentity.speakerLabel,
        text,
        isFinal: true,
        createdAt,
      });
    } catch (error) {
      console.error(`[deepgram] request error source=${source}`, error);
    } finally {
      sourceState.flushing = false;
      if (sourceState.byteLength && !sourceState.flushTimer) {
        sourceState.flushTimer = setTimeout(() => {
          void this.flushSource(sessionId, source);
        }, TARGET_FLUSH_MS);
      }
    }
  }
}

export function createStreamingTranscriptionProvider(): StreamingTranscriptionProvider {
  return new DeepgramStreamingTranscriptionProvider();
}
