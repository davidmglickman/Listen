export type CalendarProvider = "google" | "microsoft" | "mock";
export type MeetingProvider = "google_meet" | "microsoft_teams" | "zoom" | "generic";
export type LaunchStrategy = "browser" | "native_app";
export type AudioSourceKind = "system" | "microphone";
export type SessionStatus = "idle" | "scheduled" | "launching" | "active" | "stopping" | "completed";
export type SessionStopReason = "manual" | "calendar_end" | "meeting_window_closed" | "audio_inactive" | "provider_end_state" | "unknown";
export interface MeetingRecord {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    joinUrl: string;
    provider: MeetingProvider;
    calendarProvider: CalendarProvider;
    launchStrategy: LaunchStrategy;
    notes?: string;
}
export interface TranscriptSegment {
    id: string;
    sessionId: string;
    source: AudioSourceKind;
    text: string;
    isFinal: boolean;
    createdAt: string;
}
export interface CoachingPrompt {
    id: string;
    sessionId: string;
    severity: "info" | "warning";
    title: string;
    message: string;
    createdAt: string;
}
export interface SessionSummary {
    sessionId: string;
    headline: string;
    decisions: string[];
    actionItems: string[];
    openQuestions: string[];
    coachingRecap: string[];
    completedAt: string;
}
export interface ActiveSession {
    id: string;
    meetingId: string;
    startedAt: string;
    expectedEndAt: string;
    status: SessionStatus;
    stopReason?: SessionStopReason;
}
export interface CalendarConnection {
    provider: CalendarProvider;
    connected: boolean;
    accountLabel: string;
}
export interface AppSnapshot {
    calendarConnections: CalendarConnection[];
    upcomingMeetings: MeetingRecord[];
    pendingPopupMeeting: MeetingRecord | null;
    activeSession: ActiveSession | null;
    transcript: TranscriptSegment[];
    coaching: CoachingPrompt[];
    lastSummary: SessionSummary | null;
}
