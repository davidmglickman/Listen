import { net } from "electron";

const DEFAULT_TIMEOUT_MS = 15_000;

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message) {
    return `${error.message}: ${cause.message}`;
  }

  if (typeof cause === "string" && cause.trim()) {
    return `${error.message}: ${cause.trim()}`;
  }

  return error.message;
}

export async function fetchWithTimeout(input: string | URL, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestInput = input instanceof URL ? input.toString() : input;

  try {
    return await net.fetch(requestInput, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw new Error(describeFetchError(error));
  } finally {
    clearTimeout(timer);
  }
}