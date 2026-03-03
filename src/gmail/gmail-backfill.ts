import { loadConfig, findAccount, refreshAccessToken } from "./config.js";
import type { Config, Account } from "./config.js";
import {
  PROJECT_ROOT, GMAIL_API, BATCH_SIZE,
  gmailFetch, sixMonthsAgo,
  cleanupBlockedSenderFiles, downloadAndClassify, buildIndex,
  type MessagesListResponse,
} from "./gmail-api.js";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let email: string | undefined;
  let afterDate: string | undefined;
  let beforeDate: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--after:")) {
      afterDate = arg.slice("--after:".length);
    } else if (arg.startsWith("--before:")) {
      beforeDate = arg.slice("--before:".length);
    } else if (!email) {
      email = arg;
    }
  }

  if (!email) {
    console.error("Usage: pnpm gmail:backfill <email> [--after:yyyy-MM-dd] [--before:yyyy-MM-dd]");
    process.exit(1);
  }

  const config = loadConfig();
  const account = findAccount(config, email);

  await refreshAccessToken(config, account);

  // Phase 1: List message IDs
  const messageIds = await listAllMessageIds(config, account, afterDate, beforeDate);
  console.log(`Found ${messageIds.length} messages total`);

  // Phase 1.5: Clean up previously leaked files from blocked senders
  cleanupBlockedSenderFiles(config, account);

  // Phase 2: Batch download + classify senders
  await downloadAndClassify(config, account, messageIds);

  // Phase 3: Build index
  buildIndex(email);

  console.log("Done!");
}

// ── Phase 1: List all message IDs (with 6-month filter) ────────────────

async function listAllMessageIds(
  config: Config,
  account: Account,
  afterDate?: string,
  beforeDate?: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let page = 0;

  // Build date query: --after/--before override default 6-month window
  const after = afterDate ? afterDate.replace(/-/g, "/") : sixMonthsAgo();
  const before = beforeDate ? beforeDate.replace(/-/g, "/") : undefined;

  let dateDesc = `after ${after}`;
  if (before) dateDesc += `, before ${before}`;
  console.log(`Phase 1: Listing message IDs (${dateDesc})…`);

  while (true) {
    let q = `after:${after}`;
    if (before) q += ` before:${before}`;

    const params = new URLSearchParams({
      maxResults: "500",
      q,
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
