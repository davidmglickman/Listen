import { existsSync } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import { GoogleOAuthClient } from "../apps/desktop/src/main/auth/googleOAuth";
import { awaitOAuthCode } from "../apps/desktop/src/main/auth/oauthCallbackServer";
import { SessionStore } from "../apps/desktop/src/main/storage/sessionStore";

function resolveEnvPath(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  dotenv.config({ path: resolveEnvPath() });

  const oauthPort = Number(process.env.LISTEN_OAUTH_PORT ?? 42813);
  const databasePath = process.env.LISTEN_DB_PATH?.trim() || path.resolve(process.cwd(), "data", "listen.db");
  const sessionStore = new SessionStore(databasePath);
  const googleOAuthClient = new GoogleOAuthClient();

  if (!googleOAuthClient.isConfigured()) {
    throw new Error("Google OAuth is not configured in .env.");
  }

  const request = googleOAuthClient.createAuthorizationRequest(oauthPort);
  console.log(`AUTH_URL=${request.url}`);

  const response = await awaitOAuthCode(oauthPort, "/oauth/google/callback", 120_000);
  if (response.state !== request.state) {
    throw new Error("Google OAuth state mismatch.");
  }

  const token = await googleOAuthClient.exchangeCode(response.code, oauthPort);
  await sessionStore.writeAuthToken("google", token);

  console.log(`ACCOUNT_LABEL=${token.accountLabel ?? "Google connected"}`);
  console.log(`DB_PATH=${databasePath}`);
  console.log("GOOGLE_AUTH_STORED=1");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});