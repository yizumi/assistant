import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { loadConfig, saveConfig } from "./config.js";
import type { Account } from "./config.js";

const REDIRECT_URI = "http://127.0.0.1:8484/callback";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: pnpm gmail:accounts:add <email>");
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.gcpClientId || !config.gcpClientKey) {
    console.error(
      "Error: gcpClientId and gcpClientKey must be set in .config/gmail/config.json",
    );
    process.exit(1);
  }

  // Start callback server, open browser, wait for authorization code
  const code = await waitForCallback();

  // Exchange the code for tokens
  const tokens = await exchangeCodeForTokens(
    code,
    config.gcpClientId,
    config.gcpClientKey,
  );

  // Update config
  const account: Account = {
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString(),
  };

  const existingIndex = config.accounts.findIndex((a) => a.email === email);
  if (existingIndex >= 0) {
    config.accounts[existingIndex] = account;
    console.log(`Updated existing account: ${email}`);
  } else {
    config.accounts.push(account);
    console.log(`Added new account: ${email}`);
  }

  saveConfig(config);
  console.log("Tokens saved to .config/gmail/config.json");
}

// ── Auth URL ───────────────────────────────────────────────────────────

function buildAuthUrl(clientId: string, loginHint: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    login_hint: loginHint,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Inline callback server ─────────────────────────────────────────────

function waitForCallback(): Promise<string> {
  const config = loadConfig();
  const email = process.argv[2]!;
  const authUrl = buildAuthUrl(config.gcpClientId, email);

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for OAuth callback (120s)"));
    }, 120_000);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h1>OAuth Error</h1><p>${error}</p><p>You can close this tab.</p>`);
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end("Missing code parameter");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>",
      );
      clearTimeout(timeout);
      server.close();
      resolve(code);
    });

    server.listen(8484, "127.0.0.1", () => {
      console.log("Listening on http://127.0.0.1:8484/callback");
      console.log("Opening browser for OAuth consent…");
      try {
        execSync(`open "${authUrl}"`);
      } catch {
        console.log("Could not open browser automatically. Open this URL:");
        console.log(authUrl);
      }
    });
  });
}

// ── Token exchange ─────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  return (await res.json()) as TokenResponse;
}

// ── Run ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
