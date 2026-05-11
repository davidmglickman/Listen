import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type { AppSnapshot, AudioSourceKind, CoachingSettings, MeetingContext, MeetingContextTemplate, MeetingRecord, OrgContextDocument, SessionHistoryDetail, SessionHistoryItem, SessionQuestionAnswer, SessionStopReason, SessionSummary } from "@listen/shared";
import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from "electron";
import dotenv from "dotenv";
import { autoUpdater } from "electron-updater";

import { CalendarService } from "./calendar/calendarService";
import { MeetingResearchClient } from "./calendar/meetingResearchClient";
import { CalendarSyncClient } from "./calendar/calendarSyncClient";
import { RealtimeClient } from "./realtime/realtimeClient";
import { MeetingScheduler } from "./scheduler/meetingScheduler";
import { AutoStopController } from "./session/autoStopController";
import { SessionStore, type StoredMeetingLaunchContext } from "./storage/sessionStore";
import { fetchWithTimeout } from "./http/fetchWithTimeout";

function resolveEnvPath(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", "..", "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", "..", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

dotenv.config({ path: resolveEnvPath() });

if (!app.isPackaged) {
  const electronStateRoot = path.resolve(process.cwd(), ".cache", "listen-desktop");
  app.setPath("userData", path.join(electronStateRoot, "user-data"));
  app.setPath("sessionData", path.join(electronStateRoot, "session-data"));
  app.disableHardwareAcceleration();
}

const popupLeadMinutes = Number(process.env.LISTEN_MEETING_POPUP_LEAD_MINUTES ?? 2);
const realtimeHttpUrl = `http://localhost:${process.env.LISTEN_REALTIME_PORT ?? 8787}`;
const realtimeUrl = `ws://localhost:${process.env.LISTEN_REALTIME_PORT ?? 8787}/ws`;
const transcriptionConfigured = Boolean(process.env.DEEPGRAM_API_KEY?.trim());
const updateFeedUrl = process.env.LISTEN_UPDATE_FEED_URL?.trim() || "";
const updateChannel = process.env.LISTEN_UPDATE_CHANNEL?.trim() || "latest";
const updateGithubOwner = process.env.LISTEN_UPDATE_GITHUB_OWNER?.trim() || "";
const updateGithubRepo = process.env.LISTEN_UPDATE_GITHUB_REPO?.trim() || "";
const updateGithubPrivate = process.env.LISTEN_UPDATE_GITHUB_PRIVATE === "true";
const updateProvider = updateGithubOwner && updateGithubRepo ? "github" : updateFeedUrl ? "generic" : "none";
const devUpdatesEnabled = process.env.LISTEN_ENABLE_DEV_UPDATES === "true";
const allowedMeetingHosts = new Set(["meet.google.com", "teams.microsoft.com", "app.zoom.us", "zoom.us"]);
const defaultCoachingSettings: CoachingSettings = {
  style: "supportive",
  directness: "balanced",
  frequency: "balanced",
};

let mainWindow: BrowserWindow | null = null;
let meetingWindow: BrowserWindow | null = null;
let sessionStore: SessionStore;
let calendarService: CalendarService;
let realtimeClient: RealtimeClient | null = null;
let activeMeetingRecord: MeetingRecord | null = null;
let activeMeetingContext: MeetingContext | null = null;
let pendingStopTimeout: NodeJS.Timeout | null = null;
let updaterConfigured = false;

let updaterState: DesktopUpdaterState = {
  enabled: updateProvider !== "none",
  availability: updateProvider === "none" ? "disabled" : "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  checkedAt: null,
  progress: null,
  message: updateProvider === "github"
    ? "Ready to check GitHub Releases for updates."
    : updateProvider === "generic"
      ? "Ready to check for updates."
      : "Set LISTEN_UPDATE_GITHUB_OWNER and LISTEN_UPDATE_GITHUB_REPO, or LISTEN_UPDATE_FEED_URL, to enable desktop app updates.",
};

const meetingScheduler = new MeetingScheduler(popupLeadMinutes);
const autoStopController = new AutoStopController();

function createInitialCaptureHealth() {
  return {
    microphone: {
      status: "idle" as const,
      detail: "Microphone capture idle.",
      chunkCount: 0,
      lastActivityAt: null,
    },
    system: {
      status: "idle" as const,
      detail: "System audio capture idle.",
      chunkCount: 0,
      lastActivityAt: null,
    },
  };
}

const snapshot: AppSnapshot = {
  calendarConnections: [],
  upcomingMeetings: [],
  pendingPopupMeeting: null,
  activeSession: null,
  captureHealth: createInitialCaptureHealth(),
  transcript: [],
  coaching: [],
  lastSummary: null,
};

interface MeetingEmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

interface MeetingEmailHistory {
  status: "ready" | "not_connected" | "needs_reconnect" | "unavailable" | "error";
  note: string;
  messages: MeetingEmailMessage[];
}

interface RelatedMeetingSession {
  sessionId: string;
  meetingTitle: string;
  completedAt: string;
  headline: string;
  matchReason: string;
}

interface MeetingSessionHistory {
  status: "ready" | "unavailable" | "error";
  note: string;
  sessions: RelatedMeetingSession[];
}

type UpdaterAvailability = "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";

interface DesktopUpdaterState {
  enabled: boolean;
  availability: UpdaterAvailability;
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string | null;
  progress: number | null;
  message: string;
}

function parseGoogleApiErrorBody(body: string): { reason: string; message: string } {
  try {
    const payload = JSON.parse(body) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
    };
    const reason = payload.error?.errors?.[0]?.reason ?? payload.error?.status ?? "";
    const message = payload.error?.message ?? payload.error?.errors?.[0]?.message ?? body;
    return { reason, message };
  } catch {
    return { reason: "", message: body };
  }
}

