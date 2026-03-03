import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { refreshAccessToken, saveConfig } from "./config.js";
import type { Config, Account } from "./config.js";

// ── Constants ─────────────────────────────────────────────────────────

export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const BATCH_SIZE = 100;
export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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

export async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
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

// ── Phase 1.5: Clean up leaked files from blocked senders ──────────────

export function cleanupBlockedSenderFiles(config: Config, account: Account): void {
  const outputBase = resolve(PROJECT_ROOT, "output/gmail", account.email);
  if (!existsSync(outputBase)) return;

  const blockedSenders = new Set(
    (account.blockedSenders ?? []).map((s) => s.toLowerCase()),
  );
  if (blockedSenders.size === 0) return;

  console.log("Phase 1.5: Cleaning up files from blocked senders…");
  let cleaned = 0;

  const dateDirs = readdirSync(outputBase).filter((d) => d !== "index.json");
  for (const dateDir of dateDirs) {
    const dirPath = resolve(outputBase, dateDir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = resolve(dirPath, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const msg = JSON.parse(raw) as GmailMessage;
        const sender = extractSenderEmail(msg);
        if (sender && blockedSenders.has(sender)) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip malformed files
      }
    }

    // Remove empty date directories
    try {
      const remaining = readdirSync(dirPath);
      if (remaining.length === 0) {
        rmdirSync(dirPath);
      }
    } catch {
      // Ignore
    }
  }

  if (cleaned > 0) {
    console.log(`  Removed ${cleaned} file(s) from blocked senders`);
  } else {
    console.log("  No files to clean up");
  }
}

// ── Phase 2: Batch download + classify ─────────────────────────────────

export async function downloadAndClassify(
  config: Config,
  account: Account,
  messageIds: string[],
): Promise<void> {
  const outputBase = resolve(PROJECT_ROOT, "output/gmail", account.email);

  const blockedSenders = new Set(
    (account.blockedSenders ?? []).map((s) => s.toLowerCase()),
  );
  const approvedSenders = new Set(
    (account.approvedSenders ?? []).map((s) => s.toLowerCase()),
  );
  const knownSenders = new Set([...blockedSenders, ...approvedSenders]);

  if (!config.geminiApiKey) {
    console.log("Notice: geminiApiKey not set — sender classification disabled");
  }

  let totalSaved = 0;
  let totalSkipped = 0;
  let totalBlocked = 0;

  console.log(`Phase 2: Downloading messages in batches of ${BATCH_SIZE}`);

  for (let batchStart = 0; batchStart < messageIds.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, messageIds.length);
    const batch = messageIds.slice(batchStart, batchEnd);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(messageIds.length / BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches} (messages ${batchStart + 1}–${batchEnd})`);

    await refreshAccessToken(config, account);

    // IDs that passed pre-filter and need format=full download
    const fullDownloadIds: string[] = [];
    // IDs with no sender extracted — download full by default
    const noSenderIds: string[] = [];
    // Messages from unknown senders pending classification
    const pendingClassification: { id: string; sender: string }[] = [];
    // Map sender → { snippet, subject } for Gemini context
    const newSenderContext = new Map<string, { snippet: string; subject: string }>();
    let batchSaved = 0;
    let batchSkipped = 0;
    let batchBlocked = 0;

    // ── Pass 1: Metadata pre-filter ──
    // Filter out already-cached IDs first (pure local, fast)
    const uncachedIds: string[] = [];
    for (const id of batch) {
      if (messageExists(outputBase, id)) {
        batchSkipped++;
      } else {
        uncachedIds.push(id);
      }
    }

    // Fetch metadata concurrently for all uncached IDs
    const metadataResults = await withConcurrency(
      uncachedIds.map((id) => () =>
        gmailFetchWithRetry<GmailMessage>(
          config,
          account,
          `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        ).then((metadata) => ({ id, metadata })),
      ),
      10,
    );

    // Sort results into blocked/approved/unknown buckets
    for (const { id, metadata } of metadataResults) {
      const sender = extractSenderEmail(metadata);

      if (sender && blockedSenders.has(sender)) {
        batchBlocked++;
        continue;
      }

      if (sender && approvedSenders.has(sender)) {
        fullDownloadIds.push(id);
        continue;
      }

      if (sender) {
        pendingClassification.push({ id, sender });

        if (!newSenderContext.has(sender)) {
          const headers = metadata.payload?.headers ?? [];
          const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
          newSenderContext.set(sender, {
            snippet: metadata.snippet ?? "",
            subject,
          });
        }
      } else {
        noSenderIds.push(id);
      }
    }

    // ── Rule-based pre-filter: auto-block obviously automated senders ──
    let autoBlocked = 0;
    for (const sender of [...newSenderContext.keys()]) {
      if (isObviouslyAutomated(sender)) {
        blockedSenders.add(sender);
        knownSenders.add(sender);
        newSenderContext.delete(sender);
        autoBlocked++;
      }
    }
    if (autoBlocked > 0) {
      console.log(`    Auto-blocked ${autoBlocked} obviously automated sender(s)`);
    }

    // ── Classify remaining new senders with Gemini ──
    if (newSenderContext.size > 0 && config.geminiApiKey) {
      console.log(`    Classifying ${newSenderContext.size} new sender(s) with Gemini…`);
      const classification = await classifySenders(config.geminiApiKey, newSenderContext);

      if (classification) {
        for (const email of classification.spam) {
          blockedSenders.add(email);
          knownSenders.add(email);
        }
        for (const email of classification.legitimate) {
          approvedSenders.add(email);
          knownSenders.add(email);
        }

        console.log(
          `    → ${classification.spam.length} spam, ${classification.legitimate.length} legitimate`,
        );
      }
    } else if (newSenderContext.size > 0) {
      // No Gemini key — add to approved by default so they aren't re-evaluated
      for (const email of newSenderContext.keys()) {
        approvedSenders.add(email);
        knownSenders.add(email);
      }
    }

    // ── Sort pending into approved vs blocked after classification ──
    for (const { id, sender } of pendingClassification) {
      if (approvedSenders.has(sender)) {
        fullDownloadIds.push(id);
      } else {
        batchBlocked++;
      }
    }

    // ── Pass 2: Full download for approved messages only ──
    const idsToDownload = [...fullDownloadIds, ...noSenderIds];

    await withConcurrency(
      idsToDownload.map((id) => async () => {
        const message = await gmailFetchWithRetry<GmailMessage>(
          config,
          account,
          `/users/me/messages/${id}?format=full`,
        );
        if (message.payload) decodeMessageBodies(message.payload);
        saveMessage(outputBase, id, message);
        batchSaved++;
      }),
      10,
    );

    // Persist updated sender lists
    if (newSenderContext.size > 0 || autoBlocked > 0) {
      account.blockedSenders = [...blockedSenders];
      account.approvedSenders = [...approvedSenders];
      saveConfig(config);
    }

    totalSaved += batchSaved;
    totalSkipped += batchSkipped;
    totalBlocked += batchBlocked;

    console.log(
      `    ${batchSaved} saved, ${batchSkipped} skipped, ${batchBlocked} blocked`,
    );
  }

  console.log(
    `  Completed: ${totalSaved} saved, ${totalSkipped} skipped, ${totalBlocked} blocked`,
  );
}

