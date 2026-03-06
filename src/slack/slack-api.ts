import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────

export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const SLACK_API = "https://slack.com/api";

// ── Types ─────────────────────────────────────────────────────────────

export interface SearchMatch {
  ts: string;
  text: string;
  channel: { id: string; name: string };
  user: string;
  permalink: string;
  thread_ts?: string;
}

export interface SearchMessagesResponse {
  ok: boolean;
  error?: string;
  messages: {
    total: number;
    matches: SearchMatch[];
    paging: { count: number; total: number; page: number; pages: number };
  };
}

export interface ConversationChannel {
  id: string;
  user?: string;       // For IMs, the other user's ID
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  name?: string;
  created?: number;    // Unix timestamp of when the channel was created
}

export interface ConversationsInfoResponse {
  ok: boolean;
  error?: string;
  channel: ConversationChannel;
}

export interface UsersConversationsResponse {
  ok: boolean;
  error?: string;
  channels: ConversationChannel[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackMessage {
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
}

export interface ConversationsHistoryResponse {
  ok: boolean;
  error?: string;
  messages: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface ConversationsRepliesResponse {
  ok: boolean;
  error?: string;
  messages: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
  deleted?: boolean;
  is_bot?: boolean;
}

export interface UsersListResponse {
  ok: boolean;
  error?: string;
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
}

// ── Index types ───────────────────────────────────────────────────────

export interface SlackIndexEntry {
  type: "mention" | "dm" | "channel";
  ts: string;
  date: string;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  text: string;
  file: string;
}

// ── Output message types ──────────────────────────────────────────────

export interface MentionMessage {
  ts: string;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  text: string;
  permalink: string;
  thread?: ThreadMessage[];
}

export interface ThreadMessage {
  ts: string;
  userId: string;
  userName: string;
  text: string;
}

export interface DmMessage {
  ts: string;
  userId: string;
  userName: string;
  text: string;
}

export interface DmMeta {
  userId: string;
  userName: string;
  channelId: string;
}

// ── Rate limit error ─────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super(`Rate limited, retry after ${retryAfter}s`);
  }
}

// ── Slack API helpers ────────────────────────────────────────────────

export async function slackFetch<T>(
  token: string,
  method: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${SLACK_API}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "30", 10);
    throw new RateLimitError(retryAfter);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack API HTTP error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data;
}

export async function slackFetchWithRetry<T>(
  token: string,
  method: string,
  params?: Record<string, string>,
  maxRetries = 5,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await slackFetch<T>(token, method, params);
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.log(`  Rate limited, waiting ${err.retryAfter}s…`);
        await sleep(err.retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${method}`);
}

// ── User resolution ──────────────────────────────────────────────────

export async function buildUserMap(
  token: string,
): Promise<Map<string, string>> {
  const users = new Map<string, string>();
  let cursor: string | undefined;

  console.log("Building user map…");

  while (true) {
    const params: Record<string, string> = { limit: "200" };
    if (cursor) params.cursor = cursor;

    const data = await slackFetchWithRetry<UsersListResponse>(
      token,
      "users.list",
      params,
    );

    for (const member of data.members) {
      const name =
        member.profile?.display_name ||
        member.real_name ||
        member.name ||
        member.id;
      users.set(member.id, name);
    }

    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  console.log(`  Resolved ${users.size} users`);
  return users;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function tsToDate(ts: string): string {
  const epochMs = parseFloat(ts) * 1000;
  return formatDate(new Date(epochMs));
}

export function resolveUserName(
  userMap: Map<string, string>,
  userId: string,
): string {
  return userMap.get(userId) ?? userId;
}

// ── Index builder ────────────────────────────────────────────────────

export function buildIndex(teamId: string): void {
  const outputBase = resolve(PROJECT_ROOT, "output/slack", teamId);
  if (!existsSync(outputBase)) {
    console.log("No messages to index");
    return;
  }

  console.log("Building index…");
  const entries: SlackIndexEntry[] = [];

  // Index mentions
  const mentionsDir = resolve(outputBase, "mentions");
  if (existsSync(mentionsDir)) {
    const files = readdirSync(mentionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(mentionsDir, file), "utf-8");
        const messages = JSON.parse(raw) as MentionMessage[];
        const date = file.replace(".json", "");
        for (const msg of messages) {
          entries.push({
            type: "mention",
            ts: msg.ts,
            date,
            channelId: msg.channelId,
            channelName: msg.channelName,
            userId: msg.userId,
            userName: msg.userName,
            text: msg.text.slice(0, 200),
            file: `mentions/${file}`,
          });
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  // Index DMs
  const dmsDir = resolve(outputBase, "dms");
  if (existsSync(dmsDir)) {
    const userDirs = readdirSync(dmsDir);
    for (const userDir of userDirs) {
      const userDirPath = resolve(dmsDir, userDir);
      // Read meta for channel/user info
      let meta: DmMeta | undefined;
      const metaPath = resolve(userDirPath, "_meta.json");
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf-8")) as DmMeta;
        } catch {
          // ignore
        }
      }

      const files = readdirSync(userDirPath).filter(
        (f) => f.endsWith(".json") && f !== "_meta.json",
      );
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(userDirPath, file), "utf-8");
          const messages = JSON.parse(raw) as DmMessage[];
          const date = file.replace(".json", "");
          for (const msg of messages) {
            entries.push({
              type: "dm",
              ts: msg.ts,
              date,
              channelId: meta?.channelId ?? userDir,
              channelName: meta?.userName ?? userDir,
              userId: msg.userId,
              userName: msg.userName,
              text: msg.text.slice(0, 200),
              file: `dms/${userDir}/${file}`,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    }
  }

  // Index channels (public/private)
  const channelsDir = resolve(outputBase, "channels");
  if (existsSync(channelsDir)) {
    const channelDirs = readdirSync(channelsDir);
    for (const channelDir of channelDirs) {
      const channelDirPath = resolve(channelsDir, channelDir);
      let meta: DmMeta | undefined;
      const metaPath = resolve(channelDirPath, "_meta.json");
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf-8")) as DmMeta;
        } catch { /* ignore */ }
      }
      const files = readdirSync(channelDirPath).filter(
        (f) => f.endsWith(".json") && f !== "_meta.json",
      );
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(channelDirPath, file), "utf-8");
          const messages = JSON.parse(raw) as DmMessage[];
          const date = file.replace(".json", "");
          for (const msg of messages) {
            entries.push({
              type: "channel",
              ts: msg.ts,
              date,
              channelId: meta?.channelId ?? channelDir,
              channelName: meta?.userName ?? channelDir,
              userId: msg.userId,
              userName: msg.userName,
              text: msg.text.slice(0, 200),
              file: `channels/${channelDir}/${file}`,
            });
          }
        } catch { /* ignore */ }
      }
    }
  }

  entries.sort((a, b) => {
    const tsA = parseFloat(a.ts);
    const tsB = parseFloat(b.ts);
    return tsB - tsA; // Descending
  });

  writeFileSync(
    resolve(outputBase, "index.json"),
    JSON.stringify(entries, null, 2) + "\n",
  );

  console.log(`  Indexed ${entries.length} messages`);
}