function resetCaptureHealth(): void {
  snapshot.captureHealth = createInitialCaptureHealth();
}

function updateCaptureHealth(source: AudioSourceKind, status: "idle" | "starting" | "active" | "error", detail: string): void {
  snapshot.captureHealth = {
    ...snapshot.captureHealth,
    [source]: {
      ...snapshot.captureHealth[source],
      status,
      detail,
    },
  };
}

function noteCaptureChunk(source: AudioSourceKind): void {
  snapshot.captureHealth = {
    ...snapshot.captureHealth,
    [source]: {
      ...snapshot.captureHealth[source],
      status: "active",
      detail: `Receiving ${source} audio chunks.`,
      chunkCount: snapshot.captureHealth[source].chunkCount + 1,
      lastActivityAt: new Date().toISOString(),
    },
  };
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) {
    return false;
  }

  if (origin.startsWith("file://")) {
    return true;
  }

  try {
    const url = new URL(origin);
    return allowedMeetingHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function configureSessionPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (["media", "display-capture", "openExternal", "notifications"].includes(permission)) {
      return isAllowedOrigin(requestingOrigin);
    }

    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl ?? webContents.getURL();
    callback(["media", "display-capture", "openExternal", "notifications"].includes(permission) && isAllowedOrigin(origin));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.frame) {
      callback({});
      return;
    }

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    callback({
      video: sources[0],
      audio: process.platform === "win32" ? "loopback" : undefined,
    });
  });
}

function broadcastSnapshot(): AppSnapshot {
  snapshot.calendarConnections = calendarService.getConnections();
  snapshot.upcomingMeetings = calendarService.getUpcomingMeetings();

  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("state:update", snapshot);
  }

  return snapshot;
}

function broadcastUpdaterState(): DesktopUpdaterState {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("updater:state", updaterState);
  }

  return updaterState;
}

function setUpdaterState(patch: Partial<DesktopUpdaterState>): DesktopUpdaterState {
  updaterState = {
    ...updaterState,
    ...patch,
  };

  return broadcastUpdaterState();
}

