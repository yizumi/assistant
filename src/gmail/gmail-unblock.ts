import { resolve } from "node:path";
import { loadConfig, saveConfig, findAccount, refreshAccessToken } from "./config.js";
import {
  PROJECT_ROOT, BATCH_SIZE,
  gmailFetch, gmailFetchWithRetry, sleep,
  messageExists, decodeMessageBodies, saveMessage, buildIndex, sixMonthsAgo,
  type GmailMessage, type MessagesListResponse,
} from "./gmail-api.js";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const accountEmail = process.argv[2];
  const senderEmail = process.argv[3];

  if (!accountEmail || !senderEmail) {
    console.error("Usage: pnpm gmail:unblock <account-email> <sender-email>");
    process.exit(1);
  }

  const config = loadConfig();
  const account = findAccount(config, accountEmail);

  // Validate sender is in blockedSenders
  const blockedSenders = account.blockedSenders ?? [];
  const senderLower = senderEmail.toLowerCase();
  const blockedIndex = blockedSenders.findIndex((s) => s.toLowerCase() === senderLower);

  if (blockedIndex === -1) {
    console.error(`Error: "${senderEmail}" is not in blockedSenders for ${accountEmail}`);
    const sample = blockedSenders.slice(0, 5).join(", ");
    if (blockedSenders.length > 0) {
      console.error(`Blocked senders (${blockedSenders.length} total): ${sample}${blockedSenders.length > 5 ? ", …" : ""}`);
    }
    process.exit(1);
  }

  // Move from blockedSenders to approvedSenders
  blockedSenders.splice(blockedIndex, 1);
  account.blockedSenders = blockedSenders;

  const approvedSenders = account.approvedSenders ?? [];
  if (!approvedSenders.some((s) => s.toLowerCase() === senderLower)) {
    approvedSenders.push(senderEmail.toLowerCase());
    account.approvedSenders = approvedSenders;
  }

  saveConfig(config);
  console.log(`Moved "${senderEmail}" from blockedSenders to approvedSenders`);

  // Refresh token and fetch messages from sender
  await refreshAccessToken(config, account);

  const after = sixMonthsAgo();
  console.log(`Fetching messages from ${senderEmail} (after ${after})…`);

  const messageIds = await listSenderMessageIds(config, account, senderEmail, after);
  console.log(`Found ${messageIds.length} messages from ${senderEmail}`);

  if (messageIds.length === 0) {
    buildIndex(accountEmail);
    console.log("Done!");
    return;
  }

  // Download missing messages
  const outputBase = resolve(PROJECT_ROOT, "output/gmail", accountEmail);
  let saved = 0;
  let skipped = 0;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);

    if (messageIds.length > BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(messageIds.length / BATCH_SIZE);
      console.log(`  Batch ${batchNum}/${totalBatches}`);
    }

    await refreshAccessToken(config, account);

    for (const id of batch) {
      if (messageExists(outputBase, id)) {
        skipped++;
        continue;
      }

      const message = await gmailFetchWithRetry<GmailMessage>(
        config,
        account,
        `/users/me/messages/${id}?format=full`,
      );

      if (message.payload) decodeMessageBodies(message.payload);
      saveMessage(outputBase, id, message);
      saved++;

      await sleep(100);
    }
  }

  console.log(`Downloaded ${saved} messages (${skipped} already existed)`);

  // Rebuild index
  buildIndex(accountEmail);
  console.log("Done!");
}

// ── List message IDs from a specific sender ────────────────────────────

async function listSenderMessageIds(
  config: Parameters<typeof gmailFetch>[0],
  account: Parameters<typeof gmailFetch>[1],
  senderEmail: string,
  after: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      maxResults: "500",
      q: `from:${senderEmail} after:${after}`,
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
