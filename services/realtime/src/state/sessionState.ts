import type {
  CalendarProvider,
  CoachingPrompt,
  CoachingSettings,
  MeetingContext,
  MeetingProvider,
  SessionParticipantTranslationPreferences,
  SessionStopReason,
  SessionSummary,
  TranscriptSegment,
} from "@listen/shared";

import type { SpeakerResolutionTrace } from "../diagnostics/speakerTrace";
import { summarizeSession } from "../summary/summarizeSession";

export interface SessionCoachingGuidance {
  orgGuidance: string | null;
  userGuidance: string | null;
  settings: CoachingSettings;
}

const COACHING_PROMPT_COOLDOWN_MS = Number(process.env.LISTEN_COACHING_PROMPT_COOLDOWN_MS ?? 90_000);
const MAX_SPEAKER_RESOLUTION_TRACES = 300;

function getEffectivePromptCooldownMs(settings: CoachingSettings): number {
  if (settings.frequency === "minimal") {
    return COACHING_PROMPT_COOLDOWN_MS * 2;
  }

  if (settings.frequency === "proactive") {
    return Math.max(10_000, Math.round(COACHING_PROMPT_COOLDOWN_MS / 2));
  }

  return COACHING_PROMPT_COOLDOWN_MS;
}

export class RollingSessionState {
  private readonly transcript: TranscriptSegment[] = [];
  private readonly prompts: CoachingPrompt[] = [];
  private readonly speakerResolutionTraces: SpeakerResolutionTrace[] = [];
  private readonly recentPromptTimes = new Map<string, number>();
  private participantPreferences: SessionParticipantTranslationPreferences | null;

  constructor(
    public readonly sessionId: string,
    public readonly meetingId: string,
    public readonly meetingTitle: string,
    public readonly meetingProvider: MeetingProvider,
    public readonly calendarProvider: CalendarProvider,
    public readonly startedAt: string,
    public readonly expectedEndAt: string,
    private readonly meetingContext: MeetingContext | null,
    private readonly coachingGuidance: SessionCoachingGuidance,
    participantPreferences: SessionParticipantTranslationPreferences | null,
  ) {
    this.participantPreferences = participantPreferences;
  }

  appendTranscript(segment: TranscriptSegment): void {
    this.transcript.push(segment);
  }

  appendPrompts(prompts: CoachingPrompt[]): void {
    this.prompts.push(...prompts);
  }

  appendSpeakerResolutionTrace(trace: SpeakerResolutionTrace): void {
    this.speakerResolutionTraces.push(trace);
    if (this.speakerResolutionTraces.length > MAX_SPEAKER_RESOLUTION_TRACES) {
      this.speakerResolutionTraces.splice(0, this.speakerResolutionTraces.length - MAX_SPEAKER_RESOLUTION_TRACES);
    }
  }

  filterPromptsForEmission(prompts: CoachingPrompt[]): CoachingPrompt[] {
    const accepted: CoachingPrompt[] = [];
    const cooldownMs = getEffectivePromptCooldownMs(this.coachingGuidance.settings);

    for (const prompt of prompts) {
      const key = `${prompt.speakerLabel ?? "unknown"}|${prompt.title.trim().toLowerCase()}`;
      const promptTime = Date.parse(prompt.createdAt);
      const now = Number.isFinite(promptTime) ? promptTime : Date.now();
      const previousTime = this.recentPromptTimes.get(key);

      if (typeof previousTime === "number" && now - previousTime < cooldownMs) {
        continue;
      }

      this.recentPromptTimes.set(key, now);
      accepted.push(prompt);
    }

    return accepted;
  }

  getTranscript(): TranscriptSegment[] {
    return [...this.transcript];
  }

  getPrompts(): CoachingPrompt[] {
    return [...this.prompts];
  }

  getSpeakerResolutionTraces(): SpeakerResolutionTrace[] {
    return [...this.speakerResolutionTraces];
  }

  getMeetingContext(): MeetingContext | null {
    return this.meetingContext;
  }

  getCoachingGuidance(): SessionCoachingGuidance {
    return this.coachingGuidance;
  }

  getParticipantPreferences(): SessionParticipantTranslationPreferences | null {
    return this.participantPreferences;
  }

  replaceParticipantPreferences(value: SessionParticipantTranslationPreferences | null): SessionParticipantTranslationPreferences | null {
    this.participantPreferences = value;
    return this.participantPreferences;
  }

  async complete(_reason: SessionStopReason): Promise<SessionSummary> {
    return summarizeSession(this.sessionId, this.transcript, this.prompts, this.meetingContext, this.coachingGuidance);
  }
}