// ── Rule-based pre-filter ──────────────────────────────────────────────

const AUTOMATED_LOCAL_PARTS = new Set([
  "no-reply", "noreply", "do-not-reply", "donotreply",
  "mailer-daemon", "postmaster",
]);

const AUTOMATED_LOCAL_PREFIXES = [
  "info@", "hello@", "news@", "notifications@", "updates@",
  "billing@", "admin@", "alert@", "noreply-",
];

const AUTOMATED_LOCAL_CONTAINS = [
  "support", "team", "marketing", "sales",
  "help", "service", "contact", "newsletter",
];

const AUTOMATED_DOMAINS = new Set([
  "amazonses.com", "sendgrid.net", "mailchimp.com",
  "mandrillapp.com", "facebookmail.com", "linkedin.com",
]);

export function isObviouslyAutomated(email: string): boolean {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return false;

  const local = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();

  if (AUTOMATED_LOCAL_PARTS.has(local)) return true;
  if (AUTOMATED_DOMAINS.has(domain)) return true;

  for (const prefix of AUTOMATED_LOCAL_PREFIXES) {
    // prefix includes '@', so check local + '@'
    if ((local + "@").startsWith(prefix)) return true;
  }

  for (const keyword of AUTOMATED_LOCAL_CONTAINS) {
    if (local.includes(keyword)) return true;
  }

  return false;
}

// ── Gemini classification ──────────────────────────────────────────────

export interface ClassificationResult {
  spam: string[];
  legitimate: string[];
}

export async function classifySenders(
  apiKey: string,
  senderContext: Map<string, { snippet: string; subject: string }>,
): Promise<ClassificationResult | null> {
  const entries: string[] = [];
  for (const [email, ctx] of senderContext) {
    entries.push(`- Email: ${email}\n  Subject: ${ctx.subject}\n  Snippet: ${ctx.snippet}`);
  }
  const senderList = entries.join("\n");

  const prompt = `You are a strict email filter. Your job is to identify whether each sender is a REAL HUMAN writing organically, or an automated/commercial sender.

Classify each sender as "spam" or "legitimate" based on the sender email, subject line, and message snippet.

## Rules (apply strictly)

SPAM — classify as spam if ANY of these apply:
- The local part (before @) is "no-reply", "noreply", "info", "hello", "news", "mailer", "notifications", "updates", "billing", "admin", "do-not-reply", "donotreply"
- The local part contains "support", "team", "marketing", "sales", "help", "service", "contact"
- The domain is a known commercial/SaaS domain (e.g. accounts.google.com, facebookmail.com, linkedin.com, github.com, amazonses.com, sendgrid.net, mailchimp.com, etc.)
- The subject or snippet looks like a newsletter, receipt, notification, security alert, promotional offer, or automated message
- The email is clearly machine-generated (tracking IDs, unsubscribe language, HTML-heavy snippets)

LEGITIMATE — classify as legitimate ONLY if:
- The sender appears to be a real individual human writing a personal or business message organically
- Personal email addresses (@gmail.com, @yahoo.com, @outlook.com, etc.) are generally more likely to be legitimate, but still check the subject/snippet for automated content
- The subject and snippet read like natural human writing (not templated, not promotional)

When in doubt, classify as spam. I'd rather miss a legitimate email than keep spam.

## Senders to classify

${senderList}

Respond with ONLY a JSON object in this exact format, no other text:
{"spam": ["email1@example.com"], "legitimate": ["email2@example.com"]}

Every sender must appear in exactly one list.`;

  try {
    const res = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`    Warning: Gemini API error (${res.status}): ${body}`);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn("    Warning: Gemini returned empty response");
      return null;
    }

    // Extract JSON from response (may be wrapped in ```json ... ```)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("    Warning: Could not parse Gemini response as JSON");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as ClassificationResult;

    // Normalize to lowercase
    return {
      spam: (parsed.spam ?? []).map((s) => s.toLowerCase()),
      legitimate: (parsed.legitimate ?? []).map((s) => s.toLowerCase()),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`    Warning: Gemini classification failed: ${message}`);
    return null;
  }
}
