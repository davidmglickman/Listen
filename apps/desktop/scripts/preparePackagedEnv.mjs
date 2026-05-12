import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowedKeys = new Set([
  "LISTEN_REALTIME_PORT",
  "LISTEN_OAUTH_PORT",
  "LISTEN_MEETING_POPUP_LEAD_MINUTES",
  "LISTEN_UPDATE_FEED_URL",
  "LISTEN_UPDATE_CHANNEL",
  "LISTEN_UPDATE_GITHUB_OWNER",
  "LISTEN_UPDATE_GITHUB_REPO",
  "LISTEN_UPDATE_GITHUB_PRIVATE",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_ORGANIZATION_SLUG",
  "SUPABASE_RESEARCH_PROVIDER",
  "SUPABASE_RESEARCH_POLL_MS",
  "LISTEN_AI_MODEL",
  "LISTEN_AI_BASE_URL",
  "DEEPGRAM_MODEL",
  "DEEPGRAM_LANGUAGE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CALENDAR_ID",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");

const envCandidates = [
  path.join(repoRoot, ".env"),
  path.join(desktopRoot, ".env"),
];

const sourcePath = envCandidates.find((candidate) => existsSync(candidate));
const outputDir = path.join(desktopRoot, "dist", "apps", "desktop", "resources");
const outputPath = path.join(outputDir, ".env");

await mkdir(outputDir, { recursive: true });

const values = new Map();

if (sourcePath) {
  const raw = await readFile(sourcePath, "utf8");
  raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!allowedKeys.has(key)) {
        return;
      }

      values.set(key, trimmed.slice(separatorIndex + 1));
    });
}

for (const key of allowedKeys) {
  const value = process.env[key];
  if (typeof value === "string") {
    values.set(key, value);
  }
}

const lines = Array.from(values.entries()).map(([key, value]) => `${key}=${value}`);

await writeFile(outputPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");