function configureAutoUpdater(): void {
  if (updaterConfigured) {
    return;
  }

  if (updateProvider === "none") {
    setUpdaterState({
      enabled: false,
      availability: "disabled",
      message: "Set LISTEN_UPDATE_GITHUB_OWNER and LISTEN_UPDATE_GITHUB_REPO, or LISTEN_UPDATE_FEED_URL, to enable desktop app updates.",
    });
    return;
  }

  if (!app.isPackaged && !devUpdatesEnabled) {
    setUpdaterState({
      enabled: false,
      availability: "disabled",
      message: "Updater is configured, but checks only run in packaged builds unless LISTEN_ENABLE_DEV_UPDATES=true.",
    });
    return;
  }

  updaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = updateChannel !== "latest";
  if (updateProvider === "github") {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: updateGithubOwner,
      repo: updateGithubRepo,
      private: updateGithubPrivate,
      releaseType: updateChannel === "latest" ? "release" : "prerelease",
    });
  } else {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: updateFeedUrl,
      channel: updateChannel,
    });
  }

  autoUpdater.on("checking-for-update", () => {
    setUpdaterState({
      enabled: true,
      availability: "checking",
      availableVersion: null,
      checkedAt: new Date().toISOString(),
      progress: null,
      message: "Checking for updates...",
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdaterState({
      enabled: true,
      availability: "available",
      availableVersion: info.version ?? null,
      checkedAt: new Date().toISOString(),
      progress: 0,
      message: `Update ${info.version ?? "available"} found. Downloading now...`,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Number.isFinite(progress.percent) ? Math.round(progress.percent) : null;
    setUpdaterState({
      enabled: true,
      availability: "downloading",
      progress: percent,
      message: percent === null ? "Downloading update..." : `Downloading update... ${percent}%`,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const version = info.version ?? updaterState.availableVersion;
    setUpdaterState({
      enabled: true,
      availability: "downloaded",
      availableVersion: version,
      progress: 100,
      checkedAt: new Date().toISOString(),
      message: version
        ? `Update ${version} is ready. Install when you are ready to restart.`
        : "An update is ready. Install when you are ready to restart.",
    });
  });

  autoUpdater.on("update-not-available", () => {
    setUpdaterState({
      enabled: true,
      availability: "not-available",
      availableVersion: null,
      progress: null,
      checkedAt: new Date().toISOString(),
      message: "You are on the latest version.",
    });
  });

  autoUpdater.on("error", (error) => {
    setUpdaterState({
      enabled: true,
      availability: "error",
      progress: null,
      checkedAt: new Date().toISOString(),
      message: `Update check failed: ${error.message}`,
    });
  });

  setUpdaterState({
    enabled: true,
    availability: "idle",
    message: updateProvider === "github" ? "Ready to check GitHub Releases for updates." : "Ready to check for updates.",
  });
}

async function checkForDesktopUpdates(): Promise<DesktopUpdaterState> {
  configureAutoUpdater();
  if (!updaterConfigured) {
    return updaterState;
  }

  if (["checking", "downloading"].includes(updaterState.availability)) {
    return updaterState;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdaterState({
      availability: "error",
      checkedAt: new Date().toISOString(),
      progress: null,
      message: `Update check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return updaterState;
}

async function installDownloadedUpdate(): Promise<void> {
  if (updaterState.availability !== "downloaded") {
    throw new Error("No downloaded update is ready to install.");
  }

  autoUpdater.quitAndInstall();
}

function normalizeCoachingSettings(value: unknown): CoachingSettings {
  const candidate = (value ?? {}) as Partial<CoachingSettings>;
  return {
    style: candidate.style === "direct" || candidate.style === "challenger" ? candidate.style : defaultCoachingSettings.style,
    directness: candidate.directness === "gentle" || candidate.directness === "blunt" ? candidate.directness : defaultCoachingSettings.directness,
    frequency: candidate.frequency === "minimal" || candidate.frequency === "proactive" ? candidate.frequency : defaultCoachingSettings.frequency,
  };
}

async function readDesktopCoachingPreferences(): Promise<{ guidance: string; settings: CoachingSettings }> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context`);
  if (!response.ok) {
    throw new Error(`Failed to load coaching preferences: ${response.status}`);
  }

  const payload = (await response.json()) as {
    profiles?: Array<{ scope?: string; scopeId?: string; guidance?: string; settings?: unknown }>;
  };
  const profile = payload.profiles?.find((item) => item.scope === "user" && item.scopeId === "self");
  return {
    guidance: typeof profile?.guidance === "string" ? profile.guidance : "",
    settings: normalizeCoachingSettings(profile?.settings),
  };
}

async function saveDesktopCoachingPreferences(guidance: string, settings: CoachingSettings): Promise<{ guidance: string; settings: CoachingSettings }> {
  const normalizedSettings = normalizeCoachingSettings(settings);
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context/profiles/user:self`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      scope: "user",
      scopeId: "self",
      label: "Default personal focus",
      guidance,
      settings: normalizedSettings,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to save coaching preferences: ${response.status} ${body}`.trim());
  }

  return {
    guidance,
    settings: normalizedSettings,
  };
}

async function listDesktopOrgDocuments(): Promise<OrgContextDocument[]> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context`);
  if (!response.ok) {
    throw new Error(`Failed to load org documents: ${response.status}`);
  }

  const payload = (await response.json()) as { documents?: OrgContextDocument[] };
  return Array.isArray(payload.documents) ? payload.documents : [];
}

async function listDesktopMeetingTemplates(): Promise<MeetingContextTemplate[]> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context`);
  if (!response.ok) {
    throw new Error(`Failed to load meeting templates: ${response.status}`);
  }

  const payload = (await response.json()) as { templates?: MeetingContextTemplate[] };
  return Array.isArray(payload.templates) ? payload.templates : [];
}

async function saveDesktopMeetingTemplate(template: { id?: string; title: string; context: MeetingContext }): Promise<MeetingContextTemplate> {
  const title = template.title.trim();
  if (!title) {
    throw new Error("Template title is required.");
  }

  const templateId = String(template.id || "").trim() || `template:${Date.now()}`;
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context/templates/${encodeURIComponent(templateId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      context: template.context,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to save meeting template: ${response.status} ${body}`.trim());
  }

  return response.json() as Promise<MeetingContextTemplate>;
}

async function deleteDesktopMeetingTemplate(templateId: string): Promise<void> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context/templates/${encodeURIComponent(templateId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to delete meeting template: ${response.status} ${body}`.trim());
  }
}

function deriveDocumentTitle(rawTitle: string | undefined, sourceUrl: string | null): string {
  const trimmedTitle = rawTitle?.trim() || "";
  if (trimmedTitle) {
    return trimmedTitle;
  }

  if (!sourceUrl) {
    return "";
  }

  try {
    const url = new URL(sourceUrl);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const lastPathPart = pathParts[pathParts.length - 1] || url.hostname;
    const normalized = decodeURIComponent(lastPathPart)
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim();
    return normalized || "Imported context document";
  } catch {
    return "Imported context document";
  }
}

function resolveGoogleContentImportUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();

    if (hostname === "docs.google.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const documentIndex = parts.indexOf("document");
      const docId = documentIndex >= 0 && parts[documentIndex + 1] === "d" ? parts[documentIndex + 2] : null;
      if (!docId) {
        return null;
      }

      return `https://docs.google.com/document/d/${docId}/export?format=txt`;
    }

    if (hostname === "drive.google.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const fileIndex = parts.indexOf("file");
      const fileId = fileIndex >= 0 && parts[fileIndex + 1] === "d" ? parts[fileIndex + 2] : url.searchParams.get("id");
      if (!fileId) {
        return null;
      }

      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    }

    return null;
  } catch {
    return null;
  }
}

async function saveDesktopOrgDocument(document: {
  title: string;
  content: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  mimeType?: string | null;
}): Promise<OrgContextDocument> {
  let content = document.content.trim();
  const sourceUrl = document.sourceUrl?.trim() || null;
  const title = deriveDocumentTitle(document.title, sourceUrl);

  if (!content && sourceUrl) {
    const importUrl = resolveGoogleContentImportUrl(sourceUrl);
    if (!importUrl) {
      throw new Error("Paste the content as text, or use a Google Docs or shared Google Drive link that can be imported as plain text.");
    }

    const importResponse = await fetchWithTimeout(importUrl);
    if (!importResponse.ok) {
      throw new Error(`Failed to import linked document content: ${importResponse.status}`);
    }

    content = (await importResponse.text()).trim();
    if (!content) {
      throw new Error("The linked document did not return any text content.");
    }
  }

  if (!title) {
    throw new Error("Document title is required when there is no importable link.");
  }

  if (!content) {
    throw new Error("Document content is required.");
  }

  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context/documents/orgdoc:${Date.now()}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...document,
      title,
      content,
      sourceUrl,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to save org document: ${response.status} ${body}`.trim());
  }

  return response.json() as Promise<OrgContextDocument>;
}

async function deleteDesktopOrgDocument(documentId: string): Promise<void> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/context/documents/${documentId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to delete org document: ${response.status} ${body}`.trim());
  }
}

