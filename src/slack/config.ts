import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface SlackConfig {
  clientId: string;
  clientSecret: string;
}

export interface ActiveChannel {
  id: string;                // Slack channel ID
  name: string;              // Display name
  type: "im" | "mpim" | "public_channel" | "private_channel";
  userId?: string;           // For im channels: the other user's Slack ID
}

export interface SlackWorkspace {
  teamId: string;
  teamName: string;
  accessToken: string;       // xoxp- user token (long-lived)
  authedUserId: string;      // Authenticated user's Slack ID
  lastPulledAt?: string;     // Unix timestamp of last successful pull
  activeChannels?: ActiveChannel[];  // Channels where user has spoken (set by slack:analyze)
}

// ── Paths ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const CONFIG_DIR = resolve(PROJECT_ROOT, ".config/slack");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

// ── Global config I/O ──────────────────────────────────────────────────

export function loadConfig(): SlackConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Slack config not found at .config/slack/config.json\n` +
        `Create it with: { "clientId": "...", "clientSecret": "..." }`,
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as SlackConfig;
}

export function saveConfig(config: SlackConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ── Workspace I/O ──────────────────────────────────────────────────────

function workspacePath(teamId: string): string {
  return resolve(CONFIG_DIR, `${teamId}.json`);
}

export function loadWorkspace(teamId: string): SlackWorkspace {
  const path = workspacePath(teamId);
  if (!existsSync(path)) {
    throw new Error(`Workspace config not found: .config/slack/${teamId}.json`);
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as SlackWorkspace;
}

export function saveWorkspace(workspace: SlackWorkspace): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const path = workspacePath(workspace.teamId);
  writeFileSync(path, JSON.stringify(workspace, null, 2) + "\n");
}

export function listWorkspaces(): SlackWorkspace[] {
  if (!existsSync(CONFIG_DIR)) return [];

  return readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith(".json") && f !== "config.json")
    .map((f) => {
      const raw = readFileSync(resolve(CONFIG_DIR, f), "utf-8");
      return JSON.parse(raw) as SlackWorkspace;
    });
}

export function findWorkspace(teamIdOrName: string): SlackWorkspace {
  const workspaces = listWorkspaces();

  // Try exact team ID match first
  const byId = workspaces.find((w) => w.teamId === teamIdOrName);
  if (byId) return byId;

  // Try case-insensitive name substring match
  const lower = teamIdOrName.toLowerCase();
  const byName = workspaces.filter((w) =>
    w.teamName.toLowerCase().includes(lower),
  );

  if (byName.length === 1) return byName[0];

  if (byName.length > 1) {
    const matches = byName.map((w) => `  ${w.teamId} (${w.teamName})`).join("\n");
    throw new Error(
      `Multiple workspaces match "${teamIdOrName}":\n${matches}\n` +
        `Use the team ID to be specific.`,
    );
  }

  const known =
    workspaces.map((w) => `  ${w.teamId} (${w.teamName})`).join("\n") ||
    "  (none)";
  throw new Error(
    `Workspace "${teamIdOrName}" not found.\nKnown workspaces:\n${known}\n` +
      `Run: pnpm slack:integrate`,
  );
}
