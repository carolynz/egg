import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { NUDGES_DIR } from "../config.js";

// ── Token resolution ──────────────────────────────────────────────────────────

function getOuraToken(): string | null {
  if (process.env.OURA_TOKEN) return process.env.OURA_TOKEN;

  const configPath = join(homedir(), ".egg", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const oura = cfg?.oura as Record<string, unknown> | undefined;
      if (typeof oura?.token === "string") return oura.token;
    } catch {}
  }

  return null;
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

// ── Oura state ────────────────────────────────────────────────────────────────

interface OuraState {
  lastNotifiedWakeDate: string | null;
}

const OURA_STATE_FILE = join(homedir(), ".egg", "oura-state.json");

function loadOuraState(): OuraState {
  try {
    return JSON.parse(readFileSync(OURA_STATE_FILE, "utf-8")) as OuraState;
  } catch {
    return { lastNotifiedWakeDate: null };
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
}

interface DailySleep {
  id: string;
  day: string;
  score: number | null;
}

// ── Oura API calls ────────────────────────────────────────────────────────────

async function ouriFetch<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.ouraring.com/v2/usercollection/${path}?${qs}`;
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

// ── Nudge message ─────────────────────────────────────────────────────────────

function buildGoodMorningMessage(score: number | null): string {
  if (score === null || score === undefined) {
    return "Good morning! Hope you slept well ☀️";
  }
  if (score >= 85) {
    return `Good morning! Sleep score was ${score} — you're well rested. Great start to the day ☀️`;
  }
  if (score >= 70) {
    return `Good morning! Sleep score was ${score} — decent rest. Have a good one ☀️`;
  }
  return `Good morning! Sleep score was ${score} — not the best night. Take it easy today 💤`;
}

// ── Wake detection ────────────────────────────────────────────────────────────

async function checkWakeUp(token: string): Promise<void> {
  const now = new Date();
  const hour = now.getHours();

  // Only check between 5am and 12pm
  if (hour < 5 || hour >= 12) return;

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

  if (!recentWake) {
    logOura(`No recent wake in last 30 min (${sessions.length} sessions checked)`);
    return;
  }

  logOura(`Wake detected: bedtime_end=${recentWake.bedtime_end} day=${recentWake.day}`);

  // Fetch sleep score from daily summary
  let score: number | null = null;
  try {
    const dailySleep = await fetchDailySleep(token, startDate);
    const match = dailySleep.find((d) => d.day === todayDate || d.day === recentWake.day);
    score = match?.score ?? null;
    logOura(`Sleep score: ${score}`);
  } catch (err) {
    logOura(`WARNING: Could not fetch daily sleep score: ${err}`);
  }

  // Write nudge file
  const message = buildGoodMorningMessage(score);
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const nudgeFile = join(NUDGES_DIR, `${timestamp}.md`);

  try {
    mkdirSync(NUDGES_DIR, { recursive: true });
    writeFileSync(nudgeFile, message);
    logOura(`Good morning nudge written: ${nudgeFile}`);
    state.lastNotifiedWakeDate = todayDate;
    saveOuraState(state);
  } catch (err) {
    logOura(`ERROR writing nudge file: ${err}`);
  }
}

// ── OuraPoller ────────────────────────────────────────────────────────────────

export class OuraPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly token: string | null;

  constructor() {
    this.token = getOuraToken();
    if (!this.token) {
      console.warn(
        "[oura] token not found — Oura integration disabled.\n" +
        "  Set OURA_TOKEN in .env, or add { \"oura\": { \"token\": \"...\" } } to ~/.egg/config.json"
      );
    }
  }

  start(): void {
    if (!this.token) return;
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
      await checkWakeUp(this.token!);
    } catch (err) {
      logOura(`ERROR in poll: ${err}`);
    }
  }
}