async function askDesktopSessionQuestion(question: string, sessionId?: string | null): Promise<SessionQuestionAnswer> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("Question is required.");
  }

  const explicitSessionId = String(sessionId || "").trim();
  const activeSessionId = snapshot.activeSession?.id ?? null;
  const completedSessionId = snapshot.lastSummary?.sessionId ?? null;
  const endpoint = explicitSessionId
    ? `/api/sessions/${encodeURIComponent(explicitSessionId)}/questions`
    : activeSessionId
    ? `/api/live-sessions/${encodeURIComponent(activeSessionId)}/questions`
    : completedSessionId
      ? `/api/sessions/${encodeURIComponent(completedSessionId)}/questions`
      : null;

  if (!endpoint) {
    throw new Error("Start a meeting or finish one first so there is session context to query.");
  }

  const response = await fetchWithTimeout(`${realtimeHttpUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question: trimmedQuestion }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to answer session question: ${response.status} ${body}`.trim());
  }

  return response.json() as Promise<SessionQuestionAnswer>;
}

async function listDesktopSessions(limit = 20): Promise<SessionHistoryItem[]> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/sessions?limit=${encodeURIComponent(String(limit))}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to load session history: ${response.status} ${body}`.trim());
  }

  const payload = (await response.json()) as {
    sessions?: SessionHistoryItem[];
  };

  return payload.sessions ?? [];
}

async function readDesktopSessionDetail(sessionId: string): Promise<SessionHistoryDetail> {
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to load session detail: ${response.status} ${body}`.trim());
  }

  return response.json() as Promise<SessionHistoryDetail>;
}

async function readDesktopMeetingBrief(meetingId: string): Promise<MeetingContext | null> {
  return sessionStore.readMeetingContext(meetingId);
}

async function saveDesktopMeetingBrief(meetingId: string, context: MeetingContext): Promise<MeetingContext> {
  await sessionStore.writeMeetingContext(meetingId, context);
  return context;
}

async function readDesktopMeetingLaunchContext(meetingId: string): Promise<StoredMeetingLaunchContext | null> {
  return sessionStore.readMeetingLaunchContext(meetingId);
}

async function saveDesktopMeetingLaunchContext(
  meetingId: string,
  payload: StoredMeetingLaunchContext,
): Promise<StoredMeetingLaunchContext> {
  await sessionStore.writeMeetingLaunchContext(meetingId, payload);
  return payload;
}

function getMeetingGuestEmails(meeting: MeetingRecord): string[] {
  const currentUserEmails = new Set(
    calendarService.getConnections()
      .map((connection) => {
        const match = String(connection.accountLabel || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        return match ? match[0].trim().toLowerCase() : "";
      })
      .filter(Boolean),
  );
  const organizerEmail = String(meeting.organizerEmail || "").trim().toLowerCase();

  return [...new Set(
    (meeting.attendees ?? [])
      .map((attendee) => attendee.email)
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toLowerCase())
      .filter((value) => Boolean(value) && value !== organizerEmail && !currentUserEmails.has(value)),
  )].slice(0, 8);
}

function buildMeetingEmailQuery(meeting: MeetingRecord): string {
  const guestEmails = getMeetingGuestEmails(meeting);
  const guestClause = guestEmails.length
    ? `(${guestEmails.map((email) => `(from:${email} OR to:${email})`).join(" OR ")})`
    : "";

  return [`newer_than:365d`, guestClause].filter(Boolean).join(" ");
}

function getGmailHeader(payload: { headers?: Array<{ name?: string; value?: string }> } | undefined, name: string): string {
  return payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? "";
}

