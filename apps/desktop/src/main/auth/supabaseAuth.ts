import type { AppAuthState } from "@listen/shared";
import { createClient, type Session, type SupportedStorage, type SupabaseClient } from "@supabase/supabase-js";

import { awaitOAuthCode } from "./oauthCallbackServer";
import type { SessionStore, StoredSupabaseSession } from "../storage/sessionStore";

const OAUTH_PORT = Number(process.env.LISTEN_OAUTH_PORT ?? 42813);
const OAUTH_TIMEOUT_MS = 120_000;

function getRedirectUrl(pathname: string): string {
  return `http://127.0.0.1:${OAUTH_PORT}${pathname}`;
}

function normalizeStoredSession(session: Session | null): StoredSupabaseSession | null {
  if (!session) {
    return null;
  }

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user,
  };
}

export class DesktopSupabaseAuthService {
  private client: SupabaseClient | null = null;
  private configured = false;
  private currentState: AppAuthState = {
    configured: false,
    signedIn: false,
    pendingEmail: null,
    user: null,
  };
  private storageCache: Record<string, string> = {};

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly openExternal: (url: string) => Promise<void>,
  ) {}

  async initialize(): Promise<AppAuthState> {
    const url = process.env.SUPABASE_URL?.trim() ?? "";
    const anonKey = process.env.SUPABASE_ANON_KEY?.trim() ?? "";
    const persistedState = await this.sessionStore.readAppAuthState();
    this.storageCache = await this.sessionStore.readSupabaseStorage();

    this.configured = Boolean(url && anonKey);
    this.currentState = persistedState ?? {
      configured: this.configured,
      signedIn: false,
      pendingEmail: null,
      user: null,
    };

    if (!this.configured) {
      this.currentState = {
        configured: false,
        signedIn: false,
        pendingEmail: null,
        user: null,
      };
      await this.persistState();
      return this.currentState;
    }

    const storage: SupportedStorage = {
      getItem: async (key: string) => this.storageCache[key] ?? null,
      setItem: async (key: string, value: string) => {
        this.storageCache[key] = value;
        await this.sessionStore.writeSupabaseStorage(this.storageCache);
      },
      removeItem: async (key: string) => {
        delete this.storageCache[key];
        await this.sessionStore.writeSupabaseStorage(this.storageCache);
      },
    };

    this.client = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: "pkce",
        storage,
      },
    });

    const persistedSession = await this.sessionStore.readSupabaseSession();
    if (persistedSession) {
      await this.client.auth.setSession({
        access_token: persistedSession.access_token,
        refresh_token: persistedSession.refresh_token,
      });
    }

    const { data } = await this.client.auth.getSession();
    await this.applySession(data.session);

    this.client.auth.onAuthStateChange((_event, session) => {
      void this.applySession(session);
    });

    return this.currentState;
  }

  getState(): AppAuthState {
    return this.currentState;
  }

  async getAccessToken(): Promise<string | null> {
    const client = this.requireClient();
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async hydrateProfile(user: AppAuthState["user"] | null): Promise<AppAuthState> {
    this.currentState = {
      ...this.currentState,
      user: user
        ? {
            ...user,
          }
        : null,
    };
    await this.persistState();
    return this.currentState;
  }

  async signInWithGoogle(): Promise<AppAuthState> {
    const client = this.requireClient();
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: getRedirectUrl("/auth/callback"),
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      throw new Error(error?.message ?? "Unable to start Google sign-in.");
    }

    const callbackPromise = awaitOAuthCode(OAUTH_PORT, "/auth/callback", OAUTH_TIMEOUT_MS);
    await this.openExternal(data.url);
    const callback = await callbackPromise;
    const { error: exchangeError } = await client.auth.exchangeCodeForSession(callback.code);
    if (exchangeError) {
      throw new Error(exchangeError.message);
    }

    const { data: sessionData } = await client.auth.getSession();
    await this.applySession(sessionData.session);
    return this.currentState;
  }

  async sendMagicLink(email: string): Promise<AppAuthState> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new Error("Email is required.");
    }

    const client = this.requireClient();
    const { error } = await client.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: getRedirectUrl("/auth/callback"),
      },
    });

    if (error) {
      throw new Error(error.message);
    }

    this.currentState = {
      ...this.currentState,
      configured: true,
      pendingEmail: normalizedEmail,
    };
    await this.persistState();
    return this.currentState;
  }

  async completeEmailSignIn(): Promise<AppAuthState> {
    const client = this.requireClient();
    if (!this.currentState.pendingEmail) {
      throw new Error("No pending email sign-in request.");
    }

    const callback = await awaitOAuthCode(OAUTH_PORT, "/auth/callback", OAUTH_TIMEOUT_MS);
    const { error } = await client.auth.exchangeCodeForSession(callback.code);
    if (error) {
      throw new Error(error.message);
    }

    const { data } = await client.auth.getSession();
    await this.applySession(data.session);
    return this.currentState;
  }

  async signOut(): Promise<AppAuthState> {
    const client = this.requireClient();
    const { error } = await client.auth.signOut();
    if (error) {
      throw new Error(error.message);
    }

    await this.applySession(null);
    this.storageCache = {};
    await this.sessionStore.writeSupabaseStorage({});
    return this.currentState;
  }

  private requireClient(): SupabaseClient {
    if (!this.client || !this.configured) {
      throw new Error("Supabase Auth is not configured.");
    }

    return this.client;
  }

  private async applySession(session: Session | null): Promise<void> {
    const user = session?.user ?? null;
    const fullName = typeof user?.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user?.user_metadata?.name === "string"
        ? user.user_metadata.name
        : null;

    this.currentState = {
      configured: this.configured,
      signedIn: Boolean(user),
      pendingEmail: user ? null : this.currentState.pendingEmail,
      user: user
        ? {
            id: user.id,
            organizationId: null,
            email: user.email ?? null,
            fullName,
            role: null,
            status: null,
          }
        : null,
    };

    await this.sessionStore.writeSupabaseSession(normalizeStoredSession(session));
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    await this.sessionStore.writeAppAuthState(this.currentState);
  }
}
