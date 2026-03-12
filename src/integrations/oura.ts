import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { createServer } from "http";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { NUDGES_DIR, NUDGES_SENT_DIR } from "../config.js";
import { generateTodayMd, generateMorningNudge } from "../senses/daily-planner.js";
import { updateWeekStart } from "../senses/goal-progress.js";

// ── OAuth2 constants ──────────────────────────────────────────────────────────

const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const OURA_API_BASE = "https://api.ouraring.com/v2/";

// ── OAuth2 config ─────────────────────────────────────────────────────────────

interface OuraOAuthConfig {
  clientId: string;
  clientSecret: string;
}

function getOAuthConfig(): OuraOAuthConfig | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  const configPath = join(homedir(), ".egg", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const oura = cfg?.oura as Record<string, unknown> | undefined;
      if (typeof oura?.clientId === "string" && typeof oura?.clientSecret === "string") {
        return { clientId: oura.clientId, clientSecret: oura.clientSecret };
      }
    } catch {}
  }

  return null;
}

// ── Token storage ─────────────────────────────────────────────────────────────

interface OuraTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
}

const OURA_TOKENS_FILE = join(homedir(), ".egg", "oura-tokens.json");

function loadTokens(): OuraTokens | null {
  try {
    return JSON.parse(readFileSync(OURA_TOKENS_FILE, "utf-8")) as OuraTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: OuraTokens): void {
  mkdirSync(join(homedir(), ".egg"), { recursive: true });
  writeFileSync(OURA_TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ── Logging ───────────────────────────────────────────────────────────────────

const OURA_LOG = join(homedir(), ".egg", "logs", "oura.log");

function logOura(message: string): void {
  console.log(`[oura] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(OURA_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function refreshTokens(config: OuraOAuthConfig, refreshToken: string): Promise<OuraTokens> {
  const res = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: OuraTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function getValidAccessToken(): Promise<string | null> {
  // Personal API token takes priority — long-lived Bearer token, no OAuth dance needed
  const personalToken = process.env.OURA_TOKEN;
  if (personalToken) return personalToken;

  // Fall back to OAuth2 flow
  const config = getOAuthConfig();
  if (!config) return null;

  let tokens = loadTokens();
  if (!tokens) return null;

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at < Date.now() + 5 * 60 * 1000) {
    logOura("Access token expiring soon — refreshing");
    try {
      tokens = await refreshTokens(config, tokens.refresh_token);
    } catch (err) {
      logOura(`ERROR refreshing token: ${err}`);
      return null;
    }
  }

  return tokens.access_token;
}

// ── Oura state ────────────────────────────────────────────────────────────────

interface OuraState {
  lastNotifiedWakeDate: string | null;
  lastOuraFollowUpDate: string | null;
}

const OURA_STATE_FILE = join(homedir(), ".egg", "oura-state.json");

function loadOuraState(): OuraState {
  try {
    return JSON.parse(readFileSync(OURA_STATE_FILE, "utf-8")) as OuraState;
  } catch {
    return { lastNotifiedWakeDate: null, lastOuraFollowUpDate: null };
  }
}

function saveOuraState(state: OuraState): void {
  mkdirSync(join(homedir(), ".egg"), { recursive: true });
  writeFileSync(OURA_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Oura API types ────────────────────────────────────────────────────────────

interface SleepSession {
  id: string;
  day: string;
  bedtime_end: string | null;
  type: string;
  total_sleep_duration: number | null; // seconds
  average_hrv: number | null;
  average_heart_rate: number | null;
}

interface DailySleep {
  id: string;
  day: string;
  score: number | null;
}

interface DailyReadiness {
  id: string;
  day: string;
  score: number | null;
}

// ── Oura API calls ────────────────────────────────────────────────────────────

async function ouriFetch<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${OURA_API_BASE}usercollection/${path}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Oura API ${path}: ${res.status} ${res.statusText}`);
  }
  const json = await res.json() as { data: T };
  return json.data;
}

async function fetchSleepSessions(token: string, startDate: string): Promise<SleepSession[]> {
  return ouriFetch<SleepSession[]>(token, "sleep", { start_date: startDate });
}

async function fetchDailySleep(token: string, startDate: string): Promise<DailySleep[]> {
  return ouriFetch<DailySleep[]>(token, "daily_sleep", { start_date: startDate });
}

async function fetchDailyReadiness(token: string, startDate: string): Promise<DailyReadiness[]> {
  return ouriFetch<DailyReadiness[]>(token, "daily_readiness", { start_date: startDate });
}

// ── Message generation ────────────────────────────────────────────────────────

function formatSleepDuration(totalSecs: number): string {
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function buildSleepLine(
  sleepScore: number | null,
  totalSleepSeconds: number | null,
  avgHrv: number | null,
  avgHeartRate: number | null,
): string {
  const parts: string[] = [];
  if (totalSleepSeconds !== null) {
    parts.push(formatSleepDuration(totalSleepSeconds));
  }
  if (sleepScore !== null) {
    parts.push(`sleep score ${sleepScore}`);
  }

  let interpretation = "";
  if (sleepScore !== null) {
    if (sleepScore >= 85) interpretation = "great recovery";
    else if (sleepScore >= 70) interpretation = "decent recovery";
    else if (sleepScore >= 60) interpretation = "light recovery";
    else interpretation = "rough night";
  }

  let line = parts.join(", ");
  if (interpretation) line += ` — ${interpretation}`;

  const metrics: string[] = [];
  if (avgHrv !== null) metrics.push(`HRV ${Math.round(avgHrv)}`);
  if (avgHeartRate !== null) metrics.push(`RHR ${Math.round(avgHeartRate)}`);
  if (metrics.length > 0) line += `. ${metrics.join(", ")}`;

  return line || "good morning";
}

function buildReadinessLine(readinessScore: number | null): string {
  if (readinessScore === null) {
    return "readiness unknown — moderate day, listen to your body";
  }
  if (readinessScore < 60) {
    return `readiness ${readinessScore} — go easy today, prioritize rest`;
  }
  if (readinessScore < 80) {
    return `readiness ${readinessScore} — good day to work, moderate effort`;
  }
  return `readiness ${readinessScore} — push hard, great day for strength training or a big ask`;
}

function buildGoodMorningMessage(): string {
  const lines = [
    "good morning",
    "water before coffee",
    "teeth + face (non-negotiable)",
    "cat-cow + child's pose (2 min) — then set one intention for the day",
    "open the Oura app so your sleep data syncs",
  ];
  return lines.join("\n");
}

function buildOuraFollowUpMessage(data: {
  sleepScore: number | null;
  readinessScore: number | null;
  totalSleepSeconds: number | null;
  avgHrv: number | null;
  avgHeartRate: number | null;
}): string {
  const lines = [
    buildSleepLine(data.sleepScore, data.totalSleepSeconds, data.avgHrv, data.avgHeartRate),
    buildReadinessLine(data.readinessScore),
  ];
  return lines.join("\n");
}

// ── Dedup helper ──────────────────────────────────────────────────────────────

/** Check if a morning nudge was already sent today by scanning nudges/sent/ filenames */
export function hasMorningNudgeToday(todayDate: string): boolean {
  try {
    if (!existsSync(NUDGES_SENT_DIR)) return false;
    // Sent nudge files are named like 2026-03-12T08-30-00-000Z.md
    const files = readdirSync(NUDGES_SENT_DIR).filter((f) => f.startsWith(todayDate) && f.endsWith(".md"));
    return files.length > 0;
  } catch {
    return false;
  }
}

// ── Wake detection ────────────────────────────────────────────────────────────

/**
 * Run the full morning planner (today.md + morning nudge) with dedup.
 * Called from both Oura wake detection and the iMessage fallback.
 * Returns true if the nudge was actually triggered.
 */
export async function triggerMorningNudge(source: string): Promise<boolean> {
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);

  // Dedup: check nudges/sent/ for today's date before writing
  if (hasMorningNudgeToday(todayDate)) {
    logOura(`Morning nudge already sent today (found in nudges/sent/) — skipping (source: ${source})`);
    const state = loadOuraState();
    state.lastNotifiedWakeDate = todayDate;
    saveOuraState(state);
    return false;
  }

  // Run full morning planner: generate today.md + smart morning nudge
  try {
    logOura(`Running full morning planner (source: ${source})...`);
    updateWeekStart();
    await generateTodayMd();
    logOura("today.md generated successfully");

    const nudgeText = await generateMorningNudge();
    if (nudgeText.trim()) {
      mkdirSync(NUDGES_DIR, { recursive: true });
      const timestamp = now.toISOString().replace(/[:.]/g, "-");
      const nudgeFile = join(NUDGES_DIR, `${timestamp}.md`);
      writeFileSync(nudgeFile, nudgeText);
      logOura(`Morning nudge written: ${nudgeFile}`);
    }

    const state = loadOuraState();
    state.lastNotifiedWakeDate = todayDate;
    saveOuraState(state);
    return true;
  } catch (err) {
    logOura(`ERROR in morning planner: ${err}`);
    return false;
  }
}

async function checkWakeUp(token: string): Promise<void> {
  const now = new Date();
  const hour = now.getHours();

  // Only check between 5am and 1pm (noon fallback needs to fire at 12)
  if (hour < 5 || hour >= 13) return;

  const todayDate = now.toISOString().slice(0, 10);
  const state = loadOuraState();

  if (state.lastNotifiedWakeDate === todayDate) return;

  // Fetch sessions from yesterday so we catch overnight sleep
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const startDate = yesterday.toISOString().slice(0, 10);

  let sessions: SleepSession[];
  try {
    sessions = await fetchSleepSessions(token, startDate);
    logOura(`Fetched ${sessions.length} sleep session(s)`);
  } catch (err) {
    logOura(`ERROR fetching sleep sessions: ${err}`);
    return;
  }

  // Find a long sleep that ended within the last 30 minutes
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  const recentWake = sessions.find((s) => {
    if (s.type !== "long_sleep") return false;
    if (!s.bedtime_end) return false;
    const wakeTime = new Date(s.bedtime_end);
    return wakeTime >= thirtyMinAgo && wakeTime <= now;
  });

  // Fallback: if no wake detected by noon, fire anyway
  const isNoonFallback = hour >= 12 && !recentWake;

  if (!recentWake && !isNoonFallback) {
    logOura(`No recent wake in last 30 min (${sessions.length} sessions checked), not yet noon fallback — skipping`);
    return;
  }

  if (recentWake) {
    logOura(`Wake detected: bedtime_end=${recentWake.bedtime_end} day=${recentWake.day}`);
  } else {
    logOura(`Noon fallback — no Oura wake detected by noon, firing morning planner`);
  }

  await triggerMorningNudge(recentWake ? "oura-wake" : "oura-noon-fallback");
}

// ── Oura follow-up: check for synced sleep data ──────────────────────────────

async function checkOuraSync(token: string): Promise<void> {
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const state = loadOuraState();

  // Only run after morning nudge has been sent today
  if (state.lastNotifiedWakeDate !== todayDate) return;

  // Already sent follow-up today
  if (state.lastOuraFollowUpDate === todayDate) return;

  // Fetch today's daily_sleep data
  let dailySleep: DailySleep[];
  let dailyReadiness: DailyReadiness[];
  try {
    dailySleep = await fetchDailySleep(token, todayDate);
  } catch (err) {
    logOura(`Oura follow-up: could not fetch daily_sleep: ${err}`);
    return;
  }

  const sleepMatch = dailySleep.find((d) => d.day === todayDate);
  if (!sleepMatch || sleepMatch.score === null) {
    logOura("Oura follow-up: no daily_sleep data for today yet — waiting for app sync");
    return;
  }

  // Sleep data appeared — fetch readiness too
  try {
    dailyReadiness = await fetchDailyReadiness(token, todayDate);
  } catch (err) {
    logOura(`WARNING: Could not fetch daily readiness for follow-up: ${err}`);
    dailyReadiness = [];
  }

  const readinessMatch = dailyReadiness.find((d) => d.day === todayDate);

  // Fetch sleep session for duration/HRV metrics
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  let totalSleepSeconds: number | null = null;
  let avgHrv: number | null = null;
  let avgHeartRate: number | null = null;
  try {
    const sessions = await fetchSleepSessions(token, yesterday.toISOString().slice(0, 10));
    const longSleep = sessions
      .filter((s) => s.type === "long_sleep" && s.bedtime_end != null)
      .sort((a, b) => new Date(b.bedtime_end!).getTime() - new Date(a.bedtime_end!).getTime())[0];
    if (longSleep) {
      totalSleepSeconds = longSleep.total_sleep_duration;
      avgHrv = longSleep.average_hrv;
      avgHeartRate = longSleep.average_heart_rate;
    }
  } catch (err) {
    logOura(`WARNING: Could not fetch sleep sessions for follow-up: ${err}`);
  }

  const message = buildOuraFollowUpMessage({
    sleepScore: sleepMatch.score,
    readinessScore: readinessMatch?.score ?? null,
    totalSleepSeconds,
    avgHrv,
    avgHeartRate,
  });

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const nudgeFile = join(NUDGES_DIR, `${timestamp}.md`);

  try {
    mkdirSync(NUDGES_DIR, { recursive: true });
    writeFileSync(nudgeFile, message);
    logOura(`Oura follow-up nudge written: ${nudgeFile}`);
    state.lastOuraFollowUpDate = todayDate;
    saveOuraState(state);
  } catch (err) {
    logOura(`ERROR writing Oura follow-up nudge: ${err}`);
  }
}

// ── OAuth2 authorization flow ─────────────────────────────────────────────────

export async function ouraAuth(): Promise<void> {
  const config = getOAuthConfig();
  if (!config) {
    console.error(
      "[oura] OAuth2 credentials not found.\n" +
      "  Set OURA_CLIENT_ID and OURA_CLIENT_SECRET in .env, or add:\n" +
      '  { "oura": { "clientId": "...", "clientSecret": "..." } } to ~/.egg/config.json'
    );
    process.exit(1);
  }

  const port = 4321; // Fixed port — register http://localhost:4321/callback in Oura developer portal
  const redirectUri = `http://localhost:${port}/callback`;
  const state = Math.random().toString(36).slice(2);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: "daily personal heartrate workout session",
    state,
  });

  const authorizeUrl = `${OURA_AUTHORIZE_URL}?${params.toString()}`;
  console.log("\n[oura] Starting OAuth2 authorization flow...");
  console.log(`\nOpen this URL in your browser:\n\n  ${authorizeUrl}\n`);

  // Try to open in browser automatically
  try {
    execSync(`open ${JSON.stringify(authorizeUrl)}`, { stdio: "ignore" });
    console.log("[oura] Browser opened automatically.");
  } catch {
    // Manual fallback — user sees the URL above
  }

  // Spin up a local HTTP server to capture the OAuth2 callback
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth2 timeout: no callback received within 5 minutes"));
    }, 5 * 60 * 1000);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
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
      res.end("<h1>Authorization successful!</h1><p>You may close this tab and return to your terminal.</p>");
      clearTimeout(timeout);
      server.close();
      resolve(authCode);
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`[oura] Listening for callback on http://localhost:${port}/callback`);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log("[oura] Authorization code received. Exchanging for tokens...");

  // Exchange authorization code for tokens
  const res = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[oura] Token exchange failed (${res.status}):`);
    console.error(`[oura] Response: ${body}`);
    console.error(`[oura] Redirect URI sent: ${redirectUri}`);
    console.error(`[oura] Make sure this exact URI is registered in the Oura developer portal.`);
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: OuraTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);

  console.log(`\n[oura] Tokens saved to ${OURA_TOKENS_FILE}`);
  console.log("[oura] OAuth2 setup complete! You can now run `egg serve`.");
}

// ── OuraPoller ────────────────────────────────────────────────────────────────

export class OuraPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly hasCredentials: boolean;

  constructor() {
    const hasPersonalToken = !!process.env.OURA_TOKEN;
    const config = getOAuthConfig();
    const tokens = loadTokens();
    this.hasCredentials = hasPersonalToken || !!(config && tokens);
    if (!this.hasCredentials) {
      if (!config) {
        console.warn(
          "[oura] Oura integration disabled — no credentials found.\n" +
          "  Option A (simple): set OURA_TOKEN in .env with your Personal Access Token\n" +
          "  Option B (OAuth2): set OURA_CLIENT_ID/OURA_CLIENT_SECRET and run `egg oura:auth`"
        );
      } else {
        console.warn(
          "[oura] No Oura tokens found — run `egg oura:auth` to authorize."
        );
      }
    }
  }

  start(): void {
    if (!this.hasCredentials) return;
    logOura("Oura poller starting (every 5 minutes)");
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const token = await getValidAccessToken();
      if (!token) {
        logOura("No valid access token — skipping poll. Run `egg oura:auth` to re-authorize.");
        return;
      }
      await checkWakeUp(token);
      await checkOuraSync(token);
    } catch (err) {
      logOura(`ERROR in poll: ${err}`);
    }
  }
}
