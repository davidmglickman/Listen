import { randomUUID } from "node:crypto";

import type { CalendarConnection, CalendarProvider, MeetingResearchBrief, MeetingRecord } from "@listen/shared";

import { GoogleOAuthClient } from "../auth/googleOAuth";
import { MicrosoftOAuthClient } from "../auth/microsoftOAuth";
import { awaitOAuthCode } from "../auth/oauthCallbackServer";
import { SessionStore, type PersistedState, type StoredOAuthToken } from "../storage/sessionStore";
import { GoogleCalendarProvider } from "./googleCalendar";
import { parseMeetingLink } from "./meetingLinkParser";
import { MicrosoftCalendarProvider } from "./microsoftCalendar";

const OAUTH_PORT = Number(process.env.LISTEN_OAUTH_PORT ?? 42813);
const OAUTH_TIMEOUT_MS = 120_000;

interface AuthState {
  google: StoredOAuthToken | null;
  microsoft: StoredOAuthToken | null;
}

export class CalendarService {
  private readonly googleProvider = new GoogleCalendarProvider();
  private readonly microsoftProvider = new MicrosoftCalendarProvider();
  private readonly googleOAuthClient = new GoogleOAuthClient();
  private readonly microsoftOAuthClient = new MicrosoftOAuthClient();
  private readonly mockMeetings: MeetingRecord[] = [];

