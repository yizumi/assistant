import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findWorkspace, saveWorkspace, type ActiveChannel } from "./config.js";
import {
  PROJECT_ROOT,
  slackFetchWithRetry,
  buildUserMap,
  buildIndex,
  sleep,
  tsToDate,
  resolveUserName,
  type SearchMessagesResponse,
  type ConversationsHistoryResponse,
  type ConversationsRepliesResponse,
  type MentionMessage,
  type ThreadMessage,
  type DmMessage,
  type DmMeta,
} from "./slack-api.js";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const teamIdOrName = args.find((a) => !a.startsWith("--"));

  if (!teamIdOrName) {
    console.error("Usage: pnpm slack:pull <team-id-or-name>");
    console.error("Run pnpm slack:analyze first to set up active channels.");
    process.exit(1);
  }

  const workspace = findWorkspace(teamIdOrName);
  console.log(`Pulling messages for ${workspace.teamName} (${workspace.teamId})`);

  if (!workspace.activeChannels || workspace.activeChannels.length === 0) {
    console.error("No activeChannels configured. Run: pnpm slack:analyze <team-id-or-name>");
    process.exit(1);
  }

  const userMap = await buildUserMap(workspace.accessToken);
  const sinceTs = workspace.lastPulledAt ?? String(sevenDaysAgoEpoch());
  const sinceDate = tsToDate(sinceTs);
  console.log(`Fetching messages since ${sinceDate} (ts: ${sinceTs})`);
  console.log(`Active channels: ${workspace.activeChannels.length}`);

  const outputBase = resolve(PROJECT_ROOT, "output/slack", workspace.teamId);

  // Phase 1: Fetch mentions
  const mentions = await fetchMentions(workspace.accessToken, sinceTs, userMap);
  console.log(`Found ${mentions.length} mentions`);

  // Phase 2: Fetch active channels
  let totalMessages = 0;
  for (let i = 0; i < workspace.activeChannels.length; i++) {
    const ch = workspace.activeChannels[i];
    if (i > 0) await sleep(1200);

    const messages = await fetchChannelHistory(workspace.accessToken, ch.id, sinceTs, userMap);
    if (messages.length > 0) {
      writeChannelMessages(outputBase, ch, messages);
      totalMessages += messages.length;
      console.log(`  ${ch.name}: ${messages.length} new messages`);
    }
  }
  console.log(`Found ${totalMessages} messages across active channels`);

  // Phase 3: Build index
  writeMentions(outputBase, mentions);
  buildIndex(workspace.teamId);

  // Phase 4: Update lastPulledAt
  workspace.lastPulledAt = String(Math.floor(Date.now() / 1000));
  saveWorkspace(workspace);

  console.log("Done!");
}

// ── Phase 1: Fetch mentions ──────────────────────────────────────────

async function fetchMentions(
  token: string,
  sinceTs: string,
  userMap: Map<string, string>,
): Promise<MentionMessage[]> {
  console.log("Phase 1: Fetching mentions…");

  const sinceDate = tsToDate(sinceTs);
  const query = `to:me after:${sinceDate}`;
  const mentions: MentionMessage[] = [];
  let page = 1;

  while (true) {
    const data = await slackFetchWithRetry<SearchMessagesResponse>(
      token,
      "search.messages",
      { query, count: "100", page: String(page) },
    );

    console.log(
      `  Page ${page}: ${data.messages.matches.length} matches (${data.messages.total} total)`,
    );

    for (const match of data.messages.matches) {
      if (parseFloat(match.ts) <= parseFloat(sinceTs)) continue;

      const mention: MentionMessage = {
        ts: match.ts,
        channelId: match.channel.id,
        channelName: `#${match.channel.name}`,
        userId: match.user,
        userName: resolveUserName(userMap, match.user),
        text: match.text,
        permalink: match.permalink,
      };

      if (match.thread_ts && match.thread_ts !== match.ts) {
        mention.thread = await fetchThread(token, match.channel.id, match.thread_ts, userMap);
      }

      mentions.push(mention);
    }

    if (page >= data.messages.paging.pages) break;
    page++;
  }

  return mentions;
}

