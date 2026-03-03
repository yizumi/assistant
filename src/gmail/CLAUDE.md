# Gmail Download Scripts

TypeScript scripts for downloading Gmail messages via the Gmail API. Uses OAuth 2.0 for authentication and stores messages as JSON files.

## Setup

1. Create a GCP project with the Gmail API enabled
2. Create OAuth 2.0 credentials (Desktop app type)
3. Set the redirect URI to `http://127.0.0.1:8484/callback`
4. Fill in `.config/gmail/config.json` with your `gcpClientId` and `gcpClientKey`

### Optional: Gemini sender classification

1. Enable "Generative Language API" in GCP console (APIs & Services > Library)
2. Create an API key (APIs & Services > Credentials > Create Credentials > API Key)
3. Add `"geminiApiKey": "YOUR_KEY"` to `.config/gmail/config.json`

No OAuth changes needed — Gemini uses API keys, not OAuth. The Gmail API scope (`gmail.readonly`) stays the same.

## Usage

```bash
# Connect a Gmail account (opens browser for OAuth consent)
pnpm gmail:accounts:add user@gmail.com

# Download messages (last 6 months, with optional spam filtering)
pnpm gmail:pull user@gmail.com

# Unblock a sender (move from blockedSenders to approvedSenders and backfill messages)
pnpm gmail:unblock user@gmail.com sender@example.com
```

## Config

`config.json` fields:

| Field | Level | Description |
|-------|-------|-------------|
| `gcpClientId` | top | OAuth client ID |
| `gcpClientKey` | top | OAuth client secret |
| `geminiApiKey` | top | Optional. Gemini API key for sender classification |
| `email` | account | Gmail address |
| `accessToken` | account | OAuth access token (auto-managed) |
| `refreshToken` | account | OAuth refresh token |
| `accessTokenExpiresAt` | account | Token expiry (auto-managed) |
| `blockedSenders` | account | Auto-populated. Senders classified as spam/mailing-list |
| `approvedSenders` | account | Auto-populated. Senders classified as legitimate |

## File Structure

- `src/gmail/config.ts` — Shared types and helpers (config I/O, token refresh)
- `src/gmail/gmail-api.ts` — Shared Gmail API helpers (fetch, message I/O, index builder, types)
- `src/gmail/gmail-accounts-add.ts` — OAuth account connection with inline HTTP callback server
- `src/gmail/gmail-pull.ts` — Message download (list, batch download, classify, index)
- `src/gmail/gmail-unblock.ts` — Unblock a sender (move from blocked→approved, backfill messages)

## Output

Messages are saved to `output/gmail/{email}/yyyy-MM-dd/{messageId}.json` with an `index.json` at the account root containing Subject/From/date for fast lookups.

## Behavior

### Date filter
Only messages from the last 6 months are fetched (via Gmail API `q=after:YYYY/MM/DD`).

### Batch processing
Messages are downloaded in batches of 100. Token is refreshed before each batch.

### Sender classification (requires `geminiApiKey`)
After each batch, new senders (not in `blockedSenders` or `approvedSenders`) are sent to Gemini for classification. Senders classified as spam are added to `blockedSenders` — their messages are discarded (not saved to disk). Legitimate senders go to `approvedSenders`. Both lists persist in `config.json` across batches and runs, so Gemini only classifies truly new senders.

If `geminiApiKey` is not set, classification is skipped and the script works as a plain downloader with the 6-month filter.

If Gemini fails (network error, API error), a warning is logged and the batch continues without classification.

## Design

- Zero runtime dependencies — uses only Node.js built-ins + native `fetch`
- Idempotent — existing files are skipped, safe to interrupt and resume
- Scope: `gmail.readonly` (read-only access)
- Tokens are auto-refreshed when within 5 minutes of expiry
