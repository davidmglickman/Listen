import type { SessionParticipantTranslationPreferences, TranscriptSegment } from "@listen/shared";

import { getAiRuntimeConfig, getTranslationRuntimeConfig } from "../runtime/runtimeSecrets";

export interface TranscriptTranslation {
  translatedText: string;
  translatedLanguage: string;
}

export interface TranscriptTranslator {
  translateSegment(
    segment: TranscriptSegment,
    participantPreferences: SessionParticipantTranslationPreferences | null,
  ): Promise<TranscriptTranslation | null>;
}

const TRANSLATION_REQUEST_TIMEOUT_MS = 10_000;
const TRANSLATION_MAX_ATTEMPTS = 3;
const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return getAiRuntimeConfig();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError";
}

function formatResponseError(status: number, body: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return `Transcript translation request failed with status ${status}.`;
  }

  return `Transcript translation request failed with status ${status}: ${trimmedBody.slice(0, 240)}`;
}

function getSegmentTranslationConfig(
  segment: TranscriptSegment,
  translationConfig: ReturnType<typeof getTranslationRuntimeConfig>,
  participantPreferences: SessionParticipantTranslationPreferences | null,
): {
  sourceLanguage: string;
  targetLanguage: string;
  participantLabel: string;
} {
  if (segment.source === "microphone") {
    return {
      sourceLanguage: participantPreferences?.host.language || translationConfig.hostLanguage,
      targetLanguage: participantPreferences?.guest.language || translationConfig.guestLanguage,
      participantLabel: "host",
    };
  }

  return {
    sourceLanguage: participantPreferences?.guest.language || translationConfig.guestLanguage,
    targetLanguage: participantPreferences?.host.language || translationConfig.hostLanguage,
    participantLabel: "guest",
  };
}

function extractMessageContent(payload: {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}): string | null {
  const rawContent = payload.choices?.[0]?.message?.content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : rawContent;

  return typeof content === "string" && content.trim() ? content : null;
}

class AiTranscriptTranslator implements TranscriptTranslator {
  async translateSegment(
    segment: TranscriptSegment,
    participantPreferences: SessionParticipantTranslationPreferences | null,
  ): Promise<TranscriptTranslation | null> {
    const text = segment.text.trim();
    if (!text) {
      return null;
    }

    const translationConfig = getTranslationRuntimeConfig();
    if (!translationConfig.enabled) {
      return null;
    }
    const segmentTranslationConfig = getSegmentTranslationConfig(segment, translationConfig, participantPreferences);

    const aiConfig = getAiConfig();
    if (!aiConfig.apiKey) {
      return null;
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= TRANSLATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${aiConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${aiConfig.apiKey}`,
          },
          signal: AbortSignal.timeout(TRANSLATION_REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            model: aiConfig.model,
            temperature: 0,
            messages: [
              {
                role: "system",
                content:
                  `You translate live meeting transcript segments from ${segmentTranslationConfig.sourceLanguage} into ${segmentTranslationConfig.targetLanguage}. This segment came from the ${segmentTranslationConfig.participantLabel}. Respond with strict JSON only containing translatedText. Preserve the speaker's intent and tone. Keep proper nouns, company names, product names, and personal names unchanged unless they have a standard localized form. Do not add commentary or explanations.`,
              },
              {
                role: "user",
                content: JSON.stringify({
                  sourceLanguage: segmentTranslationConfig.sourceLanguage,
                  targetLanguage: segmentTranslationConfig.targetLanguage,
                  participantRole: segmentTranslationConfig.participantLabel,
                  speakerLabel: segment.speakerLabel ?? null,
                  text,
                }),
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "translated_segment",
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    translatedText: { type: "string" },
                  },
                  required: ["translatedText"],
                },
              },
            },
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          const responseError = new Error(formatResponseError(response.status, body));
          if (attempt < TRANSLATION_MAX_ATTEMPTS && isRetryableStatus(response.status)) {
            lastError = responseError;
            await sleep(250 * attempt);
            continue;
          }

          throw responseError;
        }

        const payload = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string | Array<{ type?: string; text?: string }>;
            };
          }>;
        };
        const content = extractMessageContent(payload);
        if (!content) {
          throw new Error("Transcript translation response did not include content.");
        }

        const parsed = JSON.parse(content) as Record<string, unknown>;
        const translatedText = typeof parsed.translatedText === "string" ? parsed.translatedText.trim() : "";
        if (!translatedText) {
          return null;
        }

        return {
          translatedText,
          translatedLanguage: segmentTranslationConfig.targetLanguage,
        };
      } catch (error) {
        lastError = error;
        if (attempt < TRANSLATION_MAX_ATTEMPTS && isRetryableError(error)) {
          await sleep(250 * attempt);
          continue;
        }

        break;
      }
    }

    if (lastError instanceof Error) {
      throw new Error(`Live translation failed after ${TRANSLATION_MAX_ATTEMPTS} attempts: ${lastError.message}`);
    }

    throw new Error(`Live translation failed after ${TRANSLATION_MAX_ATTEMPTS} attempts.`);
  }
}

export function createTranscriptTranslator(): TranscriptTranslator {
  return new AiTranscriptTranslator();
}