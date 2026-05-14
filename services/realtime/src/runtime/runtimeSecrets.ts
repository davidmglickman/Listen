export interface PersistedRuntimeSecrets {
  aiApiKey: string | null;
  deepgramApiKey: string | null;
}

export interface PersistedRuntimeTranslationSettings {
  enabled: boolean;
  hostLanguage: string | null;
  guestLanguage: string | null;
  hostVoiceEnabled: boolean;
  guestVoiceEnabled: boolean;
  hostVoiceName: string | null;
  guestVoiceName: string | null;
  transcriptionFlushMs: number | null;
  transcriptionFlushBytes: number | null;
}

function normalizeSecret(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

const envDefaults = {
  aiApiKey: normalizeSecret(process.env.LISTEN_AI_API_KEY) || normalizeSecret(process.env.OPENAI_API_KEY),
  aiModel: process.env.LISTEN_AI_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  aiBaseUrl: process.env.LISTEN_AI_BASE_URL?.trim() || "https://api.openai.com/v1",
  deepgramApiKey: normalizeSecret(process.env.DEEPGRAM_API_KEY),
  deepgramModel: process.env.DEEPGRAM_MODEL?.trim() || "nova-3",
  deepgramLanguage: process.env.DEEPGRAM_LANGUAGE?.trim() || "en-US",
  translationEnabled: process.env.LISTEN_TRANSLATION_ENABLED === "true",
  translationHostLanguage: process.env.LISTEN_TRANSLATION_SOURCE_LANGUAGE?.trim() || "English",
  translationGuestLanguage: process.env.LISTEN_TRANSLATION_TARGET_LANGUAGE?.trim() || "Portuguese (Brazil)",
  translationHostVoiceEnabled: false,
  translationGuestVoiceEnabled: false,
  translationHostVoiceName: null,
  translationGuestVoiceName: null,
  translationFlushMs: normalizePositiveInteger(process.env.LISTEN_TRANSCRIPTION_FLUSH_MS),
  translationFlushBytes: normalizePositiveInteger(process.env.LISTEN_TRANSCRIPTION_FLUSH_BYTES),
};

let persistedRuntimeSecrets: PersistedRuntimeSecrets = {
  aiApiKey: null,
  deepgramApiKey: null,
};

let persistedRuntimeTranslationSettings: PersistedRuntimeTranslationSettings = {
  enabled: false,
  hostLanguage: null,
  guestLanguage: null,
  hostVoiceEnabled: false,
  guestVoiceEnabled: false,
  hostVoiceName: null,
  guestVoiceName: null,
  transcriptionFlushMs: null,
  transcriptionFlushBytes: null,
};

export function replacePersistedRuntimeSecrets(value: Partial<PersistedRuntimeSecrets> | null | undefined): PersistedRuntimeSecrets {
  persistedRuntimeSecrets = {
    aiApiKey: normalizeSecret(value?.aiApiKey ?? null),
    deepgramApiKey: normalizeSecret(value?.deepgramApiKey ?? null),
  };
  return { ...persistedRuntimeSecrets };
}

export function replacePersistedRuntimeTranslationSettings(
  value: Partial<PersistedRuntimeTranslationSettings> | null | undefined,
): PersistedRuntimeTranslationSettings {
  persistedRuntimeTranslationSettings = {
    enabled: value?.enabled === true,
    hostLanguage: normalizeSecret((value as { hostLanguage?: unknown; sourceLanguage?: unknown } | null | undefined)?.hostLanguage
      ?? (value as { hostLanguage?: unknown; sourceLanguage?: unknown } | null | undefined)?.sourceLanguage
      ?? null),
    guestLanguage: normalizeSecret((value as { guestLanguage?: unknown; targetLanguage?: unknown } | null | undefined)?.guestLanguage
      ?? (value as { guestLanguage?: unknown; targetLanguage?: unknown } | null | undefined)?.targetLanguage
      ?? null),
    hostVoiceEnabled: (value as { hostVoiceEnabled?: unknown } | null | undefined)?.hostVoiceEnabled === true,
    guestVoiceEnabled: (value as { guestVoiceEnabled?: unknown } | null | undefined)?.guestVoiceEnabled === true,
    hostVoiceName: normalizeSecret((value as { hostVoiceName?: unknown } | null | undefined)?.hostVoiceName ?? null),
    guestVoiceName: normalizeSecret((value as { guestVoiceName?: unknown } | null | undefined)?.guestVoiceName ?? null),
    transcriptionFlushMs: normalizePositiveInteger(value?.transcriptionFlushMs ?? null),
    transcriptionFlushBytes: normalizePositiveInteger(value?.transcriptionFlushBytes ?? null),
  };
  return { ...persistedRuntimeTranslationSettings };
}

export function getPersistedRuntimeSecrets(): PersistedRuntimeSecrets {
  return { ...persistedRuntimeSecrets };
}

export function getRuntimeSecretCapabilities(): { aiConfigured: boolean; transcriptionConfigured: boolean } {
  return {
    aiConfigured: Boolean(persistedRuntimeSecrets.aiApiKey || envDefaults.aiApiKey),
    transcriptionConfigured: Boolean(persistedRuntimeSecrets.deepgramApiKey || envDefaults.deepgramApiKey),
  };
}

export function getAiRuntimeConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return {
    apiKey: persistedRuntimeSecrets.aiApiKey || envDefaults.aiApiKey,
    model: envDefaults.aiModel,
    baseUrl: envDefaults.aiBaseUrl,
  };
}

export function getDeepgramRuntimeConfig(): { apiKey: string | null; model: string; language: string } {
  return {
    apiKey: persistedRuntimeSecrets.deepgramApiKey || envDefaults.deepgramApiKey,
    model: envDefaults.deepgramModel,
    language: envDefaults.deepgramLanguage,
  };
}

export function getTranslationRuntimeConfig(): {
  enabled: boolean;
  hostLanguage: string;
  guestLanguage: string;
  hostVoiceEnabled: boolean;
  guestVoiceEnabled: boolean;
  hostVoiceName: string | null;
  guestVoiceName: string | null;
  transcriptionFlushMs: number | null;
  transcriptionFlushBytes: number | null;
} {
  return {
    enabled: persistedRuntimeTranslationSettings.enabled || envDefaults.translationEnabled,
    hostLanguage: persistedRuntimeTranslationSettings.hostLanguage || envDefaults.translationHostLanguage,
    guestLanguage: persistedRuntimeTranslationSettings.guestLanguage || envDefaults.translationGuestLanguage,
    hostVoiceEnabled: persistedRuntimeTranslationSettings.hostVoiceEnabled || envDefaults.translationHostVoiceEnabled,
    guestVoiceEnabled: persistedRuntimeTranslationSettings.guestVoiceEnabled || envDefaults.translationGuestVoiceEnabled,
    hostVoiceName: persistedRuntimeTranslationSettings.hostVoiceName || envDefaults.translationHostVoiceName,
    guestVoiceName: persistedRuntimeTranslationSettings.guestVoiceName || envDefaults.translationGuestVoiceName,
    transcriptionFlushMs: persistedRuntimeTranslationSettings.transcriptionFlushMs || envDefaults.translationFlushMs,
    transcriptionFlushBytes: persistedRuntimeTranslationSettings.transcriptionFlushBytes || envDefaults.translationFlushBytes,
  };
}