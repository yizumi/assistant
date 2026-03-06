import { findWorkspace } from "./config.js";
import {
  slackFetchWithRetry,
  sleep,
  formatDate,
  type UsersConversationsResponse,
  type SearchMessagesResponse,
} from "./slack-api.js";

// ── Types ─────────────────────────────────────────────────────────────

interface LeaveResponse {
  ok: boolean;
  error?: string;
}

// ── Duration parsing ──────────────────────────────────────────────────

function parseDuration(value: string): Date {
  const match = value.match(/^(\d+)([dDwWmM])$/);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use e.g. 3m, 2w, 7d`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = new Date();

  switch (unit) {
    case "d":
      now.setDate(now.getDate() - amount);
      break;
    case "w":
      now.setDate(now.getDate() - amount * 7);
      break;
    case "m":
      now.setMonth(now.getMonth() - amount);
      break;
  }

  return now;
}

// ── Active channel detection ──────────────────────────────────────────

async function findActiveChannels(
  token: string,
  afterDate: Date,
): Promise<Set<string>> {
  const activeIds = new Set<string>();
  const dateStr = formatDate(afterDate);
  const query = `from:me after:${dateStr}`;
  let page = 1;

  console.log(`Searching messages: "${query}"`);

  while (true) {
    const data = await slackFetchWithRetry<SearchMessagesResponse>(
      token,
      "search.messages",
      { query, count: "100", page: String(page) },
    );

    for (const match of data.messages.matches) {
      activeIds.add(match.channel.id);
    }

    if (page >= data.messages.paging.pages) break;
    page++;
  }

  console.log(`  Found activity in ${activeIds.size} channels since ${dateStr}`);
  return activeIds;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const teamIdOrName = args.find((a) => !a.startsWith("--"));
  const execute = args.includes("--execute");

  const inactiveArg = args.find((a) => a.startsWith("--inactive"))?.split(" ")[0];
  const inactiveIdx = args.indexOf("--inactive");
  const inactiveVal = inactiveIdx >= 0 ? args[inactiveIdx + 1] : undefined;

  const joinedBeforeIdx = args.indexOf("--joined-before");
  const joinedBeforeVal = joinedBeforeIdx >= 0 ? args[joinedBeforeIdx + 1] : undefined;

  if (!teamIdOrName || !inactiveVal) {
    console.error("Usage: pnpm slack:leave <team-id-or-name> --inactive <duration> [--joined-before <duration>] [--execute]");
    console.error("");
    console.error("  --inactive <duration>        Leave channels where you haven't spoken in this period");
    console.error("  --joined-before <duration>   Only leave channels created before this duration ago");
    console.error("  --execute                    Actually leave the channels (default: dry-run)");
    console.error("");
    console.error("  Duration format: 3m (months), 2w (weeks), 7d (days)");
    process.exit(1);
  }

  const inactiveCutoff = parseDuration(inactiveVal);
  const joinedBeforeCutoff = joinedBeforeVal ? parseDuration(joinedBeforeVal) : undefined;

  const workspace = findWorkspace(teamIdOrName);
  console.log(`Checking channels to leave for ${workspace.teamName} (${workspace.teamId})`);

  // Fetch all public channels the user is a member of
  const allChannels = await listMemberChannels(workspace.accessToken);
  console.log(`Member of ${allChannels.length} public channels`);

  // Find channels where user has been active
  const activeIds = await findActiveChannels(workspace.accessToken, inactiveCutoff);

  // Filter: channels not in activeIds
  let toLeave = allChannels.filter((ch) => !activeIds.has(ch.id));

  // If --joined-before: further filter to channels created before cutoff
  if (joinedBeforeCutoff) {
    const cutoffTs = joinedBeforeCutoff.getTime() / 1000;
    toLeave = toLeave.filter((ch) => ch.created !== undefined && ch.created < cutoffTs);
    console.log(`\nFilter: channel created before ${formatDate(joinedBeforeCutoff)} (proxy for join date)`);
  }

  const toKeep = allChannels.filter((ch) => activeIds.has(ch.id));

  console.log(`\nActive (keeping): ${toKeep.length}`);
  console.log(`Inactive: ${toLeave.length}`);

  if (toLeave.length === 0) {
    console.log("\nNothing to leave.");
    return;
  }

  // Display what will be left
  console.log(`\nChannels to leave${execute ? "" : " (dry-run)"}:`);
  for (const ch of toLeave) {
    const createdStr = ch.created
      ? `  (created ${new Date(ch.created * 1000).toISOString().slice(0, 10)})`
      : "";
    console.log(`  #${ch.name}${createdStr}`);
  }

  if (!execute) {
    console.log(`\nDry-run: no changes made.`);
    console.log(`Run with --execute to actually leave ${toLeave.length} channels.`);
    return;
  }

  // Actually leave
  console.log(`\nLeaving ${toLeave.length} channels…`);
  let left = 0;
  let failed = 0;

  for (let i = 0; i < toLeave.length; i++) {
    const ch = toLeave[i];
    if (i > 0) await sleep(1200); // ~50 req/min, under Tier 2 limit

    try {
      await slackFetchWithRetry<LeaveResponse>(
        workspace.accessToken,
        "conversations.leave",
        { channel: ch.id },
      );
      console.log(`  ✓ Left #${ch.name}`);
      left++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Failed #${ch.name}: ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone: left ${left} channels, ${failed} failed.`);
}

// ── Helpers ──────────────────────────────────────────────────────────

async function listMemberChannels(
  token: string,
): Promise<{ id: string; name: string; created?: number }[]> {
  const channels: { id: string; name: string; created?: number }[] = [];
  let cursor: string | undefined;

  while (true) {
    const params: Record<string, string> = {
      types: "public_channel",
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
      if (ch.name) {
        channels.push({ id: ch.id, name: ch.name, created: ch.created });
      }
    }

    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
