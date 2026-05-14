import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CoachingProfile,
  CoachingPrompt,
  CoachingSettings,
  MeetingContext,
  MeetingContextTemplate,
  OrgContextDocument,
  SessionHistoryDetail,
  SessionHistoryItem,
  SessionParticipantTranslationPreferences,
  SessionStopReason,
  SessionSummary,
  TranscriptSegment,
} from "@listen/shared";

const DEFAULT_COACHING_SETTINGS: CoachingSettings = {
  style: "supportive",
  directness: "balanced",
  frequency: "balanced",
};

function normalizeCoachingSettings(value: unknown): CoachingSettings {
  const candidate = (value ?? {}) as Partial<CoachingSettings>;
  return {
    style: candidate.style === "direct" || candidate.style === "challenger" ? candidate.style : DEFAULT_COACHING_SETTINGS.style,
    directness: candidate.directness === "gentle" || candidate.directness === "blunt" ? candidate.directness : DEFAULT_COACHING_SETTINGS.directness,
    frequency: candidate.frequency === "minimal" || candidate.frequency === "proactive" ? candidate.frequency : DEFAULT_COACHING_SETTINGS.frequency,
  };
}

interface SessionRow {
  session_id: string;
  meeting_id: string;
  meeting_title: string;
  meeting_provider: SessionHistoryItem["meetingProvider"];
  calendar_provider: SessionHistoryItem["calendarProvider"];
  started_at: string;
  expected_end_at: string;
  completed_at: string;
  stop_reason: SessionHistoryItem["stopReason"];
  summary_json: string;
  context_json: string | null;
  participant_preferences_json: string | null;
}

interface CompletedSessionRecord {
  sessionId: string;
  meetingId: string;
  meetingTitle: string;
  meetingProvider: SessionHistoryItem["meetingProvider"];
  calendarProvider: SessionHistoryItem["calendarProvider"];
  startedAt: string;
  expectedEndAt: string;
  completedAt: string;
  stopReason: SessionStopReason;
  summary: SessionSummary;
  transcript: TranscriptSegment[];
  coaching: CoachingPrompt[];
  context: MeetingContext | null;
  participantPreferences: SessionParticipantTranslationPreferences | null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as T;
}

