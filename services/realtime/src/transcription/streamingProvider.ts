import type { AudioSourceKind } from "@listen/shared";

export interface TranscriptionSegment {
  source: AudioSourceKind;
  text: string;
  isFinal: boolean;
  speakerId?: number | null;
  speakerLabel?: string | null;
  createdAt: string;
}

export interface StreamingTranscriptionProvider {
  startSession(sessionId: string, onSegment: (segment: TranscriptionSegment) => void): Promise<void>;
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

interface BufferedSourceState {
  chunks: Buffer[];
  byteLength: number;
  flushTimer: NodeJS.Timeout | null;
  flushing: boolean;
}

interface DeepgramSession {
  onSegment: (segment: TranscriptionSegment) => void;
  microphone: BufferedSourceState;
  system: BufferedSourceState;
  guestSpeakerLabels: Map<number, string>;
  nextGuestSpeakerOrdinal: number;
}

const STREAM_SAMPLE_RATE = 16_000;
const CHANNEL_COUNT = 1;
const BYTES_PER_SAMPLE = 2;
// Short 2-3s flushes are fast, but they starve diarization of enough turn-taking context.
// A larger window improves guest separation at the cost of a bit more latency.
const TARGET_FLUSH_MS = 7_500;
const TARGET_FLUSH_BYTES = STREAM_SAMPLE_RATE * CHANNEL_COUNT * BYTES_PER_SAMPLE * 8;

function getDeepgramApiKey(): string {
  return process.env.DEEPGRAM_API_KEY?.trim() ?? "";
}

function getDeepgramModel(): string {
  return process.env.DEEPGRAM_MODEL?.trim() || "nova-3";
}

function getDeepgramLanguage(): string {
  return process.env.DEEPGRAM_LANGUAGE?.trim() || "en-US";
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

function getSpeakerLabel(session: DeepgramSession, source: AudioSourceKind, speakerId: number | null): string | null {
  if (source === "microphone") {
    return "You";
  }

  if (speakerId === null) {
    return "Guest";
  }

  const existingLabel = session.guestSpeakerLabels.get(speakerId);
  if (existingLabel) {
    return existingLabel;
  }

  session.nextGuestSpeakerOrdinal += 1;
  const nextLabel = `Guest ${session.nextGuestSpeakerOrdinal}`;
  session.guestSpeakerLabels.set(speakerId, nextLabel);
  return nextLabel;
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
  async startSession(_sessionId: string, _onSegment: (segment: TranscriptionSegment) => void): Promise<void> {
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

  async startSession(sessionId: string, onSegment: (segment: TranscriptionSegment) => void): Promise<void> {
    this.sessions.set(sessionId, {
      onSegment,
      microphone: createSourceState(),
      system: createSourceState(),
      guestSpeakerLabels: new Map<number, string>(),
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

    try {
      const response = await fetch(createDeepgramUrl(), {
        method: "POST",
        headers: {
          Authorization: `Token ${getDeepgramApiKey()}`,
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
        for (const utterance of utterances) {
          session.onSegment({
            source,
            speakerId: utterance.speakerId,
            speakerLabel: getSpeakerLabel(session, source, utterance.speakerId),
            text: utterance.text,
            isFinal: true,
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }

      const text = parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (!text) {
        return;
      }

      console.log(`[deepgram] transcript source=${source} text=${text}`);
      session.onSegment({
        source,
        speakerId: null,
        speakerLabel: getSpeakerLabel(session, source, null),
        text,
        isFinal: true,
        createdAt: new Date().toISOString(),
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
  if (!getDeepgramApiKey()) {
    return new NoopStreamingTranscriptionProvider();
  }

  return new DeepgramStreamingTranscriptionProvider();
}
