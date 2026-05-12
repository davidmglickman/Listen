import { contextBridge, ipcRenderer } from "electron";

import type { AppSnapshot, AudioSourceKind, CoachingSettings, MeetingContext, MeetingContextTemplate, OrgContextDocument, SessionHistoryDetail, SessionHistoryItem, SessionQuestionAnswer, SessionSummary } from "@listen/shared";

type StateListener = (snapshot: AppSnapshot) => void;
type RuntimeCapabilities = {
  aiConfigured: boolean;
  cloudTranscriptionConfigured: boolean;
};
type RuntimeSecrets = {
  aiApiKey: string;
  transcriptionApiKey: string;
};
type UpdaterState = {
  enabled: boolean;
  availability: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string | null;
  progress: number | null;
  message: string;
};
type CoachingPreferences = {
  guidance: string;
  settings: CoachingSettings;
};
type MeetingEmailMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};
type MeetingEmailHistory = {
  status: "ready" | "not_connected" | "needs_reconnect" | "unavailable" | "error";
  note: string;
  messages: MeetingEmailMessage[];
};
type RelatedMeetingSession = {
  sessionId: string;
  meetingTitle: string;
  completedAt: string;
  headline: string;
  matchReason: string;
  transcriptNote: string;
};
type MeetingSessionHistory = {
  status: "ready" | "unavailable" | "error";
  note: string;
  sessions: RelatedMeetingSession[];
};
type MeetingDriveDocument = {
  id: string;
  title: string;
  modifiedAt: string;
  mimeType: string;
  sourceUrl: string;
  snippet: string;
};
type MeetingDriveHistory = {
  status: "ready" | "not_connected" | "needs_reconnect" | "unavailable" | "error";
  note: string;
  documents: MeetingDriveDocument[];
};
type StoredMeetingLaunchContext = {
  cacheKey: string;
  context: MeetingContext;
};
type OrgDocumentInput = {
  title: string;
  content: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  mimeType?: string | null;
};
type ContextQuestionDocument = {
  title: string;
  content: string;
  sourceUrl?: string | null;
};
type ContextQuestionPayload = {
  question: string;
  title: string;
  summary?: SessionSummary | null;
  context?: MeetingContext | null;
  transcript?: SessionHistoryDetail["transcript"];
  coaching?: SessionHistoryDetail["coaching"];
  documents?: ContextQuestionDocument[];
};

type UpdaterListener = (state: UpdaterState) => void;

