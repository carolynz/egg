import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { createServer } from "http";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { google } from "googleapis";

// ── Constants ────────────────────────────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const CALLBACK_PORT = 4322;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

// ── Config ───────────────────────────────────────────────────────────────────

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  const configPath = join(homedir(), ".egg", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const g = cfg?.google as Record<string, unknown> | undefined;
      if (typeof g?.clientId === "string" && typeof g?.clientSecret === "string") {
        return { clientId: g.clientId, clientSecret: g.clientSecret };
      }
    } catch {}
  }

  return null;
}

// ── Token storage (multi-account) ────────────────────────────────────────────

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
  email: string;      // account identifier
}

const GOOGLE_TOKENS_FILE = join(homedir(), ".egg", "google-tokens.json");

export function loadAllAccounts(): GoogleTokens[] {
  try {
    const data = JSON.parse(readFileSync(GOOGLE_TOKENS_FILE, "utf-8"));
    if (Array.isArray(data)) return data as GoogleTokens[];
    // Migrate from single-object format if needed
    if (data && typeof data === "object" && "access_token" in data) return [data as GoogleTokens];
    return [];
  } catch {
    return [];
  }
}

function saveAllAccounts(accounts: GoogleTokens[]): void {
  mkdirSync(join(homedir(), ".egg"), { recursive: true });
  writeFileSync(GOOGLE_TOKENS_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

function upsertAccount(tokens: GoogleTokens): void {
  const accounts = loadAllAccounts();
  const idx = accounts.findIndex((a) => a.email === tokens.email);
  if (idx >= 0) {
    accounts[idx] = tokens;
  } else {
    accounts.push(tokens);
  }
  saveAllAccounts(accounts);
}

// ── Logging ──────────────────────────────────────────────────────────────────

const GOOGLE_LOG = join(homedir(), ".egg", "logs", "google.log");

export function logGoogle(message: string): void {
  console.log(`[google] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(GOOGLE_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

// ── OAuth2 client factory ────────────────────────────────────────────────────

export function createOAuth2Client(config: GoogleOAuthConfig) {
  return new google.auth.OAuth2(config.clientId, config.clientSecret, REDIRECT_URI);
}

export async function getAuthedClient(config: GoogleOAuthConfig, account: GoogleTokens) {
  const client = createOAuth2Client(config);
  client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expires_at,
  });

  // Auto-refresh if expiring within 5 minutes
  if (account.expires_at < Date.now() + 5 * 60 * 1000) {
    logGoogle(`Refreshing token for ${account.email}`);
    const { credentials } = await client.refreshAccessToken();
    const updated: GoogleTokens = {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token ?? account.refresh_token,
      expires_at: credentials.expiry_date ?? Date.now() + 3600 * 1000,
      email: account.email,
    };
    upsertAccount(updated);
    client.setCredentials(credentials);
  }

  return client;
}

// ── OAuth2 authorization flow ────────────────────────────────────────────────

export async function googleAuth(): Promise<void> {
  const config = getGoogleOAuthConfig();
  if (!config) {
    console.error(
      "[google] OAuth2 credentials not found.\n" +
      "  Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, or add:\n" +
      '  { "google": { "clientId": "...", "clientSecret": "..." } } to ~/.egg/config.json',
    );
    process.exit(1);
  }

  const client = createOAuth2Client(config);
  const state = Math.random().toString(36).slice(2);

  const authorizeUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    prompt: "consent", // force refresh_token grant
  });

  console.log("\n[google] Starting OAuth2 authorization flow...");
  console.log(`\nOpen this URL in your browser:\n\n  ${authorizeUrl}\n`);

  try {
    execSync(`open ${JSON.stringify(authorizeUrl)}`, { stdio: "ignore" });
    console.log("[google] Browser opened automatically.");
  } catch {}

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth2 timeout: no callback received within 5 minutes"));
    }, 5 * 60 * 1000);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed: ${error}</h1><p>You may close this tab.</p>`);
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth2 error: ${error}`));
        return;
      }

      if (returnedState !== state || !authCode) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Invalid callback</h1><p>You may close this tab.</p>");
        clearTimeout(timeout);
        server.close();
        reject(new Error("OAuth2 callback: invalid state or missing code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Google authorization successful!</h1><p>You may close this tab and return to your terminal.</p>");
      clearTimeout(timeout);
      server.close();
      resolve(authCode);
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log(`[google] Listening for callback on http://localhost:${CALLBACK_PORT}/callback`);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log("[google] Authorization code received. Exchanging for tokens...");

  const { tokens: creds } = await client.getToken(code);
  client.setCredentials(creds);

  // Fetch the user's email address to identify this account
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const userInfo = await oauth2.userinfo.get();
  const email = userInfo.data.email;
  if (!email) throw new Error("Could not determine Google account email");

  const tokens: GoogleTokens = {
    access_token: creds.access_token!,
    refresh_token: creds.refresh_token!,
    expires_at: creds.expiry_date ?? Date.now() + 3600 * 1000,
    email,
  };
  upsertAccount(tokens);

  const allAccounts = loadAllAccounts();
  console.log(`\n[google] Account "${email}" authorized and saved.`);
  console.log(`[google] Total accounts configured: ${allAccounts.length}`);
  console.log(`[google] Tokens saved to ${GOOGLE_TOKENS_FILE}`);
}
