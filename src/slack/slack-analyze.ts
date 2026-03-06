import { findWorkspace, saveWorkspace, type ActiveChannel } from "./config.js";
import {
  slackFetchWithRetry,
  buildUserMap,
  resolveUserName,
  formatDate,
  type SearchMessagesResponse,
  type UsersConversationsResponse,
} from "./slack-api.js";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const teamIdOrName = args.find((a) => !a.startsWith("--"));
  const sinceArg = args.find((a) => a.startsWith("--since:"))?.split(":")[1];

  if (!teamIdOrName) {
    console.error("Usage: pnpm slack:analyze <team-id-or-name> [--since:YYYY-MM-DD]");
    process.exit(1);
  }

  const workspace = findWorkspace(teamIdOrName);
  console.log(`Analyzing active channels for ${workspace.teamName} (${workspace.teamId})`);

  const token = workspace.accessToken;
  const userMap = await buildUserMap(token);

  // Default: look back 90 days
  const since = sinceArg ?? formatDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  console.log(`Searching messages from:me since ${since}…`);

  // Phase 1: Find channel IDs where user has sent messages
  const activeIds = await findActiveChannelIds(token, since);
  console.log(`Found messages in ${activeIds.size} channels`);

  // Phase 2: List all channels user is member of (to get type info and names)
  console.log("Fetching channel membership list…");
  const allChannels = await listAllChannels(token, userMap);
  console.log(`  Member of ${allChannels.length} channels/DMs total`);

  // Phase 3: Intersect
  const activeChannels: ActiveChannel[] = allChannels
    .filter((ch) => activeIds.has(ch.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Phase 4: Display
  console.log(`\nActive channels (${activeChannels.length}):`);
  const byType: Record<string, ActiveChannel[]> = {};
  for (const ch of activeChannels) {
    (byType[ch.type] ??= []).push(ch);
  }
  for (const [type, channels] of Object.entries(byType)) {
    console.log(`\n  [${type}]`);
    for (const ch of channels) {
      console.log(`    ${ch.name.padEnd(40)} ${ch.id}`);
    }
  }

  // Phase 5: Store in workspace config
  workspace.activeChannels = activeChannels;
  saveWorkspace(workspace);
  console.log(`\nSaved ${activeChannels.length} active channels to config.`);
}

// ── Phase 1: Find active channel IDs via search ───────────────────────

async function findActiveChannelIds(token: string, since: string): Promise<Set<string>> {
  const activeIds = new Set<string>();
  let page = 1;

  while (true) {
    const data = await slackFetchWithRetry<SearchMessagesResponse>(
      token,
      "search.messages",
      { query: `from:me after:${since}`, count: "100", page: String(page) },
    );

    for (const match of data.messages.matches) {
      activeIds.add(match.channel.id);
    }

    process.stdout.write(`  Page ${page}/${data.messages.paging.pages}: ${activeIds.size} unique channels so far\r`);

    if (page >= data.messages.paging.pages) break;
    page++;
  }
  process.stdout.write("\n");

  return activeIds;
}

// ── Phase 2: List all channels the user is a member of ───────────────

async function listAllChannels(
  token: string,
  userMap: Map<string, string>,
): Promise<ActiveChannel[]> {
  const channels: ActiveChannel[] = [];
  let cursor: string | undefined;

  while (true) {
    const params: Record<string, string> = {
      types: "public_channel,private_channel,im,mpim",
      limit: "200",
      exclude_archived: "true",
    };
    if (cursor) params.cursor = cursor;

    const data = await slackFetchWithRetry<UsersConversationsResponse>(
      token,
      "users.conversations",
      params,
    );

    for (const ch of data.channels) {
      if (ch.is_im && ch.user) {
        channels.push({
          id: ch.id,
          name: resolveUserName(userMap, ch.user),
          type: "im",
          userId: ch.user,
        });
      } else if (ch.is_mpim) {
        channels.push({
          id: ch.id,
          name: ch.name ?? ch.id,
          type: "mpim",
        });
      } else if (ch.is_private) {
        channels.push({
          id: ch.id,
          name: ch.name ?? ch.id,
          type: "private_channel",
        });
      } else {
        channels.push({
          id: ch.id,
          name: ch.name ?? ch.id,
          type: "public_channel",
        });
      }
    }

    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return channels;
}

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
