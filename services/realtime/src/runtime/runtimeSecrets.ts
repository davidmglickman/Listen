export interface PersistedRuntimeSecrets {
  aiApiKey: string | null;
  deepgramApiKey: string | null;
}

function normalizeSecret(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

const envDefaults = {
  aiApiKey: normalizeSecret(process.env.LISTEN_AI_API_KEY) || normalizeSecret(process.env.OPENAI_API_KEY),
  aiModel: process.env.LISTEN_AI_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  aiBaseUrl: process.env.LISTEN_AI_BASE_URL?.trim() || "https://api.openai.com/v1",
  deepgramApiKey: normalizeSecret(process.env.DEEPGRAM_API_KEY),
  deepgramModel: process.env.DEEPGRAM_MODEL?.trim() || "nova-3",
  deepgramLanguage: process.env.DEEPGRAM_LANGUAGE?.trim() || "en-US",
};

let persistedRuntimeSecrets: PersistedRuntimeSecrets = {
  aiApiKey: null,
  deepgramApiKey: null,
};

export function replacePersistedRuntimeSecrets(value: Partial<PersistedRuntimeSecrets> | null | undefined): PersistedRuntimeSecrets {
  persistedRuntimeSecrets = {
    aiApiKey: normalizeSecret(value?.aiApiKey ?? null),
    deepgramApiKey: normalizeSecret(value?.deepgramApiKey ?? null),
  };
  return { ...persistedRuntimeSecrets };
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