export class HistoryStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        meeting_title TEXT NOT NULL,
        meeting_provider TEXT NOT NULL,
        calendar_provider TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expected_end_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        stop_reason TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        context_json TEXT,
        participant_preferences_json TEXT
      );

      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        speaker_id INTEGER,
        speaker_label TEXT,
        text TEXT NOT NULL,
        is_final INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coaching_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        speaker_id INTEGER,
        speaker_label TEXT,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coaching_profiles (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        label TEXT NOT NULL,
        guidance TEXT NOT NULL,
        settings_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meeting_templates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        context_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_context_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_url TEXT,
        source_name TEXT,
        mime_type TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    this.ensureColumn("transcript_segments", "speaker_id", "INTEGER");
    this.ensureColumn("transcript_segments", "speaker_label", "TEXT");
    this.ensureColumn("coaching_prompts", "speaker_id", "INTEGER");
    this.ensureColumn("coaching_prompts", "speaker_label", "TEXT");
    this.ensureColumn("sessions", "participant_preferences_json", "TEXT");
    this.ensureColumn("coaching_profiles", "settings_json", "TEXT");
    this.ensureColumn("org_context_documents", "source_url", "TEXT");
    this.seedDefaults();
  }

  readRuntimeSecrets(): { aiApiKey: string | null; deepgramApiKey: string | null } {
    return {
      aiApiKey: this.readRuntimeSetting("ai_api_key"),
      deepgramApiKey: this.readRuntimeSetting("deepgram_api_key"),
    };
  }

  writeRuntimeSecrets(value: { aiApiKey: string | null; deepgramApiKey: string | null }): { aiApiKey: string | null; deepgramApiKey: string | null } {
    this.writeRuntimeSetting("ai_api_key", value.aiApiKey);
    this.writeRuntimeSetting("deepgram_api_key", value.deepgramApiKey);
    return this.readRuntimeSecrets();
  }

  readRuntimeTranslationSettings(): {
    enabled: boolean;
    hostLanguage: string | null;
    guestLanguage: string | null;
    hostVoiceEnabled: boolean;
    guestVoiceEnabled: boolean;
    hostVoiceName: string | null;
    guestVoiceName: string | null;
    transcriptionFlushMs: number | null;
    transcriptionFlushBytes: number | null;
  } {
    const flushMs = this.readRuntimeSetting("translation_transcription_flush_ms");
    const flushBytes = this.readRuntimeSetting("translation_transcription_flush_bytes");

    return {
      enabled: this.readRuntimeSetting("translation_enabled") === "true",
      hostLanguage: this.readRuntimeSetting("translation_host_language") || this.readRuntimeSetting("translation_source_language"),
      guestLanguage: this.readRuntimeSetting("translation_guest_language") || this.readRuntimeSetting("translation_target_language"),
      hostVoiceEnabled: this.readRuntimeSetting("translation_host_voice_enabled") === "true",
      guestVoiceEnabled: this.readRuntimeSetting("translation_guest_voice_enabled") === "true",
      hostVoiceName: this.readRuntimeSetting("translation_host_voice_name"),
      guestVoiceName: this.readRuntimeSetting("translation_guest_voice_name"),
      transcriptionFlushMs: flushMs && /^\d+$/.test(flushMs) ? Number(flushMs) : null,
      transcriptionFlushBytes: flushBytes && /^\d+$/.test(flushBytes) ? Number(flushBytes) : null,
    };
  }

  writeRuntimeTranslationSettings(value: {
    enabled: boolean;
    hostLanguage: string | null;
    guestLanguage: string | null;
    hostVoiceEnabled: boolean;
    guestVoiceEnabled: boolean;
    hostVoiceName: string | null;
    guestVoiceName: string | null;
    transcriptionFlushMs: number | null;
    transcriptionFlushBytes: number | null;
  }): {
    enabled: boolean;
    hostLanguage: string | null;
    guestLanguage: string | null;
    hostVoiceEnabled: boolean;
    guestVoiceEnabled: boolean;
    hostVoiceName: string | null;
    guestVoiceName: string | null;
    transcriptionFlushMs: number | null;
    transcriptionFlushBytes: number | null;
  } {
    this.writeRuntimeSetting("translation_enabled", value.enabled ? "true" : "false");
    this.writeRuntimeSetting("translation_host_language", value.hostLanguage);
    this.writeRuntimeSetting("translation_guest_language", value.guestLanguage);
    this.writeRuntimeSetting("translation_host_voice_enabled", value.hostVoiceEnabled ? "true" : "false");
    this.writeRuntimeSetting("translation_guest_voice_enabled", value.guestVoiceEnabled ? "true" : "false");
    this.writeRuntimeSetting("translation_host_voice_name", value.hostVoiceName);
    this.writeRuntimeSetting("translation_guest_voice_name", value.guestVoiceName);
    this.writeRuntimeSetting(
      "translation_transcription_flush_ms",
      typeof value.transcriptionFlushMs === "number" && Number.isFinite(value.transcriptionFlushMs) ? String(Math.max(1, Math.floor(value.transcriptionFlushMs))) : null,
    );
    this.writeRuntimeSetting(
      "translation_transcription_flush_bytes",
      typeof value.transcriptionFlushBytes === "number" && Number.isFinite(value.transcriptionFlushBytes) ? String(Math.max(1, Math.floor(value.transcriptionFlushBytes))) : null,
    );
    return this.readRuntimeTranslationSettings();
  }

  listSessions(limit = 50): SessionHistoryItem[] {
    const rows = this.database
      .prepare(
        `
          SELECT session_id, meeting_id, meeting_title, meeting_provider, calendar_provider, started_at, expected_end_at, completed_at, stop_reason, summary_json, context_json, participant_preferences_json
          FROM sessions
          ORDER BY completed_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as unknown as SessionRow[];

    return rows.map((row) => this.mapSessionRow(row));
  }

  getSession(sessionId: string): SessionHistoryDetail | null {
    const row = this.database
      .prepare(
        `
          SELECT session_id, meeting_id, meeting_title, meeting_provider, calendar_provider, started_at, expected_end_at, completed_at, stop_reason, summary_json, context_json, participant_preferences_json
          FROM sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      return null;
    }

    const session = this.mapSessionRow(row);
    const transcript = this.database
      .prepare(
        `
          SELECT id, session_id as sessionId, source, speaker_id as speakerId, speaker_label as speakerLabel, text, is_final as isFinal, created_at as createdAt
          FROM transcript_segments
          WHERE session_id = ?
          ORDER BY created_at ASC
        `,
      )
      .all(sessionId)
      .map((segment) => ({
        ...segment,
        isFinal: Boolean((segment as { isFinal: number }).isFinal),
      })) as SessionHistoryDetail["transcript"];

    const coaching = this.database
      .prepare(
        `
          SELECT id, session_id as sessionId, speaker_id as speakerId, speaker_label as speakerLabel, severity, title, message, created_at as createdAt
          FROM coaching_prompts
          WHERE session_id = ?
          ORDER BY created_at DESC
        `,
      )
      .all(sessionId) as unknown as SessionHistoryDetail["coaching"];

    return {
      ...session,
      transcript,
      coaching,
    };
  }

  deleteSession(sessionId: string): boolean {
    const existing = this.database
      .prepare(
        `
          SELECT session_id
          FROM sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as { session_id: string } | undefined;
    if (!existing) {
      return false;
    }

    this.database.prepare("DELETE FROM transcript_segments WHERE session_id = ?").run(sessionId);
    this.database.prepare("DELETE FROM coaching_prompts WHERE session_id = ?").run(sessionId);
    this.database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    return true;
  }

  writeCompletedSession(record: CompletedSessionRecord): void {
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `
            INSERT INTO sessions (
              session_id,
              meeting_id,
              meeting_title,
              meeting_provider,
              calendar_provider,
              started_at,
              expected_end_at,
              completed_at,
              stop_reason,
              summary_json,
              context_json,
              participant_preferences_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              meeting_id = excluded.meeting_id,
              meeting_title = excluded.meeting_title,
              meeting_provider = excluded.meeting_provider,
              calendar_provider = excluded.calendar_provider,
              started_at = excluded.started_at,
              expected_end_at = excluded.expected_end_at,
              completed_at = excluded.completed_at,
              stop_reason = excluded.stop_reason,
              summary_json = excluded.summary_json,
              context_json = excluded.context_json,
              participant_preferences_json = excluded.participant_preferences_json
          `,
        )
        .run(
          record.sessionId,
          record.meetingId,
          record.meetingTitle,
          record.meetingProvider,
          record.calendarProvider,
          record.startedAt,
          record.expectedEndAt,
          record.completedAt,
          record.stopReason,
          JSON.stringify(record.summary),
          JSON.stringify(record.context),
          JSON.stringify(record.participantPreferences),
        );

      this.database.prepare("DELETE FROM transcript_segments WHERE session_id = ?").run(record.sessionId);
      this.database.prepare("DELETE FROM coaching_prompts WHERE session_id = ?").run(record.sessionId);

      const transcriptStatement = this.database.prepare(
        `
          INSERT INTO transcript_segments (id, session_id, source, speaker_id, speaker_label, text, is_final, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const segment of record.transcript) {
        transcriptStatement.run(
          segment.id,
          segment.sessionId,
          segment.source,
          segment.speakerId ?? null,
          segment.speakerLabel ?? null,
          segment.text,
          segment.isFinal ? 1 : 0,
          segment.createdAt,
        );
      }

      const coachingStatement = this.database.prepare(
        `
          INSERT INTO coaching_prompts (id, session_id, speaker_id, speaker_label, severity, title, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const prompt of record.coaching) {
        coachingStatement.run(
          prompt.id,
          prompt.sessionId,
          prompt.speakerId ?? null,
          prompt.speakerLabel ?? null,
          prompt.severity,
          prompt.title,
          prompt.message,
          prompt.createdAt,
        );
      }

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listCoachingProfiles(): CoachingProfile[] {
    return this.database
      .prepare(
        `
          SELECT id, scope, scope_id as scopeId, label, guidance, settings_json, updated_at as updatedAt
          FROM coaching_profiles
          ORDER BY scope ASC, label ASC
        `,
      )
      .all()
      .map((row) => ({
        id: (row as { id: string }).id,
        scope: (row as { scope: CoachingProfile["scope"] }).scope,
        scopeId: (row as { scopeId: string }).scopeId,
        label: (row as { label: string }).label,
        guidance: (row as { guidance: string }).guidance,
        settings: normalizeCoachingSettings(parseJson((row as { settings_json?: string | null }).settings_json ?? null)),
        updatedAt: (row as { updatedAt: string }).updatedAt,
      }));
  }

  upsertCoachingProfile(profile: CoachingProfile): CoachingProfile {
    const settings = normalizeCoachingSettings(profile.settings);
    this.database
      .prepare(
        `
          INSERT INTO coaching_profiles (id, scope, scope_id, label, guidance, settings_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            scope = excluded.scope,
            scope_id = excluded.scope_id,
            label = excluded.label,
            guidance = excluded.guidance,
            settings_json = excluded.settings_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(profile.id, profile.scope, profile.scopeId, profile.label, profile.guidance, JSON.stringify(settings), profile.updatedAt);
    return { ...profile, settings };
  }

  listMeetingTemplates(): MeetingContextTemplate[] {
    return this.database
      .prepare(
        `
          SELECT id, title, context_json, updated_at as updatedAt
          FROM meeting_templates
          ORDER BY updated_at DESC, title ASC
        `,
      )
      .all()
      .map((row) => ({
        id: (row as { id: string }).id,
        title: (row as { title: string }).title,
        context: JSON.parse((row as { context_json: string }).context_json) as MeetingContextTemplate["context"],
        updatedAt: (row as { updatedAt: string }).updatedAt,
      }));
  }

  upsertMeetingTemplate(template: MeetingContextTemplate): MeetingContextTemplate {
    this.database
      .prepare(
        `
          INSERT INTO meeting_templates (id, title, context_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            context_json = excluded.context_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(template.id, template.title, JSON.stringify(template.context), template.updatedAt);
    return template;
  }

  deleteMeetingTemplate(templateId: string): void {
    this.database
      .prepare(
        `
          DELETE FROM meeting_templates
          WHERE id = ?
        `,
      )
      .run(templateId);
  }

  listOrgContextDocuments(): OrgContextDocument[] {
    return this.database
      .prepare(
        `
          SELECT id, title, content, source_url as sourceUrl, source_name as sourceName, mime_type as mimeType, updated_at as updatedAt
          FROM org_context_documents
          ORDER BY updated_at DESC, title ASC
        `,
      )
      .all() as unknown as OrgContextDocument[];
  }

  upsertOrgContextDocument(document: OrgContextDocument): OrgContextDocument {
    this.database
      .prepare(
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
      )
      .run(document.id, document.title, document.content, document.sourceUrl ?? null, document.sourceName ?? null, document.mimeType ?? null, document.updatedAt);
    return document;
  }

  deleteOrgContextDocument(documentId: string): void {
    this.database.prepare("DELETE FROM org_context_documents WHERE id = ?").run(documentId);
  }

  getCoachingGuidance(userScopeId = "self"): { orgGuidance: string | null; userGuidance: string | null; settings: CoachingSettings } {
    const profiles = this.listCoachingProfiles();
    const documents = this.listOrgContextDocuments();
    const orgProfile = profiles.find((profile) => profile.scope === "org");
    const userProfile = profiles.find((profile) => profile.scope === "user" && profile.scopeId === userScopeId);
    const orgGuidance = orgProfile?.guidance ?? null;
    const documentGuidance = documents.length
      ? documents
          .map((document) => `${document.title}: ${document.content}`.trim())
          .join("\n\n")
      : null;

    return {
      orgGuidance: [orgGuidance, documentGuidance].filter(Boolean).join("\n\n") || null,
      userGuidance: userProfile?.guidance ?? null,
      settings: {
        style: userProfile?.settings?.style ?? orgProfile?.settings?.style ?? DEFAULT_COACHING_SETTINGS.style,
        directness: userProfile?.settings?.directness ?? orgProfile?.settings?.directness ?? DEFAULT_COACHING_SETTINGS.directness,
        frequency: userProfile?.settings?.frequency ?? orgProfile?.settings?.frequency ?? DEFAULT_COACHING_SETTINGS.frequency,
      },
    };
  }

  private mapSessionRow(row: SessionRow): SessionHistoryItem {
    return {
      sessionId: row.session_id,
      meetingId: row.meeting_id,
      meetingTitle: row.meeting_title,
      meetingProvider: row.meeting_provider,
      calendarProvider: row.calendar_provider,
      startedAt: row.started_at,
      expectedEndAt: row.expected_end_at,
      completedAt: row.completed_at,
      stopReason: row.stop_reason,
      summary: JSON.parse(row.summary_json) as SessionSummary,
      context: parseJson(row.context_json),
      participantPreferences: parseJson<SessionParticipantTranslationPreferences>(row.participant_preferences_json),
    };
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const existingColumns = this.database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (existingColumns.some((column) => column.name === columnName)) {
      return;
    }

    this.database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }

  private readRuntimeSetting(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM runtime_settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    if (!row || typeof row.value !== "string") {
      return null;
    }

    const normalized = row.value.trim();
    return normalized || null;
  }

  private writeRuntimeSetting(key: string, value: string | null): void {
    this.database.prepare(
      "INSERT INTO runtime_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value?.trim() || null);
  }

  private seedDefaults(): void {
    if (!this.listCoachingProfiles().length) {
      const now = new Date().toISOString();
      this.upsertCoachingProfile({
        id: "org:default",
        scope: "org",
        scopeId: "default",
        label: "Default org guidance",
        guidance: "Be accurate, concise, and end each important exchange with a clear next step or decision.",
        settings: DEFAULT_COACHING_SETTINGS,
        updatedAt: now,
      });
      this.upsertCoachingProfile({
        id: "user:self",
        scope: "user",
        scopeId: "self",
        label: "Default personal focus",
        guidance: "Favor crisp answers, avoid filler, and confirm the next step before the meeting closes.",
        settings: DEFAULT_COACHING_SETTINGS,
        updatedAt: now,
      });
    }

    if (!this.listMeetingTemplates().length) {
      const now = new Date().toISOString();
      this.upsertMeetingTemplate({
        id: "template:sales-discovery",
        title: "Sales discovery",
        context: {
          callFunction: "sales",
          callType: "discovery call",
          callGoal: "book discovery",
          userRole: "AE",
          guestRole: "prospect",
          desiredOutcome: "Leave with a scheduled next step.",
          notes: "Confirm pain, process, timing, and the next meeting.",
        },
        updatedAt: now,
      });
      this.upsertMeetingTemplate({
        id: "template:recruiting-screen",
        title: "Recruiting screen",
        context: {
          callFunction: "recruiting",
          callType: "recruiter screen",
          callGoal: "evaluate candidate",
          userRole: "recruiter",
          guestRole: "candidate",
          desiredOutcome: "Decide whether to move the candidate forward.",
          notes: "Test for signal, motivation, and role fit with specific examples.",
        },
        updatedAt: now,
      });
    }
  }
}