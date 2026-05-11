import { createHash, randomUUID } from "node:crypto";

import type { StoredOAuthToken } from "../storage/sessionStore";
import { fetchWithTimeout } from "../http/fetchWithTimeout";

interface MicrosoftTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

interface MicrosoftProfileResponse {
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
}

export class MicrosoftOAuthClient {
  private readonly clientId = process.env.MICROSOFT_CLIENT_ID?.trim() ?? "";
  private readonly clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim() ?? "";
  private readonly tenantId = process.env.MICROSOFT_TENANT_ID?.trim() || "common";

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  getRedirectUri(port: number): string {
    return `http://127.0.0.1:${port}/oauth/microsoft/callback`;
  }

  createAuthorizationRequest(port: number): { url: string; state: string } {
    const state = randomUUID();
    const redirectUri = this.getRedirectUri(port);
    const url = new URL(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", "offline_access User.Read Calendars.Read");
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  async exchangeCode(code: string, port: number): Promise<StoredOAuthToken> {
    const redirectUri = this.getRedirectUri(port);
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const response = await fetchWithTimeout(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Microsoft token exchange failed with status ${response.status}`);
    }

    const payload = (await response.json()) as MicrosoftTokenResponse;
    const profile = await this.fetchProfile(payload.access_token);
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : undefined,
      accountLabel: profile,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<StoredOAuthToken> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "offline_access User.Read Calendars.Read",
    });
    const response = await fetchWithTimeout(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Microsoft token refresh failed with status ${response.status}`);
    }

    const payload = (await response.json()) as MicrosoftTokenResponse;
    const profile = await this.fetchProfile(payload.access_token);
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : undefined,
      accountLabel: profile,
    };
  }

  private async fetchProfile(accessToken: string): Promise<string> {
    const response = await fetchWithTimeout("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      return "Microsoft 365 connected";
    }

    const payload = (await response.json()) as MicrosoftProfileResponse;
    return payload.mail ?? payload.userPrincipalName ?? payload.displayName ?? `Microsoft ${createHash("sha1").update(accessToken).digest("hex").slice(0, 6)}`;
  }
}
