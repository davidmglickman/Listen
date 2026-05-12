import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { StoredOAuthToken } from "../storage/sessionStore";
import { fetchWithTimeout } from "../http/fetchWithTimeout";

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

interface GoogleProfileResponse {
  email?: string;
  name?: string;
}

function formatGoogleOAuthError(prefix: string, status: number, body: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return `${prefix} failed with status ${status}`;
  }

  try {
    const payload = JSON.parse(trimmedBody) as {
      error?: string;
      error_description?: string;
      error_uri?: string;
    };
    const detail = [payload.error, payload.error_description, payload.error_uri].filter(Boolean).join(" | ");
    return detail ? `${prefix} failed with status ${status}: ${detail}` : `${prefix} failed with status ${status}: ${trimmedBody}`;
  } catch {
    return `${prefix} failed with status ${status}: ${trimmedBody}`;
  }
}

export class GoogleOAuthClient {
  private readonly clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  private readonly clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";

  isConfigured(): boolean {
    return Boolean(this.clientId);
  }

  getRedirectUri(port: number): string {
    return `http://127.0.0.1:${port}/oauth/google/callback`;
  }

  createAuthorizationRequest(port: number): { url: string; state: string; codeVerifier: string } {
    const state = randomUUID();
    const redirectUri = this.getRedirectUri(port);
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ].join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state, codeVerifier };
  }

  async exchangeCode(code: string, port: number, codeVerifier: string): Promise<StoredOAuthToken> {
    const redirectUri = this.getRedirectUri(port);
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });
    if (this.clientSecret) {
      body.set("client_secret", this.clientSecret);
    }
    const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(formatGoogleOAuthError("Google token exchange", response.status, await response.text()));
    }

    const payload = (await response.json()) as GoogleTokenResponse;
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
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (this.clientSecret) {
      body.set("client_secret", this.clientSecret);
    }
    const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(formatGoogleOAuthError("Google token refresh", response.status, await response.text()));
    }

    const payload = (await response.json()) as GoogleTokenResponse;
    const profile = await this.fetchProfile(payload.access_token);
    return {
      accessToken: payload.access_token,
      refreshToken,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : undefined,
      accountLabel: profile,
    };
  }

  private async fetchProfile(accessToken: string): Promise<string> {
    const response = await fetchWithTimeout("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      return "Google connected";
    }

    const payload = (await response.json()) as GoogleProfileResponse;
    return payload.email ?? payload.name ?? `Google ${createHash("sha1").update(accessToken).digest("hex").slice(0, 6)}`;
  }
}