contextBridge.exposeInMainWorld("listenBridge", {
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:get-snapshot"),
  getRuntimeCapabilities: (): Promise<RuntimeCapabilities> => ipcRenderer.invoke("app:get-runtime-capabilities"),
  getRuntimeSecrets: (): Promise<RuntimeSecrets> => ipcRenderer.invoke("runtime-secrets:get"),
  saveRuntimeSecrets: (secrets: RuntimeSecrets): Promise<RuntimeSecrets> => ipcRenderer.invoke("runtime-secrets:save", secrets),
  getUpdaterState: (): Promise<UpdaterState> => ipcRenderer.invoke("updater:get-state"),
  checkForUpdates: (): Promise<UpdaterState> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("updater:install"),
  getCoachingPreferences: (): Promise<CoachingPreferences> => ipcRenderer.invoke("coaching:get-preferences"),
  saveCoachingPreferences: (guidance: string, settings: CoachingSettings): Promise<CoachingPreferences> =>
    ipcRenderer.invoke("coaching:save-preferences", guidance, settings),
  listOrgDocuments: (): Promise<OrgContextDocument[]> => ipcRenderer.invoke("org-documents:list"),
  saveOrgDocument: (document: OrgDocumentInput): Promise<OrgContextDocument> => ipcRenderer.invoke("org-documents:save", document),
  deleteOrgDocument: (documentId: string): Promise<void> => ipcRenderer.invoke("org-documents:delete", documentId),
  listMeetingTemplates: (): Promise<MeetingContextTemplate[]> => ipcRenderer.invoke("meeting-templates:list"),
  saveMeetingTemplate: (template: { id?: string; title: string; context: MeetingContext }): Promise<MeetingContextTemplate> =>
    ipcRenderer.invoke("meeting-templates:save", template),
  deleteMeetingTemplate: (templateId: string): Promise<void> => ipcRenderer.invoke("meeting-templates:delete", templateId),
  askSessionQuestion: (question: string, sessionId?: string | null): Promise<SessionQuestionAnswer> => ipcRenderer.invoke("session:ask-question", question, sessionId),
  askContextQuestion: (payload: ContextQuestionPayload): Promise<SessionQuestionAnswer> => ipcRenderer.invoke("context:ask-question", payload),
  listSessions: (limit = 20): Promise<SessionHistoryItem[]> => ipcRenderer.invoke("session:list", limit),
  getSession: (sessionId: string): Promise<SessionHistoryDetail> => ipcRenderer.invoke("session:get", sessionId),
  refreshCalendars: (): Promise<AppSnapshot> => ipcRenderer.invoke("calendar:refresh"),
  getMeetingBrief: (meetingId: string): Promise<MeetingContext | null> => ipcRenderer.invoke("meeting:brief:get", meetingId),
  saveMeetingBrief: (meetingId: string, context: MeetingContext): Promise<MeetingContext> => ipcRenderer.invoke("meeting:brief:save", meetingId, context),
  getMeetingLaunchContext: (meetingId: string): Promise<StoredMeetingLaunchContext | null> =>
    ipcRenderer.invoke("meeting:launch-context:get", meetingId),
  saveMeetingLaunchContext: (meetingId: string, payload: StoredMeetingLaunchContext): Promise<StoredMeetingLaunchContext> =>
    ipcRenderer.invoke("meeting:launch-context:save", meetingId, payload),
  getMeetingEmailHistory: (meetingId: string): Promise<MeetingEmailHistory> => ipcRenderer.invoke("meeting:email-history", meetingId),
  getMeetingSessionHistory: (meetingId: string): Promise<MeetingSessionHistory> => ipcRenderer.invoke("meeting:session-history", meetingId),
  getMeetingDriveHistory: (meetingId: string): Promise<MeetingDriveHistory> => ipcRenderer.invoke("meeting:drive-history", meetingId),
  connectCalendar: (provider: "google" | "microsoft"): Promise<AppSnapshot> => ipcRenderer.invoke("calendar:connect", provider),
  disconnectCalendar: (provider: "google" | "microsoft"): Promise<AppSnapshot> => ipcRenderer.invoke("calendar:disconnect", provider),
  createMockMeeting: (): Promise<AppSnapshot> => ipcRenderer.invoke("calendar:create-mock-meeting"),
  launchMeeting: (meetingId: string, meetingContext: MeetingContext | null): Promise<AppSnapshot> =>
    ipcRenderer.invoke("meeting:launch", meetingId, meetingContext),
  autoStartMeeting: (meetingId: string | null, meetingContext: MeetingContext | null): Promise<AppSnapshot> =>
    ipcRenderer.invoke("meeting:auto-start", meetingId, meetingContext),
  dismissPopup: (): Promise<AppSnapshot> => ipcRenderer.invoke("meeting:dismiss-popup"),
  sendDebugTranscript: (source: AudioSourceKind, text: string): Promise<AppSnapshot> =>
    ipcRenderer.invoke("session:debug-transcript", source, text),
  sendAudioChunk: (source: AudioSourceKind, payloadBase64: string, sampleRate: number): void => {
    ipcRenderer.send("audio:chunk", source, payloadBase64, sampleRate);
  },
  reportAudioActivity: (source: AudioSourceKind, level: number): Promise<void> =>
    ipcRenderer.invoke("audio:activity", source, level),
  reportAudioStatus: (
    source: AudioSourceKind,
    status: "idle" | "starting" | "active" | "error",
    detail: string,
  ): Promise<AppSnapshot> => ipcRenderer.invoke("audio:status", source, status, detail),
  reportProviderEnded: (): Promise<void> => ipcRenderer.invoke("meeting:provider-ended"),
  endSession: (): Promise<AppSnapshot> => ipcRenderer.invoke("session:end"),
  onStateUpdate: (listener: StateListener): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on("state:update", wrapped);
    return () => ipcRenderer.off("state:update", wrapped);
  },
  onUpdaterState: (listener: UpdaterListener): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: UpdaterState) => listener(state);
    ipcRenderer.on("updater:state", wrapped);
    return () => ipcRenderer.off("updater:state", wrapped);
  },
});

