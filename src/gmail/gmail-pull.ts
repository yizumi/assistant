import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, findAccount, refreshAccessToken, saveConfig } from "./config.js";
import type { Config, Account } from "./config.js";
import {
  PROJECT_ROOT, GMAIL_API,
  gmailFetch,
  cleanupBlockedSenderFiles, downloadAndClassify, buildIndex,
  type MessagesListResponse,
} from "./gmail-api.js";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const email = args[0];

  if (!email) {
    console.error("Usage: pnpm gmail:pull <email>");
    process.exit(1);
  }

  const config = loadConfig();
  const account = findAccount(config, email);

  const latestDate = account.lastCheckedAt ?? getLatestLocalDate(email);
  if (!latestDate) {
    console.error(`No local emails found for ${email}.`);
    console.error("Run `pnpm gmail:backfill <email>` first.");
    process.exit(1);
  }

  console.log(`Incremental pull: fetching messages after ${latestDate}`);

  await refreshAccessToken(config, account);

  // Phase 1: List message IDs since latest local date
  const messageIds = await listMessageIdsSince(config, account, latestDate);
  console.log(`Found ${messageIds.length} messages total`);

  if (messageIds.length === 0) {
    console.log("No new messages. Done!");
    account.lastCheckedAt = new Date().toISOString().slice(0, 10);
    saveConfig(config);
    return;
  }

  // Phase 1.5: Clean up previously leaked files from blocked senders
  cleanupBlockedSenderFiles(config, account);

  // Phase 2: Batch download + classify senders
  await downloadAndClassify(config, account, messageIds);

  // Phase 3: Build index
  buildIndex(email);

  // Save lastCheckedAt so next pull starts from today
  account.lastCheckedAt = new Date().toISOString().slice(0, 10);
  saveConfig(config);

  console.log("Done!");
}

// ── Find latest local date ─────────────────────────────────────────────

function getLatestLocalDate(email: string): string | null {
  const outputBase = resolve(PROJECT_ROOT, "output/gmail", email);
  if (!existsSync(outputBase)) return null;

  const dateDirs = readdirSync(outputBase)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  return dateDirs.length > 0 ? dateDirs[dateDirs.length - 1] : null;
}

// ── Phase 1: List message IDs since a given date ───────────────────────

async function listMessageIdsSince(
  config: Config,
  account: Account,
  afterDate: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let page = 0;

  const after = afterDate.replace(/-/g, "/");
  console.log(`Phase 1: Listing message IDs (after ${after})…`);

  while (true) {
    const params = new URLSearchParams({
      maxResults: "500",
      q: `after:${after}`,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await gmailFetch<MessagesListResponse>(
      config,
      account,
      `/users/me/messages?${params}`,
    );

    if (data.messages) {
      for (const msg of data.messages) {
        ids.push(msg.id);
      }
    }

    page++;
    console.log(`  Page ${page}: ${ids.length} IDs so far`);

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return ids;
}

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
