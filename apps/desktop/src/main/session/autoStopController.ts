import { EventEmitter } from "node:events";

import type { SessionStopReason } from "@listen/shared";

interface AutoStopOptions {
  calendarGraceMs: number;
  inactivityMs: number;
  confirmationMs: number;
  evaluationIntervalMs: number;
}

export class AutoStopController extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private activeSessionId: string | null = null;
  private expectedEndAtMs = 0;
  private lastAudioActivityAt = 0;
  private meetingWindowClosedAt: number | null = null;
  private providerEndStateAt: number | null = null;
  private readonly options: AutoStopOptions;

  constructor(options?: Partial<AutoStopOptions>) {
    super();
    this.options = {
      calendarGraceMs: 2 * 60_000,
      inactivityMs: 90_000,
      confirmationMs: 10_000,
      evaluationIntervalMs: 5_000,
      ...options,
    };
  }

  arm(sessionId: string, expectedEndAt: string): void {
    this.disarm();
    this.activeSessionId = sessionId;
    this.expectedEndAtMs = new Date(expectedEndAt).getTime();
    this.lastAudioActivityAt = Date.now();
    this.interval = setInterval(() => {
      this.evaluate();
    }, this.options.evaluationIntervalMs);
  }

  noteAudioActivity(): void {
    if (!this.activeSessionId) {
      return;
    }

    this.lastAudioActivityAt = Date.now();
  }

  noteMeetingWindowClosed(): void {
    if (!this.activeSessionId || this.meetingWindowClosedAt) {
      return;
    }

    this.meetingWindowClosedAt = Date.now();
    this.evaluate();
  }

  noteProviderEndState(): void {
    if (!this.activeSessionId || this.providerEndStateAt) {
      return;
    }

    this.providerEndStateAt = Date.now();
    this.evaluate();
  }

  trigger(reason: SessionStopReason): void {
    if (!this.activeSessionId) {
      return;
    }

    this.emit("stopRequested", this.activeSessionId, reason);
  }

  disarm(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.activeSessionId = null;
    this.expectedEndAtMs = 0;
    this.lastAudioActivityAt = 0;
    this.meetingWindowClosedAt = null;
    this.providerEndStateAt = null;
  }

  private evaluate(): void {
    if (!this.activeSessionId) {
      return;
    }

    const now = Date.now();
    const inactiveTooLong = now - this.lastAudioActivityAt >= this.options.inactivityMs;

    if (this.providerEndStateAt && now - this.providerEndStateAt >= this.options.confirmationMs) {
      this.trigger("provider_end_state");
      return;
    }

    if (this.meetingWindowClosedAt && now - this.meetingWindowClosedAt >= this.options.confirmationMs) {
      this.trigger("meeting_window_closed");
      return;
    }

    const calendarDue = now >= this.expectedEndAtMs + this.options.calendarGraceMs;
    if (calendarDue && inactiveTooLong) {
      this.trigger("calendar_end");
      return;
    }

    if (inactiveTooLong && now >= this.expectedEndAtMs) {
      this.trigger("audio_inactive");
    }
  }
}
