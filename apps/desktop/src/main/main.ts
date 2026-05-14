import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { AdminManagedUser, AdminOrganizationSummary, AdminUserDirectory, AppAuthState, AppSnapshot, AudioSourceKind, CoachingSettings, MeetingContext, MeetingContextTemplate, MeetingRecord, OrgContextDocument, SessionHistoryDetail, SessionHistoryItem, SessionParticipantTranslationPreferences, SessionQuestionAnswer, SessionStopReason, SessionSummary } from "@listen/shared";
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, Notification, session, shell, Tray } from "electron";
import type { MessageBoxOptions } from "electron";
import dotenv from "dotenv";
import { autoUpdater } from "electron-updater";

import { CalendarService } from "./calendar/calendarService";
import { MeetingResearchClient } from "./calendar/meetingResearchClient";
import { CalendarSyncClient } from "./calendar/calendarSyncClient";
import { RealtimeClient } from "./realtime/realtimeClient";
import { MeetingScheduler } from "./scheduler/meetingScheduler";
import { AutoStopController } from "./session/autoStopController";
import { SessionStore, type DesktopCloseBehavior, type StoredMeetingLaunchContext, type StoredRuntimeSecrets, type StoredTranslationRuntimeSettings } from "./storage/sessionStore";
import { fetchWithTimeout } from "./http/fetchWithTimeout";
import { DesktopSupabaseAuthService } from "./auth/supabaseAuth";

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

