import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CoachingPrompt,
  MeetingContext,
  MeetingRecord,
  SessionHistoryDetail,
  SessionHistoryItem,
  SessionStopReason,
  SessionSummary,
  TranscriptSegment,
} from "@listen/shared";

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
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as T;
}

export interface StoredOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accountLabel?: string;
}

export interface PersistedState {
  lastSummary: SessionSummary | null;
  auth: {
    google: StoredOAuthToken | null;
    microsoft: StoredOAuthToken | null;
  };
}

export interface CompletedSessionRecord {
  meeting: MeetingRecord;
  startedAt: string;
  expectedEndAt: string;
  stopReason: SessionStopReason;
  summary: SessionSummary;
  transcript: TranscriptSegment[];
  coaching: CoachingPrompt[];
  context: MeetingContext | null;
}

export interface StoredMeetingLaunchContext {
  cacheKey: string;
  context: MeetingContext;
}

export interface StoredRuntimeSecrets {
  aiApiKey: string;
  transcriptionApiKey: string;
}

export type DesktopCloseBehavior = "ask" | "tray" | "quit";

export class SessionStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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
        context_json TEXT
      );

      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        speaker_id INTEGER,
        speaker_label TEXT,
        text TEXT NOT NULL,
        is_final INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS coaching_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        speaker_id INTEGER,
        speaker_label TEXT,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);

    this.ensureColumn("transcript_segments", "speaker_id", "INTEGER");
    this.ensureColumn("transcript_segments", "speaker_label", "TEXT");
    this.ensureColumn("coaching_prompts", "speaker_id", "INTEGER");
    this.ensureColumn("coaching_prompts", "speaker_label", "TEXT");
  }

  async read(): Promise<PersistedState> {
    const lastSummary = this.readSetting<SessionSummary>("last_summary");
    const google = this.readSetting<StoredOAuthToken>("auth_google");
    const microsoft = this.readSetting<StoredOAuthToken>("auth_microsoft");

    return {
      lastSummary,
      auth: {
        google,
        microsoft,
      },
    };
  }

  async writeLastSummary(summary: SessionSummary): Promise<void> {
    this.writeSetting("last_summary", summary);
  }

  async writeAuthToken(provider: "google" | "microsoft", token: StoredOAuthToken | null): Promise<void> {
    this.writeSetting(`auth_${provider}`, token);
  }

  async readMeetingContext(meetingId: string): Promise<MeetingContext | null> {
    return this.readSetting<MeetingContext>(`meeting_context:${meetingId}`);
  }

  async writeMeetingContext(meetingId: string, context: MeetingContext): Promise<void> {
    this.writeSetting(`meeting_context:${meetingId}`, context);
  }

  async readMeetingLaunchContext(meetingId: string): Promise<StoredMeetingLaunchContext | null> {
    return this.readSetting<StoredMeetingLaunchContext>(`meeting_launch_context:${meetingId}`);
  }

  async writeMeetingLaunchContext(meetingId: string, payload: StoredMeetingLaunchContext): Promise<void> {
    this.writeSetting(`meeting_launch_context:${meetingId}`, payload);
  }

  async readRuntimeSecrets(): Promise<StoredRuntimeSecrets> {
    const value = this.readSetting<StoredRuntimeSecrets>("runtime_secrets");
    return {
      aiApiKey: typeof value?.aiApiKey === "string" ? value.aiApiKey : "",
      transcriptionApiKey: typeof value?.transcriptionApiKey === "string" ? value.transcriptionApiKey : "",
    };
  }

  async writeRuntimeSecrets(value: StoredRuntimeSecrets): Promise<void> {
    this.writeSetting("runtime_secrets", {
      aiApiKey: value.aiApiKey,
      transcriptionApiKey: value.transcriptionApiKey,
    });
  }

  async readDesktopCloseBehavior(): Promise<DesktopCloseBehavior> {
    const value = this.readSetting<DesktopCloseBehavior>("desktop_close_behavior");
    return value === "tray" || value === "quit" ? value : "ask";
  }

  async writeDesktopCloseBehavior(value: DesktopCloseBehavior): Promise<void> {
    this.writeSetting("desktop_close_behavior", value);
  }

  async writeCompletedSession(record: CompletedSessionRecord): Promise<void> {
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
              context_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              context_json = excluded.context_json
          `,
        )
        .run(
          record.summary.sessionId,
          record.meeting.id,
          record.meeting.title,
          record.meeting.provider,
          record.meeting.calendarProvider,
          record.startedAt,
          record.expectedEndAt,
          record.summary.completedAt,
          record.stopReason,
          JSON.stringify(record.summary),
          JSON.stringify(record.context),
        );

      this.database.prepare("DELETE FROM transcript_segments WHERE session_id = ?").run(record.summary.sessionId);
      this.database.prepare("DELETE FROM coaching_prompts WHERE session_id = ?").run(record.summary.sessionId);

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

      this.writeSetting("last_summary", record.summary);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listSessions(limit = 50): Promise<SessionHistoryItem[]> {
    const rows = this.database
      .prepare(
        `
          SELECT session_id, meeting_id, meeting_title, meeting_provider, calendar_provider, started_at, expected_end_at, completed_at, stop_reason, summary_json, context_json
          FROM sessions
          ORDER BY completed_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as unknown as SessionRow[];

    return rows.map((row) => this.mapSessionRow(row));
  }

  async getSession(sessionId: string): Promise<SessionHistoryDetail | null> {
    const row = this.database
      .prepare(
        `
          SELECT session_id, meeting_id, meeting_title, meeting_provider, calendar_provider, started_at, expected_end_at, completed_at, stop_reason, summary_json, context_json
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

  async deleteSession(sessionId: string): Promise<boolean> {
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

  private readSetting<T>(key: string): T | null {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) {
      return null;
    }

    return JSON.parse(row.value) as T;
  }

  private writeSetting(key: string, value: unknown): void {
    this.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      JSON.stringify(value),
    );
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const existingColumns = this.database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (existingColumns.some((column) => column.name === columnName)) {
      return;
    }

    this.database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
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
      context: parseJson<MeetingContext>(row.context_json),
    };
  }
}
