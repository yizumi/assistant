import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveConfig, findAccount } from "./config.js";
import {
  PROJECT_ROOT, extractSenderEmail, buildIndex,
  type GmailMessage,
} from "./gmail-api.js";

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const accountEmail = process.argv[2];
  const senderEmail = process.argv[3];

  if (!accountEmail || !senderEmail) {
    console.error("Usage: pnpm gmail:block <account-email> <sender-email>");
    process.exit(1);
  }

  const config = loadConfig();
  const account = findAccount(config, accountEmail);

  // Validate sender is in approvedSenders
  const approvedSenders = account.approvedSenders ?? [];
  const senderLower = senderEmail.toLowerCase();
  const approvedIndex = approvedSenders.findIndex((s) => s.toLowerCase() === senderLower);

  if (approvedIndex === -1) {
    console.error(`Error: "${senderEmail}" is not in approvedSenders for ${accountEmail}`);
    const sample = approvedSenders.slice(0, 5).join(", ");
    if (approvedSenders.length > 0) {
      console.error(`Approved senders (${approvedSenders.length} total): ${sample}${approvedSenders.length > 5 ? ", …" : ""}`);
    }
    process.exit(1);
  }

  // Move from approvedSenders to blockedSenders
  approvedSenders.splice(approvedIndex, 1);
  account.approvedSenders = approvedSenders;

  const blockedSenders = account.blockedSenders ?? [];
  if (!blockedSenders.some((s) => s.toLowerCase() === senderLower)) {
    blockedSenders.push(senderEmail.toLowerCase());
    account.blockedSenders = blockedSenders;
  }

  saveConfig(config);
  console.log(`Moved "${senderEmail}" from approvedSenders to blockedSenders`);

  // Delete saved messages from this sender
  const outputBase = resolve(PROJECT_ROOT, "output/gmail", accountEmail);
  let deleted = 0;

  if (existsSync(outputBase)) {
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
          if (sender && sender === senderLower) {
            unlinkSync(filePath);
            deleted++;
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
  }

  console.log(`Deleted ${deleted} message file(s)`);

  // Rebuild index
  buildIndex(accountEmail);
  console.log("Done!");
}

// ── Run ────────────────────────────────────────────────────────────────

main();