async function fetchThread(
  token: string,
  channelId: string,
  threadTs: string,
  userMap: Map<string, string>,
): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  let cursor: string | undefined;

  while (true) {
    const params: Record<string, string> = { channel: channelId, ts: threadTs, limit: "200" };
    if (cursor) params.cursor = cursor;

    const data = await slackFetchWithRetry<ConversationsRepliesResponse>(
      token,
      "conversations.replies",
      params,
    );

    for (const msg of data.messages) {
      messages.push({
        ts: msg.ts,
        userId: msg.user ?? "unknown",
        userName: resolveUserName(userMap, msg.user ?? "unknown"),
        text: msg.text,
      });
    }

    cursor = data.response_metadata?.next_cursor;
    if (!cursor || !data.has_more) break;
  }

  return messages;
}

// ── Phase 2: Fetch channel history ───────────────────────────────────

async function fetchChannelHistory(
  token: string,
  channelId: string,
  sinceTs: string,
  userMap: Map<string, string>,
): Promise<DmMessage[]> {
  const messages: DmMessage[] = [];
  let cursor: string | undefined;

  while (true) {
    const params: Record<string, string> = {
      channel: channelId,
      oldest: sinceTs,
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const data = await slackFetchWithRetry<ConversationsHistoryResponse>(
      token,
      "conversations.history",
      params,
    );

    for (const msg of data.messages) {
      if (msg.subtype === "channel_join" || msg.subtype === "channel_leave") continue;
      messages.push({
        ts: msg.ts,
        userId: msg.user ?? "unknown",
        userName: resolveUserName(userMap, msg.user ?? "unknown"),
        text: msg.text,
      });
    }

    cursor = data.response_metadata?.next_cursor;
    if (!cursor || !data.has_more) break;
  }

  return messages;
}

// ── Write helpers ────────────────────────────────────────────────────

function writeChannelMessages(
  outputBase: string,
  ch: ActiveChannel,
  messages: DmMessage[],
): void {
  const subdir = ch.type === "im" || ch.type === "mpim" ? "dms" : "channels";
  const channelDir = resolve(outputBase, subdir, ch.id);
  mkdirSync(channelDir, { recursive: true });

  // Write _meta.json
  const meta: DmMeta = {
    userId: ch.userId ?? ch.id,
    userName: ch.name,
    channelId: ch.id,
  };
  writeFileSync(resolve(channelDir, "_meta.json"), JSON.stringify(meta, null, 2) + "\n");

  // Group by date and write
  const byDate = new Map<string, DmMessage[]>();
  for (const msg of messages) {
    const date = tsToDate(msg.ts);
    const existing = byDate.get(date) ?? [];
    existing.push(msg);
    byDate.set(date, existing);
  }

  for (const [date, msgs] of byDate) {
    const filePath = resolve(channelDir, `${date}.json`);
    const merged = mergeByTs(filePath, msgs);
    writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n");
  }
}

function writeMentions(outputBase: string, mentions: MentionMessage[]): void {
  if (mentions.length === 0) return;

  const mentionsDir = resolve(outputBase, "mentions");
  mkdirSync(mentionsDir, { recursive: true });

  const byDate = new Map<string, MentionMessage[]>();
  for (const mention of mentions) {
    const date = tsToDate(mention.ts);
    const existing = byDate.get(date) ?? [];
    existing.push(mention);
    byDate.set(date, existing);
  }

  for (const [date, msgs] of byDate) {
    const filePath = resolve(mentionsDir, `${date}.json`);
    const merged = mergeByTs(filePath, msgs);
    writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n");
    console.log(`  mentions/${date}.json: ${merged.length} messages`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function sevenDaysAgoEpoch(): number {
  return Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
}

function mergeByTs<T extends { ts: string }>(filePath: string, newMessages: T[]): T[] {
  let existing: T[] = [];
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8")) as T[];
    } catch { /* ignore */ }
  }

  const byTs = new Map<string, T>();
  for (const msg of existing) byTs.set(msg.ts, msg);
  for (const msg of newMessages) byTs.set(msg.ts, msg);

  return [...byTs.values()].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
}

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
