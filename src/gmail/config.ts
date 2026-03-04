import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface Account {
  email: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string; // ISO 8601
  blockedSenders?: string[];     // emails classified as spam/mailing-list
  approvedSenders?: string[];    // emails classified as legitimate
  lastCheckedAt?: string;        // YYYY-MM-DD — last successful pull date
}

export interface Config {
  gcpClientId: string;
  gcpClientKey: string;
  geminiApiKey?: string;         // Gemini API key for sender classification
  accounts: Account[];
}

// ── Paths ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const CONFIG_PATH = resolve(PROJECT_ROOT, ".config/gmail/config.json");

// ── Config I/O ─────────────────────────────────────────────────────────

export function loadConfig(): Config {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Config;
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ── Account lookup ─────────────────────────────────────────────────────

export function findAccount(config: Config, email: string): Account {
  const account = config.accounts.find((a) => a.email === email);
  if (!account) {
    const known = config.accounts.map((a) => a.email).join(", ") || "(none)";
    throw new Error(
      `Account "${email}" not found. Known accounts: ${known}\n` +
        `Run: pnpm gmail:accounts:add ${email}`,
    );
  }
  return account;
}

// ── Token refresh ──────────────────────────────────────────────────────

export async function refreshAccessToken(
  config: Config,
  account: Account,
): Promise<void> {
  const expiresAt = new Date(account.accessTokenExpiresAt).getTime();
  const fiveMinutes = 5 * 60 * 1000;

  if (Date.now() < expiresAt - fiveMinutes) {
    return; // token is still valid
  }

  console.log(`Refreshing access token for ${account.email}…`);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.gcpClientId,
      client_secret: config.gcpClientKey,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  account.accessToken = data.access_token;
  account.accessTokenExpiresAt = new Date(
    Date.now() + data.expires_in * 1000,
  ).toISOString();

  saveConfig(config);
}
