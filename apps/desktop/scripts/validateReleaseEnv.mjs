import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveEnvPath() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

dotenv.config({ path: resolveEnvPath() });

const feedUrl = process.env.LISTEN_UPDATE_FEED_URL?.trim() || "";
const githubOwner = process.env.LISTEN_UPDATE_GITHUB_OWNER?.trim() || "";
const githubRepo = process.env.LISTEN_UPDATE_GITHUB_REPO?.trim() || "";
const githubToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || "";
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";

function isPlaceholder(value) {
  return /^YOUR_/i.test(value) || /^(changeme|example|placeholder)$/i.test(value);
}

const hasGithubTarget = Boolean(githubOwner && githubRepo) && !isPlaceholder(githubOwner) && !isPlaceholder(githubRepo);
const hasGenericTarget = Boolean(feedUrl);

if (!hasGithubTarget && !hasGenericTarget) {
  console.error("Release publishing is not configured.");
  console.error("Set LISTEN_UPDATE_GITHUB_OWNER and LISTEN_UPDATE_GITHUB_REPO, or set LISTEN_UPDATE_FEED_URL.");
  process.exit(1);
}

if (hasGithubTarget && (!githubToken || isPlaceholder(githubToken))) {
  console.error("GitHub Releases publishing is configured, but GH_TOKEN or GITHUB_TOKEN is missing.");
  process.exit(1);
}

if (!googleClientId || isPlaceholder(googleClientId)) {
  console.error("Google OAuth is not configured for the desktop release.");
  console.error("Set GOOGLE_CLIENT_ID in the release environment so published builds can open Google calendar sign-in.");
  process.exit(1);
}

if (hasGithubTarget) {
  console.log(`Release env OK: GitHub Releases -> ${githubOwner}/${githubRepo}`);
} else {
  console.log(`Release env OK: generic feed -> ${feedUrl}`);
}