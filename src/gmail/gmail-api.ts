import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { refreshAccessToken } from "./config.js";
import type { Config, Account } from "./config.js";

// ── Constants ─────────────────────────────────────────────────────────

export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const BATCH_SIZE = 100;

// ── Types ─────────────────────────────────────────────────────────────

export interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
  [key: string]: unknown;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart & {
    headers?: { name: string; value: string }[];
  };
  [key: string]: unknown;
}

export interface MessagesListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface IndexEntry {
  id: string;
  date: string;
  from: string;
  subject: string;
  file: string;
}

// ── Gmail API helpers ─────────────────────────────────────────────────

export async function gmailFetch<T>(
  config: Config,
  account: Account,
  path: string,
): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });

  if (res.status === 401) {
    await refreshAccessToken(config, account);
    const retry = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    if (!retry.ok) {
      const body = await retry.text();
      throw new Error(`Gmail API error (${retry.status}): ${body}`);
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${body}`);
  }

  return (await res.json()) as T;
}

export async function gmailFetchWithRetry<T>(
  config: Config,
  account: Account,
  path: string,
  maxRetries = 5,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await gmailFetch<T>(config, account, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("429")) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  Rate limited, waiting ${delay / 1000}s…`);
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw new Error(`Failed after ${maxRetries} retries: ${path}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Message helpers ───────────────────────────────────────────────────

export function messageExists(outputBase: string, id: string): boolean {
  if (!existsSync(outputBase)) return false;

  try {
    const dateDirs = readdirSync(outputBase);
    for (const dateDir of dateDirs) {
      const filePath = resolve(outputBase, dateDir, `${id}.json`);
      if (existsSync(filePath)) return true;
    }
  } catch {
    // Directory doesn't exist yet
  }

  return false;
}

export function extractSenderEmail(message: GmailMessage): string | null {
  const fromHeader = message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === "from",
  );
  if (!fromHeader?.value) return null;

  const value = fromHeader.value;

  // Match <user@domain.com> pattern
  const angleMatch = value.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase();

  // Bare email
  const bareMatch = value.match(/[\w.+-]+@[\w.-]+/);
  if (bareMatch) return bareMatch[0].toLowerCase();

  return null;
}

export function extractDate(message: GmailMessage): string {
  if (message.internalDate) {
    return formatDate(new Date(parseInt(message.internalDate, 10)));
  }

  const dateHeader = message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === "date",
  );
  if (dateHeader?.value) {
    const parsed = new Date(dateHeader.value);
    if (!isNaN(parsed.getTime())) {
      return formatDate(parsed);
    }
  }

  return "unknown-date";
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function decodeMessageBodies(part: GmailMessagePart): void {
  if (part.body?.data) {
    const mimeType = part.mimeType ?? "";
    // Only decode text/* content (text/plain, text/html, etc.)
    if (mimeType.startsWith("text/") || mimeType === "") {
      try {
        part.body.data = Buffer.from(part.body.data, "base64url").toString("utf-8");
      } catch {
        // Leave as-is if decoding fails
      }
    }
  }
  if (part.parts) {
    for (const child of part.parts) {
      decodeMessageBodies(child);
    }
  }
}

export function saveMessage(outputBase: string, id: string, message: GmailMessage): void {
  const dateStr = extractDate(message);
  const dir = resolve(outputBase, dateStr);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(message, null, 2));
}

// ── Date filter ───────────────────────────────────────────────────────

export function sixMonthsAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

// ── Index builder ─────────────────────────────────────────────────────

export function buildIndex(email: string): void {
  const outputBase = resolve(PROJECT_ROOT, "output/gmail", email);
  if (!existsSync(outputBase)) {
    console.log("No messages to index");
    return;
  }

  console.log("Building index…");
  const entries: IndexEntry[] = [];

  const dateDirs = readdirSync(outputBase).filter(
    (d) => d !== "index.json",
  );

  for (const dateDir of dateDirs) {
    const dirPath = resolve(outputBase, dateDir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const raw = readFileSync(resolve(dirPath, file), "utf-8");
        const msg = JSON.parse(raw) as GmailMessage;
        const headers = msg.payload?.headers ?? [];

        const subject =
          headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
        const from =
          headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";

        entries.push({
          id: msg.id,
          date: dateDir,
          from,
          subject,
          file: `${dateDir}/${file}`,
        });
      } catch {
        // Skip malformed files
      }
    }
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));

  writeFileSync(
    resolve(outputBase, "index.json"),
    JSON.stringify(entries, null, 2) + "\n",
  );

  console.log(`  Indexed ${entries.length} messages`);
}
