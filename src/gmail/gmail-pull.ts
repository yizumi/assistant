import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveConfig, findAccount, refreshAccessToken } from "./config.js";
import type { Config, Account } from "./config.js";
import {
  PROJECT_ROOT, GMAIL_API, BATCH_SIZE,
  gmailFetch, gmailFetchWithRetry, sleep,
  messageExists, extractSenderEmail, decodeMessageBodies, saveMessage, buildIndex, sixMonthsAgo,
  type GmailMessage, type MessagesListResponse,
} from "./gmail-api.js";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: pnpm gmail:pull <email>");
    process.exit(1);
  }

  const config = loadConfig();
  const account = findAccount(config, email);

  await refreshAccessToken(config, account);

  // Phase 1: List message IDs (last 6 months)
  const messageIds = await listAllMessageIds(config, account);
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
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let page = 0;

  const after = sixMonthsAgo();
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

// ── Phase 1.5: Clean up leaked files from blocked senders ──────────────

function cleanupBlockedSenderFiles(config: Config, account: Account): void {
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

interface PendingMessage {
  id: string;
  sender: string;
  message: GmailMessage;
}

async function downloadAndClassify(
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

    // Messages from unknown senders held in memory until classified
    const pending: PendingMessage[] = [];
    // Map sender → { snippet, subject } for Gemini context
    const newSenderContext = new Map<string, { snippet: string; subject: string }>();
    let batchSaved = 0;
    let batchSkipped = 0;
    let batchBlocked = 0;

    for (const id of batch) {
      // Skip if already downloaded
      if (messageExists(outputBase, id)) {
        batchSkipped++;
        continue;
      }

      // Download message
      const message = await gmailFetchWithRetry<GmailMessage>(
        config,
        account,
        `/users/me/messages/${id}?format=full`,
      );

      const sender = extractSenderEmail(message);

      // Known blocked sender → discard immediately
      if (sender && blockedSenders.has(sender)) {
        batchBlocked++;
        await sleep(100);
        continue;
      }

      // Known approved sender → decode + save immediately
      if (sender && approvedSenders.has(sender)) {
        if (message.payload) decodeMessageBodies(message.payload);
        saveMessage(outputBase, id, message);
        batchSaved++;
        await sleep(100);
        continue;
      }

      // Unknown sender → buffer in memory, track for classification
      if (sender) {
        pending.push({ id, sender, message });

        if (!newSenderContext.has(sender)) {
          const headers = message.payload?.headers ?? [];
          const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
          newSenderContext.set(sender, {
            snippet: message.snippet ?? "",
            subject,
          });
        }
      } else {
        // No sender extracted — save by default
        if (message.payload) decodeMessageBodies(message.payload);
        saveMessage(outputBase, id, message);
        batchSaved++;
      }

      await sleep(100);
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

    // ── Flush pending messages: save approved, discard blocked ──
    for (const { id, sender, message } of pending) {
      if (approvedSenders.has(sender)) {
        if (message.payload) decodeMessageBodies(message.payload);
        saveMessage(outputBase, id, message);
        batchSaved++;
      } else {
        batchBlocked++;
      }
    }

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

function isObviouslyAutomated(email: string): boolean {
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

interface ClassificationResult {
  spam: string[];
  legitimate: string[];
}

async function classifySenders(
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

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