function resolveEnvPath(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", "..", "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", "..", ".env"),
    path.resolve(path.dirname(process.execPath), ".env"),
    path.resolve(process.resourcesPath, ".env"),
    path.resolve(process.resourcesPath, "app", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

dotenv.config({ path: resolveEnvPath() });

if (!app.isPackaged) {
  const electronStateRoot = path.resolve(process.cwd(), ".cache", "listen-desktop");
  const userDataPath = path.join(electronStateRoot, "user-data");
  const sessionDataPath = path.join(electronStateRoot, "session-data");
  const cachePath = path.join(electronStateRoot, "cache");

  [electronStateRoot, userDataPath, sessionDataPath, cachePath].forEach((directoryPath) => {
    mkdirSync(directoryPath, { recursive: true });
  });

  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  app.setPath("cache", cachePath);
  app.disableHardwareAcceleration();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getDefaultRealtimePort(): string {
  return app.isPackaged ? "8787" : "8788";
}

function getConfiguredRealtimePort(): string {
  if (!app.isPackaged) {
    return getDefaultRealtimePort();
  }

  return process.env.LISTEN_REALTIME_PORT?.trim() || getDefaultRealtimePort();
}

function resolveRealtimeHttpUrl(): string {
  const explicitUrl = process.env.LISTEN_API_BASE_URL?.trim();
  if (explicitUrl) {
    return trimTrailingSlash(explicitUrl);
  }

  return `http://localhost:${getConfiguredRealtimePort()}`;
}

function resolveRealtimeWsUrl(httpUrl: string): string {
  const explicitUrl = process.env.LISTEN_WS_URL?.trim();
  if (explicitUrl) {
    return trimTrailingSlash(explicitUrl);
  }

  try {
    const url = new URL(httpUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return `ws://localhost:${getConfiguredRealtimePort()}/ws`;
  }
}

function normalizeStoredRuntimeSecrets(value: Partial<StoredRuntimeSecrets> | null | undefined): StoredRuntimeSecrets {
  return {
    aiApiKey: typeof value?.aiApiKey === "string" ? value.aiApiKey.trim() : "",
    transcriptionApiKey: typeof value?.transcriptionApiKey === "string" ? value.transcriptionApiKey.trim() : "",
  };
}

function getEnvRuntimeSecrets(): StoredRuntimeSecrets {
  return {
    aiApiKey: process.env.LISTEN_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "",
    transcriptionApiKey: process.env.DEEPGRAM_API_KEY?.trim() || "",
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string"
      ? Number(value.trim())
      : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getEnvTranslationRuntimeSettings(): StoredTranslationRuntimeSettings {
  return {
    enabled: process.env.LISTEN_TRANSLATION_ENABLED === "true",
    hostLanguage: process.env.LISTEN_TRANSLATION_SOURCE_LANGUAGE?.trim() || "English",
    guestLanguage: process.env.LISTEN_TRANSLATION_TARGET_LANGUAGE?.trim() || "English",
    hostVoiceEnabled: false,
    guestVoiceEnabled: false,
    hostVoiceName: "",
    guestVoiceName: "",
    transcriptionFlushMs: normalizePositiveInteger(process.env.LISTEN_TRANSCRIPTION_FLUSH_MS, 2500),
    transcriptionFlushBytes: normalizePositiveInteger(process.env.LISTEN_TRANSCRIPTION_FLUSH_BYTES, 96000),
  };
}

function normalizeStoredTranslationRuntimeSettings(
  value: Partial<StoredTranslationRuntimeSettings> | null | undefined,
  fallback: StoredTranslationRuntimeSettings = getEnvTranslationRuntimeSettings(),
): StoredTranslationRuntimeSettings {
  return {
    enabled: value?.enabled === true,
    hostLanguage: typeof (value as { hostLanguage?: unknown; sourceLanguage?: unknown })?.hostLanguage === "string"
      && String((value as { hostLanguage?: unknown }).hostLanguage).trim()
      ? String((value as { hostLanguage: string }).hostLanguage).trim()
      : typeof (value as { sourceLanguage?: unknown })?.sourceLanguage === "string" && String((value as { sourceLanguage: string }).sourceLanguage).trim()
        ? String((value as { sourceLanguage: string }).sourceLanguage).trim()
        : fallback.hostLanguage,
    guestLanguage: typeof (value as { guestLanguage?: unknown; targetLanguage?: unknown })?.guestLanguage === "string"
      && String((value as { guestLanguage?: unknown }).guestLanguage).trim()
      ? String((value as { guestLanguage: string }).guestLanguage).trim()
      : typeof (value as { targetLanguage?: unknown })?.targetLanguage === "string" && String((value as { targetLanguage: string }).targetLanguage).trim()
        ? String((value as { targetLanguage: string }).targetLanguage).trim()
        : fallback.guestLanguage,
    hostVoiceEnabled: (value as { hostVoiceEnabled?: unknown } | null | undefined)?.hostVoiceEnabled === true,
    guestVoiceEnabled: (value as { guestVoiceEnabled?: unknown } | null | undefined)?.guestVoiceEnabled === true,
    hostVoiceName: typeof (value as { hostVoiceName?: unknown })?.hostVoiceName === "string"
      ? String((value as { hostVoiceName: string }).hostVoiceName).trim()
      : fallback.hostVoiceName,
    guestVoiceName: typeof (value as { guestVoiceName?: unknown })?.guestVoiceName === "string"
      ? String((value as { guestVoiceName: string }).guestVoiceName).trim()
      : fallback.guestVoiceName,
    transcriptionFlushMs: normalizePositiveInteger(value?.transcriptionFlushMs, fallback.transcriptionFlushMs),
    transcriptionFlushBytes: normalizePositiveInteger(value?.transcriptionFlushBytes, fallback.transcriptionFlushBytes),
  };
}

function getSessionParticipantTranslationPreferences(): SessionParticipantTranslationPreferences {
  const settings = getEffectiveTranslationRuntimeSettings();
  return {
    host: {
      language: settings.hostLanguage,
      voiceEnabled: settings.hostVoiceEnabled,
      voiceName: settings.hostVoiceName || null,
    },
    guest: {
      language: settings.guestLanguage,
      voiceEnabled: settings.guestVoiceEnabled,
      voiceName: settings.guestVoiceName || null,
    },
  };
}

function normalizeSessionParticipantTranslationPreferences(
  value: SessionParticipantTranslationPreferences | null | undefined,
  fallback: SessionParticipantTranslationPreferences = getSessionParticipantTranslationPreferences(),
): SessionParticipantTranslationPreferences {
  return {
    host: {
      language: value?.host?.language?.trim() || fallback.host.language,
      voiceEnabled: value?.host?.voiceEnabled ?? fallback.host.voiceEnabled,
      voiceName: value?.host?.voiceName?.trim() || fallback.host.voiceName || null,
    },
    guest: {
      language: value?.guest?.language?.trim() || fallback.guest.language,
      voiceEnabled: value?.guest?.voiceEnabled ?? fallback.guest.voiceEnabled,
      voiceName: value?.guest?.voiceName?.trim() || fallback.guest.voiceName || null,
    },
  };
}

const popupLeadMinutes = Number(process.env.LISTEN_MEETING_POPUP_LEAD_MINUTES ?? 2);
const realtimeHttpUrl = resolveRealtimeHttpUrl();
const realtimeUrl = resolveRealtimeWsUrl(realtimeHttpUrl);
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
let activeSessionParticipantPreferences: SessionParticipantTranslationPreferences | null = null;
let pendingStopTimeout: NodeJS.Timeout | null = null;
let updaterConfigured = false;
let tray: Tray | null = null;
let isQuitting = false;
let desktopCloseBehavior: DesktopCloseBehavior = "ask";
let desktopRuntimeSecrets: StoredRuntimeSecrets = { aiApiKey: "", transcriptionApiKey: "" };
let desktopTranslationRuntimeSettings: StoredTranslationRuntimeSettings = getEnvTranslationRuntimeSettings();
let appAuthService: DesktopSupabaseAuthService;
let updaterCheckStartedAt: number | null = null;
let pendingUpdaterStatePatch: Partial<DesktopUpdaterState> | null = null;
let pendingUpdaterStateTimeout: NodeJS.Timeout | null = null;
let embeddedRealtimeModuleLoad: Promise<void> | null = null;
let embeddedRealtimeProcess: ChildProcess | null = null;
let embeddedRealtimeStopRequested = false;
let pendingRealtimeRecovery: Promise<void> | null = null;

const minimumUpdaterCheckingDurationMs = 1000;
const embeddedRealtimeStartupTimeoutMs = 15_000;
const updaterStartupCheckDelayMs = 60_000;
const updaterPeriodicCheckIntervalMs = 4 * 60 * 60_000;

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

let updaterStartupCheckTimeout: NodeJS.Timeout | null = null;
let updaterPeriodicCheckInterval: NodeJS.Timeout | null = null;
let lastAvailableUpdateNotificationVersion: string | null = null;
let lastDownloadedUpdateNotificationVersion: string | null = null;
let pendingQuitAfterSessionFinalize = false;

const hasSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true;

if (app.isPackaged && !hasSingleInstanceLock) {
  app.quit();
}

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

function resolveDesktopDatabasePath(): string {
  return process.env.LISTEN_DB_PATH?.trim() || (app.isPackaged ? path.join(app.getPath("userData"), "listen.db") : path.resolve(process.cwd(), "data", "listen.db"));
}

function migrateLegacyOrgContextDocuments(databasePath: string): void {
  if (!app.isPackaged) {
    return;
  }

  const legacyDatabasePath = path.join(app.getPath("userData"), "data", "listen.db");
  if (!existsSync(legacyDatabasePath) || legacyDatabasePath === databasePath) {
    return;
  }

  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  const currentDatabase = new DatabaseSync(databasePath);

  try {
    const legacyHasOrgContextTable = (legacyDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("org_context_documents") as { name?: string } | undefined)?.name;
    if (!legacyHasOrgContextTable) {
      return;
    }

    currentDatabase.exec(`
      CREATE TABLE IF NOT EXISTS org_context_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_url TEXT,
        source_name TEXT,
        mime_type TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    const currentDocumentCount = Number((currentDatabase.prepare("SELECT COUNT(*) as count FROM org_context_documents").get() as { count: number }).count || 0);
    if (currentDocumentCount > 0) {
      return;
    }

    const legacyDocuments = legacyDatabase.prepare(
      `
        SELECT id, title, content, source_url as sourceUrl, source_name as sourceName, mime_type as mimeType, updated_at as updatedAt
        FROM org_context_documents
        ORDER BY updated_at DESC
      `,
    ).all() as unknown as OrgContextDocument[];

    if (!legacyDocuments.length) {
      return;
    }

    const insertDocument = currentDatabase.prepare(
      `
        INSERT INTO org_context_documents (id, title, content, source_url, source_name, mime_type, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          source_url = excluded.source_url,
          source_name = excluded.source_name,
          mime_type = excluded.mime_type,
          updated_at = excluded.updated_at
      `,
    );

    for (const document of legacyDocuments) {
      insertDocument.run(
        document.id,
        document.title,
        document.content,
        document.sourceUrl ?? null,
        document.sourceName ?? null,
        document.mimeType ?? null,
        document.updatedAt,
      );
    }

    console.log(`Migrated ${legacyDocuments.length} legacy org context document(s) from ${legacyDatabasePath} to ${databasePath}.`);
  } finally {
    legacyDatabase.close();
    currentDatabase.close();
  }
}

function resolveBundledRealtimeEntry(): string | null {
  const candidates = [
    path.resolve(process.resourcesPath, "realtime", "server.cjs"),
    path.resolve(app.getAppPath(), "dist", "apps", "desktop", "resources", "realtime", "server.cjs"),
    path.resolve(__dirname, "..", "..", "resources", "realtime", "server.cjs"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function isRealtimeServiceHealthy(): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${realtimeHttpUrl}/health`, {}, 1_500);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForRealtimeServiceReady(timeoutMs = embeddedRealtimeStartupTimeoutMs): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRealtimeServiceHealthy()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function ensureRealtimeServiceAvailable(databasePath: string): Promise<void> {
  if (await isRealtimeServiceHealthy()) {
    return;
  }

  if (embeddedRealtimeModuleLoad) {
    await embeddedRealtimeModuleLoad;
    await waitForRealtimeServiceReady();
    return;
  }

  const bundledEntry = resolveBundledRealtimeEntry();
  if (!bundledEntry) {
    console.warn("Bundled realtime service entry was not found in desktop resources.");
    return;
  }

  process.env.HOST = process.env.HOST?.trim() || "127.0.0.1";
  process.env.LISTEN_DB_PATH = databasePath;
  process.env.LISTEN_REALTIME_PORT = getConfiguredRealtimePort();
  process.env.LISTEN_PUBLIC_BASE_URL = process.env.LISTEN_PUBLIC_BASE_URL?.trim() || realtimeHttpUrl;

  embeddedRealtimeModuleLoad = Promise.resolve().then(() => {
    embeddedRealtimeStopRequested = false;
    embeddedRealtimeProcess = spawn(process.execPath, [bundledEntry], {
      cwd: app.getPath("userData"),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    embeddedRealtimeProcess.stdout?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log(`[realtime] ${text}`);
      }
    });
    embeddedRealtimeProcess.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[realtime] ${text}`);
      }
    });
    embeddedRealtimeProcess.on("exit", (code, signal) => {
      if (!(embeddedRealtimeStopRequested || isQuitting)) {
        const exitDescription = signal
          ? `signal ${signal}`
          : `code ${code ?? -1}`;
        console.warn(`Bundled realtime service exited unexpectedly with ${exitDescription}.`);
      }
      embeddedRealtimeStopRequested = false;
      embeddedRealtimeProcess = null;
      embeddedRealtimeModuleLoad = null;
    });
  });

  try {
    await embeddedRealtimeModuleLoad;
  } catch (error) {
    console.warn("Bundled realtime service failed to launch in a utility process.", error);
    embeddedRealtimeModuleLoad = null;
    embeddedRealtimeProcess = null;
    return;
  }

  const healthy = await waitForRealtimeServiceReady();
  if (!healthy) {
    console.warn(`Bundled realtime service did not become healthy at ${realtimeHttpUrl} within ${embeddedRealtimeStartupTimeoutMs}ms.`);
  }
}

const snapshot: AppSnapshot = {
  calendarConnections: [],
  appAuth: {
    configured: false,
    signedIn: false,
    pendingEmail: null,
    accessMessage: null,
    user: null,
  },
  upcomingMeetings: [],
  pendingPopupMeeting: null,
  activeSession: null,
  participantPreferences: null,
  captureHealth: createInitialCaptureHealth(),
  translationHealth: {
    status: "idle",
    detail: "Live translation is idle.",
    lastUpdatedAt: null,
  },
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

interface MeetingDriveDocument {
  id: string;
  title: string;
  modifiedAt: string;
  mimeType: string;
  sourceUrl: string;
  snippet: string;
}

interface MeetingDriveHistory {
  status: "ready" | "not_connected" | "needs_reconnect" | "unavailable" | "error";
  note: string;
  documents: MeetingDriveDocument[];
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

function resetTranslationHealth(): void {
  snapshot.translationHealth = {
    status: "idle",
    detail: "Live translation is idle.",
    lastUpdatedAt: null,
  };
}

function updateTranslationHealth(status: "idle" | "starting" | "active" | "error", detail: string): void {
  snapshot.translationHealth = {
    status,
    detail,
    lastUpdatedAt: new Date().toISOString(),
  };
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

    const preferredMeetingSourceId = meetingWindow && !meetingWindow.isDestroyed()
      ? meetingWindow.getMediaSourceId()
      : null;
    const sources = await desktopCapturer.getSources({
      types: preferredMeetingSourceId ? ["window", "screen"] : ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const preferredSource = preferredMeetingSourceId
      ? sources.find((source) => source.id === preferredMeetingSourceId)
      : null;
    const fallbackSource = sources.find((source) => source.id.startsWith("screen:")) ?? sources[0];
    const selectedSource = process.platform === "win32"
      ? fallbackSource
      : preferredSource ?? fallbackSource;

    if (!selectedSource) {
      callback({});
      return;
    }

    callback({
      video: selectedSource,
      audio: process.platform === "win32" ? "loopback" : undefined,
    });
  });
}

function broadcastSnapshot(): AppSnapshot {
  snapshot.calendarConnections = calendarService.getConnections();
  snapshot.upcomingMeetings = calendarService.getUpcomingMeetings();
  snapshot.appAuth = appAuthService?.getState?.() ?? snapshot.appAuth;

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

function getTrayIconPath(): string | null {
  const candidates = [
    path.resolve(process.resourcesPath, "icon.ico"),
    path.resolve(process.cwd(), "apps", "desktop", "build", "icon.ico"),
    path.resolve(process.cwd(), "build", "icon.ico"),
    path.resolve(__dirname, "..", "..", "build", "icon.ico"),
    path.resolve(__dirname, "..", "..", "..", "build", "icon.ico"),
    path.join(app.getAppPath(), "build", "icon.ico"),
    path.join(app.getAppPath(), "apps", "desktop", "build", "icon.ico"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setSkipTaskbar(false);
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function hideMainWindowToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
}

function updateTrayMenu(): void {
  if (!tray) {
    return;
  }

  tray.setToolTip("Listen");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? "Focus Listen" : "Open Listen",
        click: () => showMainWindow(),
      },
      {
        label: "Check for updates",
        click: () => {
          void checkForDesktopUpdates();
          showMainWindow();
        },
      },
      { type: "separator" },
      {
        label: "Quit Listen",
        click: () => {
          isQuitting = true;
          closeMeetingWindow();
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  if (tray) {
    updateTrayMenu();
    return;
  }

  const trayIconPath = getTrayIconPath();
  if (!trayIconPath) {
    return;
  }

  tray = new Tray(trayIconPath);
  tray.on("click", () => showMainWindow());
  updateTrayMenu();
}

async function promptForTrayBehavior(): Promise<DesktopCloseBehavior | "cancel"> {
  const windowInstance = mainWindow;
  const dialogOptions: MessageBoxOptions = {
    type: "question",
    buttons: ["Hide to tray", "Quit", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: "Remember my choice",
    title: "Keep Listen running?",
    message: "Close Listen to the tray instead of quitting?",
    detail: "This keeps reminders, quick reopen, and update checks available in the background. You can fully exit from the tray menu at any time.",
  };
  const result = windowInstance
    ? await dialog.showMessageBox(windowInstance, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);

  const behavior = result.response === 0 ? "tray" : result.response === 1 ? "quit" : "cancel";
  if (result.checkboxChecked && behavior !== "cancel") {
    desktopCloseBehavior = behavior;
    await sessionStore.writeDesktopCloseBehavior(behavior);
  }

  return behavior;
}

async function confirmAutomaticSessionEnd(reason: SessionStopReason): Promise<boolean> {
  const reasonLabel = reason === "provider_end_state"
    ? "Listen thinks the meeting ended."
    : reason === "meeting_window_closed"
      ? "Listen saw the meeting window close."
      : reason === "calendar_end"
        ? "Listen reached the scheduled end of the meeting and then saw inactivity."
        : "Listen detected a long period of inactivity."
  ;
  const dialogOptions: MessageBoxOptions = {
    type: "question",
    buttons: ["End session", "Keep session running"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "End Listen session?",
    message: reasonLabel,
    detail: "Confirm whether Listen should stop the current session now.",
  };
  const windowInstance = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = windowInstance
    ? await dialog.showMessageBox(windowInstance, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);

  return result.response === 0;
}

function handleMainWindowClose(event: Electron.Event): void {
  if (isQuitting) {
    return;
  }

  if (desktopCloseBehavior === "quit") {
    isQuitting = true;
    closeMeetingWindow();
    app.quit();
    return;
  }

  event.preventDefault();

  if (desktopCloseBehavior === "tray") {
    hideMainWindowToTray();
    return;
  }

  void promptForTrayBehavior().then((behavior) => {
    if (behavior === "tray") {
      hideMainWindowToTray();
      return;
    }

    if (behavior === "quit") {
      isQuitting = true;
      closeMeetingWindow();
      app.quit();
    }
  });
}

function setUpdaterState(patch: Partial<DesktopUpdaterState>): DesktopUpdaterState {
  const nextAvailability = patch.availability;

  if (nextAvailability === "checking") {
    updaterCheckStartedAt = Date.now();
    pendingUpdaterStatePatch = null;
    if (pendingUpdaterStateTimeout) {
      clearTimeout(pendingUpdaterStateTimeout);
      pendingUpdaterStateTimeout = null;
    }
  } else if (updaterState.availability === "checking" && updaterCheckStartedAt !== null) {
    const remainingDelay = minimumUpdaterCheckingDurationMs - (Date.now() - updaterCheckStartedAt);
    if (remainingDelay > 0) {
      pendingUpdaterStatePatch = patch;
      if (pendingUpdaterStateTimeout) {
        clearTimeout(pendingUpdaterStateTimeout);
      }
      pendingUpdaterStateTimeout = setTimeout(() => {
        pendingUpdaterStateTimeout = null;
        updaterCheckStartedAt = null;
        const delayedPatch = pendingUpdaterStatePatch;
        pendingUpdaterStatePatch = null;
        if (delayedPatch) {
          setUpdaterState(delayedPatch);
        }
      }, remainingDelay);
      return updaterState;
    }
  }

  if (nextAvailability && nextAvailability !== "checking") {
    updaterCheckStartedAt = null;
    pendingUpdaterStatePatch = null;
    if (pendingUpdaterStateTimeout) {
      clearTimeout(pendingUpdaterStateTimeout);
      pendingUpdaterStateTimeout = null;
    }
  }

  updaterState = {
    ...updaterState,
    ...patch,
  };

  return broadcastUpdaterState();
}

function showDesktopUpdateNotification(title: string, body: string): void {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title,
    body,
    silent: false,
  });
  notification.on("click", () => {
    showMainWindow();
  });
  notification.show();
}

function schedulePeriodicUpdateChecks(): void {
  if (!updaterConfigured) {
    return;
  }

  if (updaterStartupCheckTimeout) {
    clearTimeout(updaterStartupCheckTimeout);
  }
  if (updaterPeriodicCheckInterval) {
    clearInterval(updaterPeriodicCheckInterval);
  }

  updaterStartupCheckTimeout = setTimeout(() => {
    updaterStartupCheckTimeout = null;
    void checkForDesktopUpdates();
  }, updaterStartupCheckDelayMs);

  updaterPeriodicCheckInterval = setInterval(() => {
    void checkForDesktopUpdates();
  }, updaterPeriodicCheckIntervalMs);
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
    const version = info.version ?? null;
    setUpdaterState({
      enabled: true,
      availability: "available",
      availableVersion: version,
      checkedAt: new Date().toISOString(),
      progress: 0,
      message: `Update ${version ?? "available"} found. Downloading now...`,
    });

    if (version && version !== lastAvailableUpdateNotificationVersion) {
      lastAvailableUpdateNotificationVersion = version;
      showDesktopUpdateNotification(
        "Listen update available",
        `Version ${version} is available and is downloading in the background.`,
      );
    }
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

    if (version && version !== lastDownloadedUpdateNotificationVersion) {
      lastDownloadedUpdateNotificationVersion = version;
      showDesktopUpdateNotification(
        "Listen update ready",
        `Version ${version} has been downloaded and is ready to install.`,
      );
    }
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

  schedulePeriodicUpdateChecks();
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

  autoUpdater.quitAndInstall(false, true);
}

function normalizeCoachingSettings(value: unknown): CoachingSettings {
  const candidate = (value ?? {}) as Partial<CoachingSettings>;
  return {
    style: candidate.style === "direct" || candidate.style === "challenger" ? candidate.style : defaultCoachingSettings.style,
    directness: candidate.directness === "gentle" || candidate.directness === "blunt" ? candidate.directness : defaultCoachingSettings.directness,
    frequency: candidate.frequency === "minimal" || candidate.frequency === "proactive" ? candidate.frequency : defaultCoachingSettings.frequency,
  };
}

function getEffectiveDesktopRuntimeSecrets(): StoredRuntimeSecrets {
  const envSecrets = getEnvRuntimeSecrets();
  return {
    aiApiKey: desktopRuntimeSecrets.aiApiKey || envSecrets.aiApiKey,
    transcriptionApiKey: desktopRuntimeSecrets.transcriptionApiKey || envSecrets.transcriptionApiKey,
  };
}

function getEffectiveTranslationRuntimeSettings(): StoredTranslationRuntimeSettings {
  return normalizeStoredTranslationRuntimeSettings(desktopTranslationRuntimeSettings, getEnvTranslationRuntimeSettings());
}

function getRuntimeCapabilitiesSnapshot(): {
  aiConfigured: boolean;
  cloudTranscriptionConfigured: boolean;
  translationEnabled: boolean;
  translationReady: boolean;
} {
  const secrets = getEffectiveDesktopRuntimeSecrets();
  const translationSettings = getEffectiveTranslationRuntimeSettings();
  return {
    aiConfigured: Boolean(secrets.aiApiKey),
    cloudTranscriptionConfigured: Boolean(secrets.transcriptionApiKey),
    translationEnabled: translationSettings.enabled,
    translationReady: translationSettings.enabled && Boolean(secrets.aiApiKey) && Boolean(secrets.transcriptionApiKey),
  };
}

async function fetchRealtimeWithAppAuth(pathname: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await appAuthService.getAccessToken();
  if (!accessToken) {
    throw new Error("Sign into Listen before using app user management.");
  }

  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetchWithTimeout(`${realtimeHttpUrl}${pathname}`, {
    ...init,
    headers,
  });
}

async function refreshDesktopAppAuthProfile(): Promise<AppAuthState> {
  const authState = appAuthService.getState();
  if (!authState.signedIn) {
    return authState;
  }

  const response = await fetchRealtimeWithAppAuth("/api/auth/me");
  if (!response.ok) {
    const body = await response.text();
    let errorMessage = "This account does not have access to Listen yet. Ask an admin to invite this email, or sign in with the invited account.";
    try {
      const payload = JSON.parse(body) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) {
        errorMessage = payload.error.trim();
      }
    } catch {
      if (body.trim()) {
        errorMessage = body.trim();
      }
    }
    if (response.status === 401 || response.status === 403) {
      const signedOutState = await appAuthService.signOut(errorMessage);
      snapshot.appAuth = signedOutState;
      return signedOutState;
    }
    throw new Error(`Failed to hydrate signed-in user: ${response.status} ${body}`.trim());
  }

  const payload = await response.json() as { user?: AppAuthState["user"] | null };
  return appAuthService.hydrateProfile(payload.user ?? null);
}

async function listDesktopAdminUsers(organizationId?: string | null): Promise<AdminUserDirectory> {
  const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
  const response = await fetchRealtimeWithAppAuth(`/api/admin/users${query}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to load users: ${response.status} ${body}`.trim());
  }

  return response.json() as Promise<AdminUserDirectory>;
}

async function listDesktopOrganizations(): Promise<AdminOrganizationSummary[]> {
  const response = await fetchRealtimeWithAppAuth("/api/admin/organizations");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to load organizations: ${response.status} ${body}`.trim());
  }

  const payload = await response.json() as { organizations?: AdminOrganizationSummary[] };
  return payload.organizations ?? [];
}

async function createDesktopOrganization(name: string, adminEmail: string, maxUsers?: number | null): Promise<AdminOrganizationSummary[]> {
  const response = await fetchRealtimeWithAppAuth("/api/admin/organizations", {
    method: "POST",
    body: JSON.stringify({ name, adminEmail, maxUsers: typeof maxUsers === "number" ? maxUsers : null }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create organization: ${response.status} ${body}`.trim());
  }

  return listDesktopOrganizations();
}

async function updateDesktopOrganization(
  organizationId: string,
  updates: { status?: "active" | "disabled"; maxUsers?: number | null },
): Promise<AdminOrganizationSummary[]> {
  const response = await fetchRealtimeWithAppAuth(`/api/admin/organizations/${encodeURIComponent(organizationId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update organization: ${response.status} ${body}`.trim());
  }

  return listDesktopOrganizations();
}

async function inviteDesktopAdminUser(email: string, role: AdminManagedUser["role"], organizationId?: string | null): Promise<AdminUserDirectory> {
  const inviteResponse = await fetchRealtimeWithAppAuth("/api/admin/users/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role, organizationId: organizationId ?? null }),
  });
  if (!inviteResponse.ok) {
    const body = await inviteResponse.text();
    throw new Error(`Failed to invite user: ${inviteResponse.status} ${body}`.trim());
  }

  return listDesktopAdminUsers(organizationId);
}

async function updateDesktopAdminInvitation(invitationId: string, action: "resend" | "revoke", organizationId?: string | null): Promise<AdminUserDirectory> {
  const response = await fetchRealtimeWithAppAuth(`/api/admin/users/invitations/${encodeURIComponent(invitationId)}`, {
    method: "PATCH",
    body: JSON.stringify({ action, organizationId: organizationId ?? null }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to ${action} invitation: ${response.status} ${body}`.trim());
  }

  return listDesktopAdminUsers(organizationId);
}

async function updateDesktopAdminUser(
  profileId: string,
  updates: { role?: AdminManagedUser["role"]; status?: AdminManagedUser["status"] },
  organizationId?: string | null,
): Promise<AdminUserDirectory> {
  const response = await fetchRealtimeWithAppAuth(`/api/admin/users/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...updates, organizationId: organizationId ?? null }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update user: ${response.status} ${body}`.trim());
  }

  return listDesktopAdminUsers(organizationId);
}

async function readDesktopRuntimeSecrets(): Promise<StoredRuntimeSecrets> {
  return normalizeStoredRuntimeSecrets(await sessionStore.readRuntimeSecrets());
}

async function readDesktopTranslationRuntimeSettings(): Promise<StoredTranslationRuntimeSettings> {
  const stored = await sessionStore.readTranslationRuntimeSettings();
  return normalizeStoredTranslationRuntimeSettings(stored, getEnvTranslationRuntimeSettings());
}

async function syncDesktopRuntimeSecretsToRealtime(): Promise<void> {
  const secrets = getEffectiveDesktopRuntimeSecrets();
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/runtime/secrets`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      aiApiKey: secrets.aiApiKey,
      deepgramApiKey: secrets.transcriptionApiKey,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to sync runtime secrets: ${response.status} ${body}`.trim());
  }
}

async function syncDesktopTranslationSettingsToRealtime(): Promise<void> {
  const settings = getEffectiveTranslationRuntimeSettings();
  const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/runtime/translation-settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to sync translation settings: ${response.status} ${body}`.trim());
  }
}

async function saveDesktopRuntimeSecrets(value: StoredRuntimeSecrets): Promise<StoredRuntimeSecrets> {
  const normalized = normalizeStoredRuntimeSecrets(value);
  await sessionStore.writeRuntimeSecrets(normalized);
  desktopRuntimeSecrets = normalized;

  try {
    await syncDesktopRuntimeSecretsToRealtime();
  } catch (error) {
    console.warn("Saved runtime secrets locally, but failed to sync them to realtime.", error);
  }

  return normalized;
}

async function saveDesktopTranslationRuntimeSettings(value: StoredTranslationRuntimeSettings): Promise<StoredTranslationRuntimeSettings> {
  const normalized = normalizeStoredTranslationRuntimeSettings(value, getEnvTranslationRuntimeSettings());
  await sessionStore.writeTranslationRuntimeSettings(normalized);
  desktopTranslationRuntimeSettings = normalized;

  try {
    await syncDesktopTranslationSettingsToRealtime();
  } catch (error) {
    console.warn("Saved translation settings locally, but failed to sync them to realtime.", error);
  }

  return normalized;
}

async function saveLiveSessionParticipantPreferences(
  value: SessionParticipantTranslationPreferences,
): Promise<AppSnapshot> {
  if (!snapshot.activeSession) {
    throw new Error("Start a meeting before updating live translation languages.");
  }

  const response = await fetchWithTimeout(
    `${realtimeHttpUrl}/api/live-sessions/${snapshot.activeSession.id}/participant-preferences`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update live session languages: ${response.status} ${body}`.trim());
  }

  const participantPreferences = await response.json() as SessionParticipantTranslationPreferences;
  activeSessionParticipantPreferences = participantPreferences;
  snapshot.participantPreferences = participantPreferences;
  updateTranslationHealth(
    "active",
    `Live session preferences updated: host ${participantPreferences.host.language}, guest ${participantPreferences.guest.language}.`,
  );
  return broadcastSnapshot();
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

async function sendRealtimeSessionStart(meeting: MeetingRecord, meetingContext: MeetingContext | null): Promise<void> {
  if (!snapshot.activeSession) {
    throw new Error("Start a meeting or finish one first so there is session context to query.");
  }

  const client = attachRealtimeClient();
  await client.connect();
  const participantPreferences = normalizeSessionParticipantTranslationPreferences(activeSessionParticipantPreferences);
  activeSessionParticipantPreferences = participantPreferences;
  snapshot.participantPreferences = participantPreferences;
  const sent = client.send({
    kind: "session_start",
    sessionId: snapshot.activeSession.id,
    meetingId: meeting.id,
    expectedEndAt: meeting.endsAt,
    meetingTitle: meeting.title,
    meetingProvider: meeting.provider,
    calendarProvider: meeting.calendarProvider,
    meetingContext,
    participantPreferences,
    attendees: (meeting.attendees ?? [])
      .filter((attendee) => attendee.fullName.trim().length > 0)
      .map((attendee) => ({
        fullName: attendee.fullName.trim(),
        email: attendee.email?.trim() || undefined,
      })),
  });

  if (!sent) {
    throw new Error(`The realtime service is unavailable at ${realtimeHttpUrl}. Start or restart @listen/realtime, then try again.`);
  }
}

async function ensureRealtimeLiveSessionAvailable(): Promise<void> {
  if (!snapshot.activeSession || !activeMeetingRecord) {
    return;
  }

  try {
    const response = await fetchWithTimeout(`${realtimeHttpUrl}/api/live-sessions/${encodeURIComponent(snapshot.activeSession.id)}/debug`, {}, 2_000);
    if (response.ok) {
      return;
    }

    if (response.status !== 404) {
      return;
    }
  } catch {
    // Fall through and attempt to rehydrate the live session over websocket.
  }

  const client = attachRealtimeClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  await sendRealtimeSessionStart(activeMeetingRecord, activeMeetingContext);
}

async function recoverRealtimeLiveSession(): Promise<void> {
  if (pendingRealtimeRecovery) {
    return pendingRealtimeRecovery;
  }

  pendingRealtimeRecovery = ensureRealtimeLiveSessionAvailable().finally(() => {
    pendingRealtimeRecovery = null;
  });

  return pendingRealtimeRecovery;
}

async function askDesktopSessionQuestion(question: string, sessionId?: string | null): Promise<SessionQuestionAnswer> {
  try {
    await syncDesktopRuntimeSecretsToRealtime();
  } catch (error) {
    console.warn("Failed to sync runtime secrets before session Q&A.", error);
  }

  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("Question is required.");
  }

  const explicitSessionId = String(sessionId || "").trim();
  const activeSessionId = snapshot.activeSession?.id ?? null;
  const completedSessionId = snapshot.lastSummary?.sessionId ?? null;

  if (!explicitSessionId && activeSessionId) {
    await ensureRealtimeLiveSessionAvailable();
  }

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

function formatContextQuestionError(status: number, body: string): string {
  const normalizedBody = body.trim();
  if (status === 404 && /Cannot POST \/api\/questions\/context/i.test(normalizedBody)) {
    return "The realtime service is running an older build and does not support context Q&A yet. Restart the realtime service, then try again.";
  }

  return `Failed to answer context question: ${status} ${normalizedBody}`.trim();
}

function formatRealtimeQuestionRequestError(error: unknown): Error {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket|network/i.test(message)) {
    return new Error(`The realtime service is unavailable at ${realtimeHttpUrl}. Start or restart @listen/realtime, then try again.`);
  }

  if (/Request timed out after \d+ms/i.test(message)) {
    return new Error(`The realtime service at ${realtimeHttpUrl} did not respond in time. Make sure @listen/realtime is running, then try again.`);
  }

  return error instanceof Error ? error : new Error(message);
}

async function askDesktopContextQuestion(payload: ContextQuestionPayload): Promise<SessionQuestionAnswer> {
  try {
    await syncDesktopRuntimeSecretsToRealtime();
  } catch (error) {
    console.warn("Failed to sync runtime secrets before context Q&A.", error);
  }

  const trimmedQuestion = payload.question.trim();
  const trimmedTitle = payload.title.trim();
  if (!trimmedQuestion) {
    throw new Error("Question is required.");
  }

  if (!trimmedTitle) {
    throw new Error("Context title is required.");
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(`${realtimeHttpUrl}/api/questions/context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        question: trimmedQuestion,
        title: trimmedTitle,
      }),
    });
  } catch (error) {
    throw formatRealtimeQuestionRequestError(error);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(formatContextQuestionError(response.status, body));
  }

  return response.json() as Promise<SessionQuestionAnswer>;
}

async function listDesktopSessions(limit = 20): Promise<SessionHistoryItem[]> {
  return sessionStore.listSessions(limit);
}

async function readDesktopSessionDetail(sessionId: string): Promise<SessionHistoryDetail> {
  const session = await sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error("Failed to load session detail: session not found.");
  }

  return session;
}

async function deleteDesktopSession(sessionId: string): Promise<void> {
  const deleted = await sessionStore.deleteSession(sessionId);
  if (!deleted) {
    throw new Error("Failed to delete session: session not found.");
  }
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

function escapeGoogleQueryTerm(value: string): string {
  return value.replace(/'/g, "\\'");
}

function buildMeetingDriveQuery(meeting: MeetingRecord): string {
  const tokens = [
    ...tokenizeMeetingText(meeting.title),
    ...(meeting.attendees ?? []).flatMap((attendee) => tokenizeMeetingText(`${attendee.fullName || ""} ${attendee.email || ""}`)),
  ]
    .filter((token) => token.length >= 4)
    .filter((token, index, values) => values.indexOf(token) === index)
    .slice(0, 6);

  if (!tokens.length) {
    return "";
  }

  const searchClause = tokens
    .map((token) => `(name contains '${escapeGoogleQueryTerm(token)}' or fullText contains '${escapeGoogleQueryTerm(token)}')`)
    .join(" or ");

  return [
    "trashed = false",
    "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain' or mimeType = 'text/markdown')",
    `(${searchClause})`,
  ].join(" and ");
}

function buildMeetingDriveSnippet(content: string, meeting: MeetingRecord): string {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  if (!normalizedContent) {
    return "";
  }

  const tokens = new Set([
    ...tokenizeMeetingText(meeting.title),
    ...(meeting.attendees ?? []).flatMap((attendee) => tokenizeMeetingText(`${attendee.fullName || ""} ${attendee.email || ""}`)),
  ]);
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matchingLine = lines.find((line) => tokenizeMeetingText(line).some((token) => tokens.has(token)));
  const snippet = matchingLine || normalizedContent;
  return snippet.slice(0, 320).trim();
}

async function readGoogleDriveTextDocument(accessToken: string, fileId: string, mimeType: string): Promise<string> {
  const endpoint = mimeType === "application/vnd.google-apps.document"
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/plain")}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return "";
  }

  return (await response.text()).trim();
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

async function readDesktopMeetingDriveHistory(meetingId: string): Promise<MeetingDriveHistory> {
  const meeting = calendarService.getUpcomingMeetings().find((item) => item.id === meetingId);
  if (!meeting) {
    return {
      status: "unavailable",
      note: "Meeting not found.",
      documents: [],
    };
  }

  const accessToken = await calendarService.getAccessToken("google");
  if (!accessToken) {
    return {
      status: "not_connected",
      note: "Connect Google in Setup to search Google Drive transcripts for this meeting.",
      documents: [],
    };
  }

  const query = buildMeetingDriveQuery(meeting);
  if (!query) {
    return {
      status: "unavailable",
      note: "There is not enough meeting metadata yet to search Google Drive transcripts.",
      documents: [],
    };
  }

  const listResponse = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?pageSize=6&orderBy=modifiedTime desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(query)}`,
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
        note: "Reconnect Google in Setup to grant Drive access for transcript history.",
        documents: [],
      };
    }

    if (listResponse.status === 403) {
      if (["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"].includes(reason)) {
        return {
          status: "needs_reconnect",
          note: "Google is connected, but Drive permission is missing. Reconnect Google in Setup and accept Drive access.",
          documents: [],
        };
      }

      if (["SERVICE_DISABLED", "accessNotConfigured"].includes(reason) || /drive api has not been used|api has not been used|service has been disabled/i.test(message)) {
        return {
          status: "error",
          note: "Google is connected, but the Drive API is not enabled for this project. Enable the Drive API in Google Cloud, then refresh transcript history.",
          documents: [],
        };
      }
    }

    return {
      status: "error",
      note: `Google Drive search failed: ${listResponse.status} ${body}`.trim(),
      documents: [],
    };
  }

  const payload = (await listResponse.json()) as {
    files?: Array<{
      id?: string;
      name?: string;
      mimeType?: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };

  const files = (payload.files ?? []).filter((file) => Boolean(file.id && file.name && file.mimeType));
  if (!files.length) {
    return {
      status: "ready",
      note: "No related Google Drive transcripts were found for this meeting.",
      documents: [],
    };
  }

  const documents = (await Promise.all(files.map(async (file) => {
    const content = await readGoogleDriveTextDocument(accessToken, file.id!, file.mimeType!);
    return {
      id: file.id!,
      title: file.name!,
      modifiedAt: file.modifiedTime || "",
      mimeType: file.mimeType!,
      sourceUrl: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id!)}/view`,
      snippet: buildMeetingDriveSnippet(content, meeting),
    } satisfies MeetingDriveDocument;
  }))).filter((document) => Boolean(document.title));

  return {
    status: "ready",
    note: documents.length
      ? "Google Drive documents that look related to this meeting based on title, attendee names, and document text."
      : "No readable Google Drive transcript documents were returned for this meeting.",
    documents,
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
  snapshot.participantPreferences = null;
  resetCaptureHealth();
  resetTranslationHealth();
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
      participantPreferences: activeSessionParticipantPreferences,
    });
  }
  if (completedMeeting?.calendarProvider === "mock" && !completedMeeting.joinUrl) {
    calendarService.dismissMeeting(completedMeeting.id);
    meetingScheduler.setMeetings(calendarService.getUpcomingMeetings());
  }
  activeMeetingRecord = null;
  activeMeetingContext = null;
  activeSessionParticipantPreferences = null;
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

    if (event.kind === "translated_segment") {
      snapshot.transcript = snapshot.transcript.map((segment) => (
        segment.id === event.segmentId
          ? {
              ...segment,
              translatedText: event.translatedText,
              translatedLanguage: event.translatedLanguage,
            }
          : segment
      ));
      broadcastSnapshot();
      return;
    }

    if (event.kind === "translation_status") {
      updateTranslationHealth(event.status, event.detail);
      broadcastSnapshot();
      return;
    }

    if (event.kind === "participant_preferences_updated") {
      activeSessionParticipantPreferences = event.participantPreferences;
      snapshot.participantPreferences = event.participantPreferences;
      updateTranslationHealth(
        "active",
        `Live session preferences updated: host ${event.participantPreferences.host.language}, guest ${event.participantPreferences.guest.language}.`,
      );
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

async function startSession(
  meeting: MeetingRecord,
  meetingContext: MeetingContext | null,
  options: { openMeetingWindow?: boolean } = {},
): Promise<AppSnapshot> {
  if (snapshot.activeSession) {
    return broadcastSnapshot();
  }

  const { openMeetingWindow = true } = options;
  const launchContext = await readDesktopMeetingLaunchContext(meeting.id);
  const participantPreferences = normalizeSessionParticipantTranslationPreferences(launchContext?.participantPreferences);
  snapshot.pendingPopupMeeting = null;
  resetCaptureHealth();
  resetTranslationHealth();
  updateCaptureHealth("microphone", "starting", "Waiting for microphone permission.");
  updateCaptureHealth("system", "starting", "Waiting for system-audio permission.");
  if (getRuntimeCapabilitiesSnapshot().translationEnabled) {
    const capabilities = getRuntimeCapabilitiesSnapshot();
    updateTranslationHealth(
      capabilities.translationReady ? "starting" : "error",
      capabilities.translationReady
        ? `Preparing host ${participantPreferences.host.language} and guest ${participantPreferences.guest.language} language routing.`
        : "Translation is enabled, but AI or transcription keys are missing.",
    );
  }
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
  activeSessionParticipantPreferences = participantPreferences;
  snapshot.participantPreferences = participantPreferences;
  const transcriptionConfigured = getRuntimeCapabilitiesSnapshot().cloudTranscriptionConfigured;

  try {
    await syncDesktopRuntimeSecretsToRealtime();
  } catch (error) {
    console.warn("Failed to sync runtime secrets before session start.", error);
  }

  if (!transcriptionConfigured) {
    snapshot.coaching = [
      {
        id: randomUUID(),
        sessionId: snapshot.activeSession.id,
        severity: "warning",
        title: "Live transcription is disabled",
        message: "A transcription API key is not configured in Setup. Audio capture can still run, but no transcript will appear until that key is added for this user.",
        createdAt: new Date().toISOString(),
      },
    ];
  }

  if (openMeetingWindow && meeting.joinUrl) {
    if (meeting.launchStrategy === "browser") {
      createMeetingWindow(meeting);
    } else {
      await shell.openExternal(meeting.joinUrl);
    }
  }

  const client = attachRealtimeClient();
  try {
    await sendRealtimeSessionStart(meeting, meetingContext);
  } catch (error) {
    console.error("Failed to connect to realtime service", error);
    snapshot.coaching = [
      ...snapshot.coaching,
      {
        id: randomUUID(),
        sessionId: snapshot.activeSession.id,
        severity: "warning",
        title: "Live transcription connection failed",
        message: "Listen could not register this live session with the realtime service. Audio capture may run, but transcript segments will be missing until the connection is restored.",
        createdAt: new Date().toISOString(),
      },
    ];
    updateCaptureHealth("microphone", "error", "Realtime session registration failed.");
    updateCaptureHealth("system", "error", "Realtime session registration failed.");
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
  ipcMain.handle("auth:get-state", async (): Promise<AppAuthState> => appAuthService.getState());
  ipcMain.handle("auth:sign-in-google", async (): Promise<AppAuthState> => {
    await appAuthService.signInWithGoogle();
    const authState = await refreshDesktopAppAuthProfile();
    broadcastSnapshot();
    return authState;
  });
  ipcMain.handle("auth:send-magic-link", async (_event, email: string): Promise<AppAuthState> => {
    const authState = await appAuthService.sendMagicLink(email);
    broadcastSnapshot();
    return authState;
  });
  ipcMain.handle("auth:complete-email-sign-in", async (): Promise<AppAuthState> => {
    await appAuthService.completeEmailSignIn();
    const authState = await refreshDesktopAppAuthProfile();
    broadcastSnapshot();
    return authState;
  });
  ipcMain.handle("auth:sign-out", async (): Promise<AppAuthState> => {
    const authState = await appAuthService.signOut();
    broadcastSnapshot();
    return authState;
  });
  ipcMain.handle("admin-users:list", async (_event, organizationId?: string | null): Promise<AdminUserDirectory> => listDesktopAdminUsers(organizationId));
  ipcMain.handle("admin-organizations:list", async (): Promise<AdminOrganizationSummary[]> => listDesktopOrganizations());
  ipcMain.handle(
    "admin-organizations:create",
    async (_event, name: string, adminEmail: string, maxUsers?: number | null): Promise<AdminOrganizationSummary[]> =>
      createDesktopOrganization(name, adminEmail, maxUsers),
  );
  ipcMain.handle(
    "admin-organizations:update",
    async (_event, organizationId: string, updates: { status?: "active" | "disabled"; maxUsers?: number | null }): Promise<AdminOrganizationSummary[]> =>
      updateDesktopOrganization(organizationId, updates),
  );
  ipcMain.handle("admin-users:invite", async (_event, email: string, role: AdminManagedUser["role"], organizationId?: string | null): Promise<AdminUserDirectory> =>
    inviteDesktopAdminUser(email, role, organizationId),
  );
  ipcMain.handle(
    "admin-users:update-invitation",
    async (_event, invitationId: string, action: "resend" | "revoke", organizationId?: string | null): Promise<AdminUserDirectory> =>
      updateDesktopAdminInvitation(invitationId, action, organizationId),
  );
  ipcMain.handle(
    "admin-users:update",
    async (_event, profileId: string, updates: { role?: AdminManagedUser["role"]; status?: AdminManagedUser["status"] }, organizationId?: string | null): Promise<AdminUserDirectory> =>
      updateDesktopAdminUser(profileId, updates, organizationId),
  );
  ipcMain.handle("app:get-runtime-capabilities", async () => getRuntimeCapabilitiesSnapshot());
  ipcMain.handle("runtime-secrets:get", async () => readDesktopRuntimeSecrets());
  ipcMain.handle("runtime-secrets:save", async (_event, secrets: StoredRuntimeSecrets) => saveDesktopRuntimeSecrets(secrets));
  ipcMain.handle("translation-settings:get", async () => readDesktopTranslationRuntimeSettings());
  ipcMain.handle(
    "translation-settings:save",
    async (_event, settings: StoredTranslationRuntimeSettings) => saveDesktopTranslationRuntimeSettings(settings),
  );
  ipcMain.handle(
    "session:participant-preferences:save",
    async (_event, preferences: SessionParticipantTranslationPreferences) => saveLiveSessionParticipantPreferences(preferences),
  );
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
  ipcMain.handle("context:ask-question", async (_event, payload: ContextQuestionPayload) => askDesktopContextQuestion(payload));
  ipcMain.handle("session:list", async (_event, limit?: number) => listDesktopSessions(limit));
  ipcMain.handle("session:get", async (_event, sessionId: string) => readDesktopSessionDetail(sessionId));
  ipcMain.handle("session:delete", async (_event, sessionId: string) => deleteDesktopSession(sessionId));
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
  ipcMain.handle("meeting:drive-history", async (_event, meetingId: string) => readDesktopMeetingDriveHistory(meetingId));
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
  ipcMain.handle("meeting:auto-start", async (_event, meetingId: string | null, meetingContext: MeetingContext | null) => {
    const meeting = meetingId
      ? calendarService.getUpcomingMeetings().find((item) => item.id === meetingId) ?? calendarService.createInstantMeeting()
      : calendarService.createInstantMeeting();

    if (meetingContext) {
      await saveDesktopMeetingBrief(meeting.id, meetingContext);
    }

    return startSession(meeting, meetingContext, { openMeetingWindow: false });
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

    autoStopController.noteAudioActivity();
    noteCaptureChunk(source);
    if (snapshot.captureHealth[source].chunkCount % 10 === 9) {
      broadcastSnapshot();
    }

    const outboundEvent = {
      kind: "audio_chunk" as const,
      sessionId: snapshot.activeSession.id,
      source,
      sampleRate,
      payloadBase64,
      createdAt: new Date().toISOString(),
    };

    void (async () => {
      let sent = realtimeClient?.send(outboundEvent) ?? false;
      if (!sent) {
        try {
          await recoverRealtimeLiveSession();
          sent = realtimeClient?.send(outboundEvent) ?? false;
        } catch (error) {
          console.error("Failed to restore realtime live session.", error);
        }
      }

      if (!sent) {
        console.warn(`Dropped ${source} audio chunk because realtime socket is unavailable.`);
      }
    })();
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

  createTray();
  updateTrayMenu();

  mainWindow.on("close", (event) => {
    handleMainWindowClose(event);
  });

  mainWindow.on("show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.setSkipTaskbar(false);
    updateTrayMenu();
  });

  mainWindow.on("hide", () => {
    updateTrayMenu();
  });

  mainWindow.on("closed", () => {
    if (mainWindow?.isDestroyed()) {
      mainWindow = null;
    }
    updateTrayMenu();
  });

  if (!rendererEntry) {
    throw new Error("Unable to resolve renderer entry HTML.");
  }

  mainWindow.loadFile(rendererEntry);
}

app.whenReady().then(async () => {
  configureSessionPermissions();
  const databasePath = resolveDesktopDatabasePath();
  migrateLegacyOrgContextDocuments(databasePath);
  sessionStore = new SessionStore(databasePath);
  await ensureRealtimeServiceAvailable(databasePath);
  const calendarSyncClient = new CalendarSyncClient(realtimeHttpUrl);
  const meetingResearchClient = new MeetingResearchClient(realtimeHttpUrl);
  calendarService = new CalendarService(
    sessionStore,
    shell.openExternal,
    calendarSyncClient.syncMeetings.bind(calendarSyncClient),
    meetingResearchClient.listMeetingResearch.bind(meetingResearchClient),
  );
  appAuthService = new DesktopSupabaseAuthService(sessionStore, shell.openExternal);
  const persisted = await calendarService.initialize();
  snapshot.lastSummary = persisted.lastSummary;
  snapshot.appAuth = await appAuthService.initialize();
  if (snapshot.appAuth.signedIn) {
    try {
      snapshot.appAuth = await refreshDesktopAppAuthProfile();
    } catch (error) {
      console.warn("Failed to hydrate desktop app auth profile during startup.", error);
    }
  }
  desktopCloseBehavior = await sessionStore.readDesktopCloseBehavior();
  desktopRuntimeSecrets = await sessionStore.readRuntimeSecrets();
  desktopTranslationRuntimeSettings = await readDesktopTranslationRuntimeSettings();

  try {
    await syncDesktopRuntimeSecretsToRealtime();
  } catch (error) {
    console.warn("Failed to sync runtime secrets during desktop startup.", error);
  }

  try {
    await syncDesktopTranslationSettingsToRealtime();
  } catch (error) {
    console.warn("Failed to sync translation settings during desktop startup.", error);
  }

  registerHandlers();

  meetingScheduler.on("popup", (meeting: MeetingRecord) => {
    snapshot.pendingPopupMeeting = meeting;
    broadcastSnapshot();
  });

  autoStopController.on("stopRequested", (_sessionId: string, reason: SessionStopReason) => {
    void (async () => {
      const shouldStop = await confirmAutomaticSessionEnd(reason);
      if (!shouldStop) {
        autoStopController.dismissPendingStop();
        return;
      }

      await stopSession(reason);
    })();
  });

  await refreshCalendars();
  createControlWindow();
  configureAutoUpdater();
  broadcastSnapshot();
  broadcastUpdaterState();
});

app.on("before-quit", (event) => {
  if (snapshot.activeSession && !pendingQuitAfterSessionFinalize) {
    event.preventDefault();
    pendingQuitAfterSessionFinalize = true;
    isQuitting = true;
    void stopSession("manual").finally(() => {
      app.quit();
    });
    return;
  }

  isQuitting = true;
  if (updaterStartupCheckTimeout) {
    clearTimeout(updaterStartupCheckTimeout);
    updaterStartupCheckTimeout = null;
  }
  if (updaterPeriodicCheckInterval) {
    clearInterval(updaterPeriodicCheckInterval);
    updaterPeriodicCheckInterval = null;
  }
  if (embeddedRealtimeProcess) {
    embeddedRealtimeStopRequested = true;
    embeddedRealtimeProcess.kill();
  }
  embeddedRealtimeProcess = null;
  pendingQuitAfterSessionFinalize = false;
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createControlWindow();
    return;
  }

  showMainWindow();
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) {
      createControlWindow();
    }
    return;
  }

  showMainWindow();
});

app.on("window-all-closed", () => {
  closeMeetingWindow();
  if (process.platform !== "darwin" && isQuitting) {
    app.quit();
  }
});
