import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = resolve(import.meta.dirname, ".env");
const WAROOM_API = "https://api.app.waroom.com/api/v0";
const PER_PAGE = 100;

// ── Types ─────────────────────────────────────────────────────────────

interface Incident {
  uuid: string;
  title: string;
  created_at: string;
  [key: string]: unknown;
}

interface IncidentsResponse {
  incidents: Incident[];
  response_metadata: {
    next_page: number | null;
  };
}

interface IncidentDetail {
  uuid: string;
  title: string;
  created_at: string;
  [key: string]: unknown;
}

// ── Config ────────────────────────────────────────────────────────────

function loadApiKey(): string {
  if (process.env.WAROOM_API_KEY) return process.env.WAROOM_API_KEY;

  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) continue;
      const match = trimmed.match(/^WAROOM_API_KEY\s*=\s*(.+)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  throw new Error(
    "WAROOM_API_KEY is not set (check src/waroom/.env or environment)",
  );
}

// ── API helpers ───────────────────────────────────────────────────────

async function waroomFetch<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${WAROOM_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Waroom API error (${res.status}): ${body}`);
  }

  return (await res.json()) as T;
}

// ── Date helpers ──────────────────────────────────────────────────────

function parseMonth(arg: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(arg)) {
    throw new Error("Argument must be in YYYY-MM format (e.g. 2026-01)");
  }

  const [yearStr, monthStr] = arg.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const from = `${arg}-01`;

  // Last day of the month
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${arg}-${String(lastDay).padStart(2, "0")}`;

  return { from, to };
}

function sanitizeTitle(title: string): string {
  return title.replace(/[\/\\:*?"<>|]/g, "-").slice(0, 80);
}

// ── Incremental pull: find latest local date ──────────────────────────

function getLatestLocalMonth(): string | null {
  const outputBase = resolve(PROJECT_ROOT, "output/waroom");
  if (!existsSync(outputBase)) return null;

  const monthDirs = readdirSync(outputBase)
    .filter((d) => /^\d{4}-\d{2}$/.test(d))
    .sort();

  return monthDirs.length > 0 ? monthDirs[monthDirs.length - 1] : null;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let targetMonth = args[0];

  // If no argument, use incremental mode: pull latest local month + current month
  if (!targetMonth) {
    const latest = getLatestLocalMonth();
    if (!latest) {
      console.error("Usage: pnpm waroom:pull [YYYY-MM]");
      console.error(
        "No local data found. Provide a month to start (e.g. 2026-01).",
      );
      process.exit(1);
    }
    // Pull from latest local month onward
    targetMonth = latest;
    console.log(`Incremental pull: starting from ${targetMonth}`);
  }

  const apiKey = loadApiKey();

  // Determine which months to pull
  const months = getMonthRange(targetMonth);

  for (const month of months) {
    await pullMonth(apiKey, month);
  }

  console.log("Done!");
}

function getMonthRange(startMonth: string): string[] {
  const months: string[] = [];
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let cursor = startMonth;
  while (cursor <= currentMonth) {
    months.push(cursor);
    // Advance to next month
    const [y, m] = cursor.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    cursor = next;
  }

  return months;
}

async function pullMonth(apiKey: string, targetMonth: string): Promise<void> {
  const { from, to } = parseMonth(targetMonth);
  const outDir = resolve(PROJECT_ROOT, "output/waroom", targetMonth);
  mkdirSync(outDir, { recursive: true });

  console.log(`\nFetching incidents for ${targetMonth} (${from} to ${to})…`);

  // Phase 1: Collect incident UUIDs for the target month
  const uuids: string[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      from,
      to,
      page: String(page),
      per_page: String(PER_PAGE),
    });

    const data = await waroomFetch<IncidentsResponse>(
      apiKey,
      `/incidents?${params}`,
    );

    for (const incident of data.incidents) {
      if (incident.created_at.startsWith(targetMonth)) {
        uuids.push(incident.uuid);
      }
    }

    // Stop if we've passed the target month (desc order)
    const hasOlder = data.incidents.some(
      (i) => i.created_at < `${targetMonth}-01`,
    );
    if (hasOlder) break;

    if (!data.response_metadata.next_page) break;
    page++;
  }

  if (uuids.length === 0) {
    console.log(`  No incidents found for ${targetMonth}.`);
    return;
  }

  console.log(`  Found ${uuids.length} incident(s). Downloading details…`);

  // Phase 2: Download details for each incident
  let count = 0;
  for (const uuid of uuids) {
    count++;

    const detail = await waroomFetch<IncidentDetail>(
      apiKey,
      `/incidents/${uuid}`,
    );

    const fileDate = detail.created_at.slice(0, 10);
    const safeTitle = sanitizeTitle(detail.title);
    const filename = `${fileDate}_${safeTitle}.json`;

    console.log(`  [${count}/${uuids.length}] ${filename}`);
    writeFileSync(
      resolve(outDir, filename),
      JSON.stringify(detail, null, 2) + "\n",
    );
  }

  console.log(`  ${uuids.length} files saved to output/waroom/${targetMonth}/`);
}

// ── Run ──────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