  private providerMeetings: MeetingRecord[] = [];
  private auth: AuthState = {
    google: null,
    microsoft: null,
  };
  private connections: CalendarConnection[] = [];

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly syncMeetings?: (meetings: MeetingRecord[]) => Promise<void>,
    private readonly loadMeetingResearch?: () => Promise<MeetingResearchBrief[]>,
  ) {
    this.connections = this.buildConnections();
  }

  async initialize(): Promise<PersistedState> {
    const persisted = await this.sessionStore.read();
    this.auth = persisted.auth;
    this.connections = this.buildConnections();
    return persisted;
  }

  getConnections(): CalendarConnection[] {
    return [...this.connections];
  }

  getUpcomingMeetings(): MeetingRecord[] {
    return [...this.providerMeetings, ...this.mockMeetings].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  }

  async getAccessToken(provider: "google" | "microsoft"): Promise<string | null> {
    const token = await this.ensureActiveToken(provider);
    return token?.accessToken ?? null;
  }

  async connect(provider: "google" | "microsoft"): Promise<void> {
    if (provider === "google") {
      if (!this.googleOAuthClient.isConfigured()) {
        throw new Error("Google OAuth is not configured.");
      }

      const request = this.googleOAuthClient.createAuthorizationRequest(OAUTH_PORT);
      const callbackPromise = awaitOAuthCode(OAUTH_PORT, "/oauth/google/callback", OAUTH_TIMEOUT_MS);
      await this.openExternal(request.url);
      const response = await callbackPromise;
      if (response.state !== request.state) {
        throw new Error("Google OAuth state mismatch.");
      }

      this.auth.google = await this.googleOAuthClient.exchangeCode(response.code, OAUTH_PORT);
      await this.sessionStore.writeAuthToken("google", this.auth.google);
      this.connections = this.buildConnections();
      return;
    }

    if (!this.microsoftOAuthClient.isConfigured()) {
      throw new Error("Microsoft OAuth is not configured.");
    }

    const request = this.microsoftOAuthClient.createAuthorizationRequest(OAUTH_PORT);
    const callbackPromise = awaitOAuthCode(OAUTH_PORT, "/oauth/microsoft/callback", OAUTH_TIMEOUT_MS);
    await this.openExternal(request.url);
    const response = await callbackPromise;
    if (response.state !== request.state) {
      throw new Error("Microsoft OAuth state mismatch.");
    }

    this.auth.microsoft = await this.microsoftOAuthClient.exchangeCode(response.code, OAUTH_PORT);
    await this.sessionStore.writeAuthToken("microsoft", this.auth.microsoft);
    this.connections = this.buildConnections();
  }

  async disconnect(provider: "google" | "microsoft"): Promise<void> {
    this.auth[provider] = null;
    await this.sessionStore.writeAuthToken(provider, null);
    this.providerMeetings = this.providerMeetings.filter((meeting) => meeting.calendarProvider !== provider);
    this.connections = this.buildConnections();
  }

  async refreshUpcomingMeetings(): Promise<MeetingRecord[]> {
    const googleMeetings = await this.fetchProviderMeetings("google");
    const microsoftMeetings = await this.fetchProviderMeetings("microsoft");
    this.providerMeetings = [...googleMeetings, ...microsoftMeetings];
    if (this.syncMeetings) {
      try {
        await this.syncMeetings(this.providerMeetings);
      } catch (error) {
        console.error("Supabase calendar sync failed", error);
      }
    }
    if (this.loadMeetingResearch) {
      try {
        const researchByExternalId = new Map((await this.loadMeetingResearch()).map((item) => [item.meetingExternalId, item]));
        this.providerMeetings = this.providerMeetings.map((meeting) => ({
          ...meeting,
          research: meeting.externalId ? researchByExternalId.get(meeting.externalId) : undefined,
        }));
      } catch (error) {
        console.error("Supabase meeting research lookup failed", error);
      }
    }
    this.connections = this.buildConnections();
    return this.getUpcomingMeetings();
  }

  createMockMeeting(): MeetingRecord {
    const startsAt = new Date(Date.now() + 2 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const joinUrl = "https://example.com/?listen-mock-meeting=1";
    const parsed = parseMeetingLink(joinUrl);

    const meeting: MeetingRecord = {
      id: randomUUID(),
      title: "Mock customer sync",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      joinUrl,
      provider: parsed.provider,
      calendarProvider: "mock",
      launchStrategy: parsed.launchStrategy,
      notes: "Local development meeting used to test popup, launch, and session flow. This is not a real meeting link.",
    };

    this.mockMeetings.push(meeting);
    return meeting;
  }

  createInstantMeeting(): MeetingRecord {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

    const meeting: MeetingRecord = {
      id: randomUUID(),
      title: "Instant meeting",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      joinUrl: "",
      provider: "generic",
      calendarProvider: "mock",
      launchStrategy: "browser",
      notes: "Auto-created by Listen from sustained microphone activity when no scheduled meeting was available.",
    };

    this.mockMeetings.push(meeting);
    return meeting;
  }

  dismissMeeting(meetingId: string): void {
    const mockIndex = this.mockMeetings.findIndex((meeting) => meeting.id === meetingId);
    if (mockIndex >= 0) {
      this.mockMeetings.splice(mockIndex, 1);
      return;
    }

    const providerIndex = this.providerMeetings.findIndex((meeting) => meeting.id === meetingId);
    if (providerIndex >= 0) {
      this.providerMeetings.splice(providerIndex, 1);
    }
  }

  private buildConnections(): CalendarConnection[] {
    return [
      this.googleProvider.getConnection(this.auth.google),
      this.microsoftProvider.getConnection(this.auth.microsoft),
      {
        provider: "mock",
        connected: true,
        accountLabel: "Local development feed",
      },
    ];
  }

  private async fetchProviderMeetings(provider: "google" | "microsoft"): Promise<MeetingRecord[]> {
    const token = await this.ensureActiveToken(provider);
    if (!token) {
      return [];
    }

    try {
      return provider === "google"
        ? await this.googleProvider.getUpcomingMeetings(token.accessToken)
        : await this.microsoftProvider.getUpcomingMeetings(token.accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.connections = [
        provider === "google" ? this.googleProvider.getConnection(this.auth.google, `Google sync failed (${message})`) : this.googleProvider.getConnection(this.auth.google),
        provider === "microsoft" ? this.microsoftProvider.getConnection(this.auth.microsoft, `Microsoft sync failed (${message})`) : this.microsoftProvider.getConnection(this.auth.microsoft),
        {
          provider: "mock",
          connected: true,
          accountLabel: "Local development feed",
        },
      ];
      return [];
    }
  }

  private async ensureActiveToken(provider: "google" | "microsoft"): Promise<StoredOAuthToken | null> {
    const token = this.auth[provider];
    if (!token) {
      return null;
    }

    const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) {
      return token;
    }

    if (!token.refreshToken) {
      return token;
    }

    const refreshed = provider === "google"
      ? await this.googleOAuthClient.refreshAccessToken(token.refreshToken)
      : await this.microsoftOAuthClient.refreshAccessToken(token.refreshToken);
    this.auth[provider] = refreshed;
    await this.sessionStore.writeAuthToken(provider, refreshed);
    return refreshed;
  }
}
