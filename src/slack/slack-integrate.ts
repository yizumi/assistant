import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { loadConfig, saveWorkspace } from "./config.js";
import type { SlackWorkspace } from "./config.js";

const REDIRECT_URI = "https://localhost:8484/callback";
const USER_SCOPES = [
  "search:read",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
].join(",");

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

  if (!config.clientId || !config.clientSecret) {
    console.error(
      'Error: clientId and clientSecret must be set in .config/slack/config.json',
    );
    process.exit(1);
  }

  // Open browser, wait for user to paste the redirect URL
  const code = await waitForCode(config.clientId);

  // Exchange the code for tokens
  const oauthResponse = await exchangeCodeForToken(
    code,
    config.clientId,
    config.clientSecret,
  );

  // Save workspace config
  const workspace: SlackWorkspace = {
    teamId: oauthResponse.team.id,
    teamName: oauthResponse.team.name,
    accessToken: oauthResponse.authed_user.access_token,
    authedUserId: oauthResponse.authed_user.id,
  };

  saveWorkspace(workspace);

  console.log(`Workspace added: ${workspace.teamName} (${workspace.teamId})`);
  console.log(`Token saved to .config/slack/${workspace.teamId}.json`);
}

// ── Auth URL ───────────────────────────────────────────────────────────

function buildAuthUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    user_scope: USER_SCOPES,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

// ── Wait for code via URL paste ────────────────────────────────────────

async function waitForCode(clientId: string): Promise<string> {
  const authUrl = buildAuthUrl(clientId);

  console.log("Opening browser for Slack OAuth consent…");
  try {
    execSync(`open "${authUrl}"`);
  } catch {
    console.log("Could not open browser automatically.");
  }

  console.log("\nIf the browser didn't open, visit this URL:");
  console.log(authUrl);
  console.log(
    "\nAfter authorizing, the browser will redirect to a URL that won't load.",
  );
  console.log("Copy the full URL from the browser address bar and paste it here.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const redirectUrl = await new Promise<string>((resolve) => {
    rl.question("Paste redirect URL: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const url = new URL(redirectUrl);
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`OAuth error: ${error}`);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error(
      "Could not find 'code' parameter in the URL. Make sure you pasted the full redirect URL.",
    );
  }

  return code;
}

// ── Token exchange ─────────────────────────────────────────────────────

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  authed_user: {
    id: string;
    access_token: string;
    scope: string;
  };
  team: {
    id: string;
    name: string;
  };
}

async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<SlackOAuthResponse> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as SlackOAuthResponse;
  if (!data.ok) {
    throw new Error(`Slack OAuth error: ${data.error}`);
  }

  return data;
}

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