function buildTranscriptHistoryNote(detail: SessionHistoryDetail, meeting: MeetingRecord): string {
  const guestTokens = new Set(
    (meeting.attendees ?? [])
      .flatMap((attendee) => [attendee.fullName || "", attendee.email || ""])
      .flatMap((value) => tokenizeMeetingText(value)),
  );
  const currentUserTokens = new Set(
    [
      ...calendarService.getConnections().map((connection) => connection.accountLabel || ""),
      meeting.organizerEmail || "",
    ].flatMap((value) => tokenizeMeetingText(value)),
  );

  const scoredSegments = (detail.transcript || [])
    .filter((segment) => Boolean(segment?.text?.trim()))
    .map((segment, index) => {
      const speaker = String(segment.speakerLabel || segment.source || "Speaker").trim();
      const text = String(segment.text || "").trim().replace(/\s+/g, " ");
      const segmentTokens = tokenizeMeetingText(`${speaker} ${text}`);
      const speakerTokens = tokenizeMeetingText(speaker);
      const overlapCount = segmentTokens.filter((token) => guestTokens.has(token)).length;
      const speakerLower = speaker.toLowerCase();
      const hasGuestCue = /guest|prospect|candidate|client|customer|buyer|interviewer|attendee/.test(speakerLower);
      const hasHostCue = /system|microphone|organizer|host|internal/.test(speakerLower)
        || speakerTokens.some((token) => currentUserTokens.has(token));
      if (hasHostCue && overlapCount === 0 && !hasGuestCue) {
        return null;
      }

      const score = overlapCount * 5 + (hasGuestCue ? 3 : 0) - (hasHostCue ? 2 : 0) - Math.min(index, 6);

      return {
        score,
        index,
        line: text ? `${speaker}: ${text}` : "",
      };
    })
    .filter((segment): segment is { score: number; index: number; line: string } => Boolean(segment?.line));

  const prioritizedLines = scoredSegments
    .filter((segment) => segment.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .map((segment) => segment.line);

  const fallbackLines = scoredSegments
    .slice(0, 4)
    .map((segment) => segment.line);

  const transcriptLines = (prioritizedLines.length ? prioritizedLines : fallbackLines)
    .filter(Boolean);

  return transcriptLines.join(" ").slice(0, 320).trim();
}

function tokenizeMeetingText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function summarizeSessionMatch(meeting: MeetingRecord, session: { meetingTitle: string; context: MeetingContext | null }): { score: number; reason: string } {
  const titleTokens = new Set(tokenizeMeetingText(meeting.title));
  const attendeeTokens = new Set(
    (meeting.attendees ?? [])
      .flatMap((attendee) => tokenizeMeetingText(attendee.fullName || attendee.email || "")),
  );
  const sessionTitleTokens = tokenizeMeetingText(session.meetingTitle);
  const sessionContextTokens = tokenizeMeetingText([
    session.context?.callGoal || "",
    session.context?.notes || "",
    session.context?.guestRole || "",
  ].join(" "));

  const titleOverlap = sessionTitleTokens.filter((token) => titleTokens.has(token));
  const attendeeOverlap = sessionContextTokens.filter((token) => attendeeTokens.has(token));
  const score = titleOverlap.length * 3 + attendeeOverlap.length * 2;

  if (titleOverlap.length >= 2) {
    return {
      score,
      reason: `Matched prior session title on ${titleOverlap.slice(0, 3).join(", ")}`,
    };
  }

  if (attendeeOverlap.length) {
    return {
      score,
      reason: `Matched prior brief notes on ${attendeeOverlap.slice(0, 3).join(", ")}`,
    };
  }

  return {
    score,
    reason: "",
  };
}

async function readDesktopMeetingEmailHistory(meetingId: string): Promise<MeetingEmailHistory> {
  const meeting = calendarService.getUpcomingMeetings().find((item) => item.id === meetingId);
  if (!meeting) {
    return {
      status: "unavailable",
      note: "Meeting not found.",
      messages: [],
    };
  }

  const accessToken = await calendarService.getAccessToken("google");
  if (!accessToken) {
    return {
      status: "not_connected",
      note: "Connect Google in Setup to search Gmail history for this meeting.",
      messages: [],
    };
  }

  const query = buildMeetingEmailQuery(meeting);
  if (!query) {
    return {
      status: "unavailable",
      note: "There are no guest email addresses on this meeting yet, so Gmail history cannot be matched.",
      messages: [],
    };
  }

  const listResponse = await fetchWithTimeout(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=6&q=${encodeURIComponent(query)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!listResponse.ok) {
    const body = await listResponse.text();
    const { reason, message } = parseGoogleApiErrorBody(body);

    if (listResponse.status === 401) {
      return {
        status: "needs_reconnect",
        note: "Reconnect Google in Setup to grant Gmail access for email history.",
        messages: [],
      };
    }

    if (listResponse.status === 403) {
      if (["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"].includes(reason)) {
        return {
          status: "needs_reconnect",
          note: "Google is connected, but Gmail permission is missing. Reconnect Google in Setup and accept Gmail access.",
          messages: [],
        };
      }

      if (["SERVICE_DISABLED", "accessNotConfigured"].includes(reason) || /gmail api has not been used|api has not been used|service has been disabled/i.test(message)) {
        return {
          status: "error",
          note: "Google is connected, but the Gmail API is not enabled for this project. Enable the Gmail API in Google Cloud, then refresh email history.",
          messages: [],
        };
      }

      return {
        status: "error",
        note: `Gmail access was denied by Google: ${message}`.trim(),
        messages: [],
      };
    }

    return {
      status: "error",
      note: `Gmail search failed: ${listResponse.status} ${body}`.trim(),
      messages: [],
    };
  }

  const payload = (await listResponse.json()) as {
    messages?: Array<{ id?: string }>;
  };
  const messageIds = (payload.messages ?? []).map((message) => message.id).filter((value): value is string => Boolean(value));
  if (!messageIds.length) {
    return {
      status: "ready",
      note: "No related Gmail threads were found in the last year for this meeting.",
      messages: [],
    };
  }

  const messages = (await Promise.all(
    messageIds.map(async (messageId) => {
      const detailResponse = await fetchWithTimeout(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!detailResponse.ok) {
        return null;
      }

      const detail = (await detailResponse.json()) as {
        id?: string;
        snippet?: string;
        payload?: {
          headers?: Array<{ name?: string; value?: string }>;
        };
      };

      return {
        id: detail.id ?? messageId,
        from: getGmailHeader(detail.payload, "From") || "Unknown sender",
        subject: getGmailHeader(detail.payload, "Subject") || "No subject",
        date: getGmailHeader(detail.payload, "Date") || "",
        snippet: detail.snippet?.trim() || "",
      } satisfies MeetingEmailMessage;
    }),
  )).filter((value): value is MeetingEmailMessage => Boolean(value));

  return {
    status: "ready",
    note: messages.length ? "Recent Gmail threads involving at least one guest attendee on this meeting." : "No readable Gmail messages were returned for the guest attendees on this meeting.",
    messages,
  };
}

async function readDesktopMeetingSessionHistory(meetingId: string): Promise<MeetingSessionHistory> {
  const meeting = calendarService.getUpcomingMeetings().find((item) => item.id === meetingId);
  if (!meeting) {
    return {
      status: "unavailable",
      note: "Meeting not found.",
      sessions: [],
    };
  }

  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/sessions?limit=100`);
  if (!response.ok) {
    const body = await response.text();
    return {
      status: "error",
      note: `Failed to load prior session history: ${response.status} ${body}`.trim(),
      sessions: [],
    };
  }

  const payload = (await response.json()) as {
    sessions?: Array<{
      sessionId: string;
      meetingTitle: string;
      completedAt: string;
      summary: { headline?: string };
      context: MeetingContext | null;
    }>;
  };

  const rankedSessions = (payload.sessions ?? [])
    .map((session) => {
      const match = summarizeSessionMatch(meeting, session);
      return {
        sessionId: session.sessionId,
        meetingTitle: session.meetingTitle,
        completedAt: session.completedAt,
        headline: session.summary?.headline || "No summary headline",
        matchReason: match.reason,
        score: match.score,
      };
    })
    .filter((session) => session.score > 0)
    .sort((left, right) => right.score - left.score || right.completedAt.localeCompare(left.completedAt))
    .slice(0, 5);

  const relatedSessions = (await Promise.all(
    rankedSessions.map(async ({ score: _score, ...session }) => {
      try {
        const detail = await readDesktopSessionDetail(session.sessionId);
        return {
          ...session,
          transcriptNote: buildTranscriptHistoryNote(detail, meeting),
        };
      } catch {
        return {
          ...session,
          transcriptNote: "",
        };
      }
    }),
  ));

  return {
    status: "ready",
    note: relatedSessions.length
      ? "Previous Listen sessions that look related based on meeting title, saved brief context, and transcript notes."
      : "No related Listen sessions found yet for this meeting.",
    sessions: relatedSessions,
  };
}

function closeMeetingWindow(): void {
  if (!meetingWindow) {
    return;
  }

  const windowToClose = meetingWindow;
  meetingWindow = null;
  if (!windowToClose.isDestroyed()) {
    windowToClose.close();
  }
}

async function finalizeSessionLocally(reason: SessionStopReason): Promise<AppSnapshot> {
  const completedSession = snapshot.activeSession;
  const completedMeeting = activeMeetingRecord;
  const completedContext = activeMeetingContext;
  const completedTranscript = [...snapshot.transcript];
  const completedCoaching = [...snapshot.coaching];

  if (pendingStopTimeout) {
    clearTimeout(pendingStopTimeout);
    pendingStopTimeout = null;
  }

  const summary: SessionSummary = {
    sessionId: completedSession?.id ?? randomUUID(),
    headline: completedMeeting ? `${completedMeeting.title} ended` : "Session ended",
    decisions: [],
    actionItems: [],
    openQuestions: [],
    coachingRecap: completedCoaching.map((prompt) => prompt.title),
    completedAt: new Date().toISOString(),
  };

  snapshot.lastSummary = summary;
  snapshot.activeSession = null;
  resetCaptureHealth();
  snapshot.transcript = [];
  snapshot.coaching = [];
  autoStopController.disarm();
  closeMeetingWindow();
  await sessionStore.writeLastSummary(summary);
  if (completedSession && completedMeeting) {
    await sessionStore.writeCompletedSession({
      meeting: completedMeeting,
      startedAt: completedSession.startedAt,
      expectedEndAt: completedSession.expectedEndAt,
      stopReason: completedSession.stopReason ?? reason,
      summary,
      transcript: completedTranscript,
      coaching: completedCoaching,
      context: completedContext,
    });
  }
  activeMeetingRecord = null;
  activeMeetingContext = null;
  realtimeClient?.dispose();
  realtimeClient = null;
  return broadcastSnapshot();
}

function attachRealtimeClient(): RealtimeClient {
  if (realtimeClient) {
    return realtimeClient;
  }

  realtimeClient = new RealtimeClient(realtimeUrl, async (event) => {
    if (event.kind === "transcript_segment") {
      snapshot.transcript = [
        ...snapshot.transcript,
        {
          id: event.segmentId,
          sessionId: event.sessionId,
          source: event.source,
          speakerId: event.speakerId,
          speakerLabel: event.speakerLabel,
          text: event.text,
          isFinal: event.isFinal,
          createdAt: event.createdAt,
        },
      ];
      broadcastSnapshot();
      return;
    }

    if (event.kind === "coaching_prompt") {
      snapshot.coaching = [
        event,
        ...snapshot.coaching.filter((prompt: AppSnapshot["coaching"][number]) => prompt.id !== event.promptId),
      ].map((prompt) => ({
        id: "promptId" in prompt ? prompt.promptId : prompt.id,
        sessionId: prompt.sessionId,
        speakerId: "speakerId" in prompt ? prompt.speakerId : prompt.speakerId,
        speakerLabel: "speakerLabel" in prompt ? prompt.speakerLabel : prompt.speakerLabel,
        severity: prompt.severity,
        title: prompt.title,
        message: prompt.message,
        createdAt: prompt.createdAt,
      }));
      broadcastSnapshot();
      return;
    }

    if (pendingStopTimeout) {
      clearTimeout(pendingStopTimeout);
      pendingStopTimeout = null;
    }

    snapshot.lastSummary = {
      sessionId: event.sessionId,
      headline: event.headline,
      decisions: event.decisions,
      actionItems: event.actionItems,
      openQuestions: event.openQuestions,
      coachingRecap: event.coachingRecap,
      completedAt: event.completedAt,
    };
    await finalizeSessionLocally(snapshot.activeSession?.stopReason ?? "unknown");
  });

  return realtimeClient;
}

function attachMeetingWindowSignals(windowInstance: BrowserWindow): void {
  windowInstance.on("closed", () => {
    if (meetingWindow === windowInstance) {
      meetingWindow = null;
    }
    autoStopController.noteMeetingWindowClosed();
  });

  windowInstance.webContents.on("page-title-updated", (_event, title) => {
    if (/ended|left the meeting|meeting ended|call ended/i.test(title)) {
      autoStopController.noteProviderEndState();
    }
  });

  windowInstance.webContents.on("did-navigate", (_event, url) => {
    try {
      const hostname = new URL(url).hostname;
      if (!allowedMeetingHosts.has(hostname)) {
        autoStopController.noteProviderEndState();
      }
    } catch {
      autoStopController.noteProviderEndState();
    }
  });

  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const hostname = new URL(url).hostname;
      if (allowedMeetingHosts.has(hostname)) {
        windowInstance.loadURL(url).catch((error) => {
          console.error("Failed to redirect meeting popup", error);
        });
        return { action: "deny" };
      }
    } catch {
      return { action: "deny" };
    }

    void shell.openExternal(url);
    return { action: "deny" };
  });
}

function createMeetingWindow(meeting: MeetingRecord): BrowserWindow {
  closeMeetingWindow();
  const windowInstance = new BrowserWindow({
    width: 1440,
    height: 960,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  meetingWindow = windowInstance;
  attachMeetingWindowSignals(windowInstance);
  windowInstance.loadURL(meeting.joinUrl).catch((error) => {
    console.error("Failed to load meeting URL", error);
  });
  return windowInstance;
}

async function refreshCalendars(): Promise<AppSnapshot> {
  await calendarService.refreshUpcomingMeetings();
  meetingScheduler.setMeetings(calendarService.getUpcomingMeetings());
  return broadcastSnapshot();
}

async function startSession(meeting: MeetingRecord, meetingContext: MeetingContext | null): Promise<AppSnapshot> {
  snapshot.pendingPopupMeeting = null;
  resetCaptureHealth();
  updateCaptureHealth("microphone", "starting", "Waiting for microphone permission.");
  updateCaptureHealth("system", "starting", "Waiting for system-audio permission.");
  snapshot.transcript = [];
  snapshot.coaching = [];
  snapshot.lastSummary = null;
  snapshot.activeSession = {
    id: randomUUID(),
    meetingId: meeting.id,
    startedAt: new Date().toISOString(),
    expectedEndAt: meeting.endsAt,
    status: "active",
  };
  activeMeetingRecord = meeting;
  activeMeetingContext = meetingContext;

  if (!transcriptionConfigured) {
    snapshot.coaching = [
      {
        id: randomUUID(),
        sessionId: snapshot.activeSession.id,
        severity: "warning",
        title: "Live transcription is disabled",
        message: "DEEPGRAM_API_KEY is not configured. Audio capture can still run, but no transcript will appear until that key is set and the realtime service is restarted.",
        createdAt: new Date().toISOString(),
      },
    ];
  }

  if (meeting.launchStrategy === "browser") {
    createMeetingWindow(meeting);
  } else {
    await shell.openExternal(meeting.joinUrl);
  }

  const client = attachRealtimeClient();
  try {
    await client.connect();
    client.send({
      kind: "session_start",
      sessionId: snapshot.activeSession.id,
      meetingId: meeting.id,
      expectedEndAt: meeting.endsAt,
      meetingTitle: meeting.title,
      meetingProvider: meeting.provider,
      calendarProvider: meeting.calendarProvider,
      meetingContext,
    });
  } catch (error) {
    console.error("Failed to connect to realtime service", error);
  }

  autoStopController.arm(snapshot.activeSession.id, meeting.endsAt);
  return broadcastSnapshot();
}

async function stopSession(reason: SessionStopReason): Promise<AppSnapshot> {
  if (!snapshot.activeSession) {
    return broadcastSnapshot();
  }

  snapshot.activeSession = {
    ...snapshot.activeSession,
    status: "stopping",
    stopReason: reason,
  };
  broadcastSnapshot();

  const sent = realtimeClient?.send({
    kind: "session_stop",
    sessionId: snapshot.activeSession.id,
    reason,
  }) ?? false;

  if (!realtimeClient || !sent || !realtimeClient.isConnected()) {
    return finalizeSessionLocally(reason);
  }

  if (pendingStopTimeout) {
    clearTimeout(pendingStopTimeout);
  }
  pendingStopTimeout = setTimeout(() => {
    void finalizeSessionLocally(reason);
  }, 3000);

  return broadcastSnapshot();
}

function registerHandlers(): void {
  ipcMain.handle("app:get-snapshot", async () => snapshot);
  ipcMain.handle("app:get-runtime-capabilities", async () => ({
    cloudTranscriptionConfigured: transcriptionConfigured,
  }));
  ipcMain.handle("updater:get-state", async () => updaterState);
  ipcMain.handle("updater:check", async () => checkForDesktopUpdates());
  ipcMain.handle("updater:install", async () => installDownloadedUpdate());
  ipcMain.handle("coaching:get-preferences", async () => readDesktopCoachingPreferences());
  ipcMain.handle("coaching:save-preferences", async (_event, guidance: string, settings: CoachingSettings) =>
    saveDesktopCoachingPreferences(guidance, settings),
  );
  ipcMain.handle("org-documents:list", async () => listDesktopOrgDocuments());
  ipcMain.handle("org-documents:save", async (_event, document) => saveDesktopOrgDocument(document));
  ipcMain.handle("org-documents:delete", async (_event, documentId: string) => deleteDesktopOrgDocument(documentId));
  ipcMain.handle("meeting-templates:list", async () => listDesktopMeetingTemplates());
  ipcMain.handle("meeting-templates:save", async (_event, template) => saveDesktopMeetingTemplate(template));
  ipcMain.handle("meeting-templates:delete", async (_event, templateId: string) => deleteDesktopMeetingTemplate(templateId));
  ipcMain.handle("session:ask-question", async (_event, question: string, sessionId?: string | null) => askDesktopSessionQuestion(question, sessionId));
  ipcMain.handle("session:list", async (_event, limit?: number) => listDesktopSessions(limit));
  ipcMain.handle("session:get", async (_event, sessionId: string) => readDesktopSessionDetail(sessionId));
  ipcMain.handle("calendar:refresh", async () => refreshCalendars());
  ipcMain.handle("meeting:brief:get", async (_event, meetingId: string) => readDesktopMeetingBrief(meetingId));
  ipcMain.handle("meeting:brief:save", async (_event, meetingId: string, context: MeetingContext) => saveDesktopMeetingBrief(meetingId, context));
  ipcMain.handle("meeting:launch-context:get", async (_event, meetingId: string) => readDesktopMeetingLaunchContext(meetingId));
  ipcMain.handle(
    "meeting:launch-context:save",
    async (_event, meetingId: string, payload: StoredMeetingLaunchContext) => saveDesktopMeetingLaunchContext(meetingId, payload),
  );
  ipcMain.handle("meeting:email-history", async (_event, meetingId: string) => readDesktopMeetingEmailHistory(meetingId));
  ipcMain.handle("meeting:session-history", async (_event, meetingId: string) => readDesktopMeetingSessionHistory(meetingId));
  ipcMain.handle("calendar:connect", async (_event, provider: "google" | "microsoft") => {
    await calendarService.connect(provider);
    return refreshCalendars();
  });
  ipcMain.handle("calendar:disconnect", async (_event, provider: "google" | "microsoft") => {
    await calendarService.disconnect(provider);
    return refreshCalendars();
  });
  ipcMain.handle("calendar:create-mock-meeting", async () => {
    calendarService.createMockMeeting();
    meetingScheduler.setMeetings(calendarService.getUpcomingMeetings());
    return broadcastSnapshot();
  });
  ipcMain.handle("meeting:launch", async (_event, meetingId: string, meetingContext: MeetingContext | null) => {
    const meeting = calendarService.getUpcomingMeetings().find((item) => item.id === meetingId);
    if (!meeting) {
      return broadcastSnapshot();
    }

    if (meetingContext) {
      await saveDesktopMeetingBrief(meetingId, meetingContext);
    }

    return startSession(meeting, meetingContext);
  });
  ipcMain.handle("meeting:dismiss-popup", async () => {
    snapshot.pendingPopupMeeting = null;
    return broadcastSnapshot();
  });
  ipcMain.handle("session:debug-transcript", async (_event, source: AudioSourceKind, text: string) => {
    if (!snapshot.activeSession) {
      return broadcastSnapshot();
    }

    realtimeClient?.send({
      kind: "debug_transcript",
      sessionId: snapshot.activeSession.id,
      source,
      text,
      createdAt: new Date().toISOString(),
    });
    autoStopController.noteAudioActivity();
    return broadcastSnapshot();
  });
  ipcMain.on("audio:chunk", (_event, source: AudioSourceKind, payloadBase64: string, sampleRate: number) => {
    if (!snapshot.activeSession) {
      return;
    }

    const sent = realtimeClient?.send({
      kind: "audio_chunk",
      sessionId: snapshot.activeSession.id,
      source,
      sampleRate,
      payloadBase64,
      createdAt: new Date().toISOString(),
    });
    if (!sent) {
      console.warn(`Dropped ${source} audio chunk because realtime socket is unavailable.`);
    }
    autoStopController.noteAudioActivity();
    noteCaptureChunk(source);
    if (snapshot.captureHealth[source].chunkCount % 10 === 9) {
      broadcastSnapshot();
    }
  });
  ipcMain.handle("audio:activity", async (_event, source: AudioSourceKind, level: number) => {
    if (snapshot.activeSession && level > 0.01) {
      autoStopController.noteAudioActivity();
      snapshot.captureHealth = {
        ...snapshot.captureHealth,
        [source]: {
          ...snapshot.captureHealth[source],
          lastActivityAt: new Date().toISOString(),
        },
      };
      broadcastSnapshot();
    }
  });
  ipcMain.handle(
    "audio:status",
    async (_event, source: AudioSourceKind, status: "idle" | "starting" | "active" | "error", detail: string) => {
      updateCaptureHealth(source, status, detail);
      return broadcastSnapshot();
    },
  );
  ipcMain.handle("meeting:provider-ended", async () => {
    if (snapshot.activeSession) {
      autoStopController.noteProviderEndState();
    }
  });
  ipcMain.handle("session:end", async () => stopSession("manual"));
}

function createControlWindow(): void {
  const rendererCandidates = [
    path.resolve(__dirname, "..", "renderer", "index.html"),
    path.resolve(__dirname, "..", "..", "..", "..", "..", "src", "renderer", "index.html"),
    path.resolve(__dirname, "..", "..", "..", "..", "src", "renderer", "index.html"),
    path.resolve(__dirname, "..", "..", "src", "renderer", "index.html"),
    path.join(app.getAppPath(), "src", "renderer", "index.html"),
  ];
  const rendererEntry = rendererCandidates.find((candidate) => existsSync(candidate));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on("closed", () => {
    if (mainWindow?.isDestroyed()) {
      mainWindow = null;
    }
  });

  if (!rendererEntry) {
    throw new Error("Unable to resolve renderer entry HTML.");
  }

  mainWindow.loadFile(rendererEntry);
}

app.whenReady().then(async () => {
  configureSessionPermissions();
  sessionStore = new SessionStore(
    process.env.LISTEN_DB_PATH?.trim() || (app.isPackaged ? path.join(app.getPath("userData"), "listen.db") : path.resolve(process.cwd(), "data", "listen.db")),
  );
  const calendarSyncClient = new CalendarSyncClient(realtimeHttpUrl);
  const meetingResearchClient = new MeetingResearchClient(realtimeHttpUrl);
  calendarService = new CalendarService(
    sessionStore,
    shell.openExternal,
    calendarSyncClient.syncMeetings.bind(calendarSyncClient),
    meetingResearchClient.listMeetingResearch.bind(meetingResearchClient),
  );
  const persisted = await calendarService.initialize();
  snapshot.lastSummary = persisted.lastSummary;

  registerHandlers();

  meetingScheduler.on("popup", (meeting: MeetingRecord) => {
    snapshot.pendingPopupMeeting = meeting;
    broadcastSnapshot();
  });

  autoStopController.on("stopRequested", (_sessionId: string, reason: SessionStopReason) => {
    void stopSession(reason);
  });

  await refreshCalendars();
  createControlWindow();
  configureAutoUpdater();
  broadcastSnapshot();
  broadcastUpdaterState();
});

app.on("window-all-closed", () => {
  closeMeetingWindow();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