declare global {
  interface Window {
    listenBridge: {
      getSnapshot(): Promise<AppSnapshot>;
      getRuntimeCapabilities(): Promise<RuntimeCapabilities>;
      getRuntimeSecrets(): Promise<RuntimeSecrets>;
      saveRuntimeSecrets(secrets: RuntimeSecrets): Promise<RuntimeSecrets>;
      getUpdaterState(): Promise<UpdaterState>;
      checkForUpdates(): Promise<UpdaterState>;
      installUpdate(): Promise<void>;
      getCoachingPreferences(): Promise<CoachingPreferences>;
      saveCoachingPreferences(guidance: string, settings: CoachingSettings): Promise<CoachingPreferences>;
      listOrgDocuments(): Promise<OrgContextDocument[]>;
      saveOrgDocument(document: OrgDocumentInput): Promise<OrgContextDocument>;
      deleteOrgDocument(documentId: string): Promise<void>;
      listMeetingTemplates(): Promise<MeetingContextTemplate[]>;
      saveMeetingTemplate(template: { id?: string; title: string; context: MeetingContext }): Promise<MeetingContextTemplate>;
      deleteMeetingTemplate(templateId: string): Promise<void>;
      askSessionQuestion(question: string, sessionId?: string | null): Promise<SessionQuestionAnswer>;
      askContextQuestion(payload: ContextQuestionPayload): Promise<SessionQuestionAnswer>;
      listSessions(limit?: number): Promise<SessionHistoryItem[]>;
      getSession(sessionId: string): Promise<SessionHistoryDetail>;
      refreshCalendars(): Promise<AppSnapshot>;
      getMeetingBrief(meetingId: string): Promise<MeetingContext | null>;
      saveMeetingBrief(meetingId: string, context: MeetingContext): Promise<MeetingContext>;
      getMeetingLaunchContext(meetingId: string): Promise<StoredMeetingLaunchContext | null>;
      saveMeetingLaunchContext(meetingId: string, payload: StoredMeetingLaunchContext): Promise<StoredMeetingLaunchContext>;
      getMeetingEmailHistory(meetingId: string): Promise<MeetingEmailHistory>;
      getMeetingSessionHistory(meetingId: string): Promise<MeetingSessionHistory>;
      getMeetingDriveHistory(meetingId: string): Promise<MeetingDriveHistory>;
      connectCalendar(provider: "google" | "microsoft"): Promise<AppSnapshot>;
      disconnectCalendar(provider: "google" | "microsoft"): Promise<AppSnapshot>;
      createMockMeeting(): Promise<AppSnapshot>;
      launchMeeting(meetingId: string, meetingContext: MeetingContext | null): Promise<AppSnapshot>;
      autoStartMeeting(meetingId: string | null, meetingContext: MeetingContext | null): Promise<AppSnapshot>;
      dismissPopup(): Promise<AppSnapshot>;
      sendDebugTranscript(source: AudioSourceKind, text: string): Promise<AppSnapshot>;
      sendAudioChunk(source: AudioSourceKind, payloadBase64: string, sampleRate: number): void;
      reportAudioActivity(source: AudioSourceKind, level: number): Promise<void>;
      reportAudioStatus(
        source: AudioSourceKind,
        status: "idle" | "starting" | "active" | "error",
        detail: string,
      ): Promise<AppSnapshot>;
      reportProviderEnded(): Promise<void>;
      endSession(): Promise<AppSnapshot>;
      onStateUpdate(listener: StateListener): () => void;
      onUpdaterState(listener: UpdaterListener): () => void;
    };
  }
}
