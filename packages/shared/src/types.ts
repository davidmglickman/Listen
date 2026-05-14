export type CalendarProvider = "google" | "microsoft" | "mock";
export type MeetingProvider = "google_meet" | "microsoft_teams" | "zoom" | "generic";
export type LaunchStrategy = "browser" | "native_app";
export type AudioSourceKind = "system" | "microphone";
export type CallFunction = "sales" | "recruiting" | "partnership" | "internal";
export type SessionStatus = "idle" | "scheduled" | "launching" | "active" | "stopping" | "completed";
export type SessionStopReason =
  | "manual"
  | "calendar_end"
  | "meeting_window_closed"
  | "audio_inactive"
  | "provider_end_state"
  | "unknown";
export type CoachingScope = "org" | "user";
export type CoachingStyle = "supportive" | "direct" | "challenger";
export type CoachingDirectness = "gentle" | "balanced" | "blunt";
export type CoachingFrequency = "minimal" | "balanced" | "proactive";

export interface CoachingSettings {
  style: CoachingStyle;
  directness: CoachingDirectness;
  frequency: CoachingFrequency;
}

export interface MeetingAttendeeRecord {
  fullName: string;
  email?: string;
  title?: string;
  linkedInUrl?: string;
  organizationDomain?: string;
  organizationName?: string;
}

export interface MeetingResearchBrief {
  meetingExternalId: string;
  status: "queued" | "running" | "completed" | "failed";
  personSummary?: string;
  organizationSummary?: string;
  recentSignals: string[];
  linkedInUrl?: string;
  sourceLinks: string[];
  updatedAt?: string;
}

export interface MeetingRecord {
  id: string;
  externalId?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  joinUrl: string;
  provider: MeetingProvider;
  calendarProvider: CalendarProvider;
  launchStrategy: LaunchStrategy;
  organizerEmail?: string;
  attendees?: MeetingAttendeeRecord[];
  research?: MeetingResearchBrief;
  notes?: string;
}

export interface MeetingContext {
  callFunction: CallFunction;
  callType: string;
  callGoal: string;
  userRole: string;
  guestRole: string;
  desiredOutcome: string;
  notes: string;
}

export interface TranslationParticipantPreference {
  language: string;
  voiceEnabled: boolean;
  voiceName?: string | null;
}

export interface SessionParticipantTranslationPreferences {
  host: TranslationParticipantPreference;
  guest: TranslationParticipantPreference;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  source: AudioSourceKind;
  speakerId?: number | null;
  speakerLabel?: string | null;
  text: string;
  translatedText?: string | null;
  translatedLanguage?: string | null;
  isFinal: boolean;
  createdAt: string;
}

export interface CoachingPrompt {
  id: string;
  sessionId: string;
  speakerId?: number | null;
  speakerLabel?: string | null;
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

export interface SessionHistoryItem {
  sessionId: string;
  meetingId: string;
  meetingTitle: string;
  meetingProvider: MeetingProvider;
  calendarProvider: CalendarProvider;
  startedAt: string;
  expectedEndAt: string;
  completedAt: string;
  stopReason: SessionStopReason;
  summary: SessionSummary;
  context: MeetingContext | null;
  participantPreferences: SessionParticipantTranslationPreferences | null;
}

export interface SessionHistoryDetail extends SessionHistoryItem {
  transcript: TranscriptSegment[];
  coaching: CoachingPrompt[];
}

export interface SessionQuestionAnswer {
  answer: string;
  evidence: string[];
}

export interface CoachingProfile {
  id: string;
  scope: CoachingScope;
  scopeId: string;
  label: string;
  guidance: string;
  settings?: CoachingSettings;
  updatedAt: string;
}

export interface OrgContextDocument {
  id: string;
  title: string;
  content: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  mimeType?: string | null;
  updatedAt: string;
}

export interface MeetingContextTemplate {
  id: string;
  title: string;
  context: MeetingContext;
  updatedAt: string;
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

export interface AppAuthUser {
  id: string;
  organizationId: string | null;
  email: string | null;
  fullName: string | null;
  role: "owner" | "admin" | "member" | null;
  status: "invited" | "active" | "disabled" | null;
}

export interface AppAuthState {
  configured: boolean;
  signedIn: boolean;
  pendingEmail: string | null;
  user: AppAuthUser | null;
}

export interface AdminManagedUser {
  id: string;
  organizationId: string;
  email: string | null;
  fullName: string | null;
  role: "owner" | "admin" | "member";
  status: "invited" | "active" | "disabled";
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminUserInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: "owner" | "admin" | "member";
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  lastSentAt: string | null;
  acceptedUserId: string | null;
}

export interface AdminUserDirectory {
  viewer: AppAuthUser;
  users: AdminManagedUser[];
  invitations: AdminUserInvitation[];
}

export interface AudioCaptureHealth {
  status: "idle" | "starting" | "active" | "error";
  detail: string;
  chunkCount: number;
  lastActivityAt: string | null;
}

export interface CaptureHealth {
  microphone: AudioCaptureHealth;
  system: AudioCaptureHealth;
}

export interface TranslationHealth {
  status: "idle" | "starting" | "active" | "error";
  detail: string;
  lastUpdatedAt: string | null;
}

export interface AppSnapshot {
  calendarConnections: CalendarConnection[];
  appAuth: AppAuthState;
  upcomingMeetings: MeetingRecord[];
  pendingPopupMeeting: MeetingRecord | null;
  activeSession: ActiveSession | null;
  participantPreferences: SessionParticipantTranslationPreferences | null;
  captureHealth: CaptureHealth;
  translationHealth: TranslationHealth;
  transcript: TranscriptSegment[];
  coaching: CoachingPrompt[];
  lastSummary: SessionSummary | null;
}
