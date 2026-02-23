import { config } from "dotenv";
import { join } from "path";
import { homedir } from "os";

// egg expects to be run from inside an egg-memory directory.
// Load .env from cwd.
config();

function env(key: string): string {
  return process.env[key] ?? "";
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// cwd is the egg-memory directory
export const EGG_MEMORY_DIR = process.cwd();
export const EGG_PID_FILE = join(homedir(), ".egg", "egg.pid");
export const EGG_BRAIN = env("EGG_BRAIN") || "claude";
export const EGG_MODEL = env("EGG_MODEL") || "claude-opus-4-6";
export const CHAT_DB = env("CHAT_DB") || join(homedir(), "Library", "Messages", "chat.db");

// Derived paths
export const TASKS_DIR = join(EGG_MEMORY_DIR, "tasks");
export const TASKS_DONE_DIR = join(EGG_MEMORY_DIR, "tasks", "done");
export const SOUL_PATH = join(EGG_MEMORY_DIR, "SOUL.md");
export const MEMORY_PATH = join(EGG_MEMORY_DIR, "MEMORY.md");
export const STATE_FILE = join(EGG_MEMORY_DIR, ".egg-state.json");
export const NUDGES_DIR = join(EGG_MEMORY_DIR, "nudges");
export const NUDGES_SENT_DIR = join(EGG_MEMORY_DIR, "nudges", "sent");

// Quiet hours for nudges
export const QUIET_START = 23;
export const QUIET_END = 8;

// Session reuse: max age before forcing a fresh CC session (default 4 hours)
export const EGG_SESSION_MAX_AGE_MS = parseInt(env("EGG_SESSION_MAX_AGE_MS") || "", 10) || 24 * 60 * 60 * 1000;

// Heartbeat poller interval (default 30 minutes)
export const HEARTBEAT_INTERVAL_MS = parseInt(env("HEARTBEAT_INTERVAL_MS") || "", 10) || 30 * 60 * 1000;

// iMessage ingestion poller interval (default 30 minutes)
export const IMESSAGE_INGEST_INTERVAL_MS = parseInt(env("IMESSAGE_INGEST_INTERVAL_MS") || "", 10) || 30 * 60 * 1000;

// ── Lazy: only needed by serve/send commands ──
// These throw if accessed without being set, but don't crash at import time.
let _eggAppleId: string | undefined;
let _eggUserPhone: string | undefined;

export function getEggAppleId(): string {
  if (_eggAppleId === undefined) _eggAppleId = required("EGG_APPLE_ID");
  return _eggAppleId;
}

export function getEggUserPhone(): string {
  if (_eggUserPhone === undefined) _eggUserPhone = required("EGG_USER_PHONE");
  return _eggUserPhone;
}

export const BLUEBUBBLES_URL = env("BLUEBUBBLES_URL").replace(/\/+$/, "");
export const BLUEBUBBLES_PASSWORD = env("BLUEBUBBLES_PASSWORD");

let _eggCodeDir: string | undefined;

export function getEggCodeDir(): string {
  if (_eggCodeDir === undefined) {
    const val = process.env.EGG_CODE_DIR;
    if (!val) throw new Error("Missing EGG_CODE_DIR in .env — needed for self-modification tasks");
    _eggCodeDir = val;
  }
  return _eggCodeDir;
}

// ── GitHub repo URL ──
import { execSync } from "child_process";

let _gitHubRepoUrl: string | null | undefined;

export function getGitHubRepoUrl(): string | null {
  if (_gitHubRepoUrl !== undefined) return _gitHubRepoUrl;
  try {
    const raw = execSync("git remote get-url origin", {
      cwd: getEggCodeDir(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString().trim();

    // SSH: git@github.com:owner/repo.git → https://github.com/owner/repo
    const sshMatch = raw.match(/^git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) {
      _gitHubRepoUrl = `https://github.com/${sshMatch[1]}`;
      return _gitHubRepoUrl;
    }

    // HTTPS: https://github.com/owner/repo.git → https://github.com/owner/repo
    const httpsMatch = raw.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      _gitHubRepoUrl = `https://github.com/${httpsMatch[1]}`;
      return _gitHubRepoUrl;
    }

    // Unknown format — return null
    console.warn(`[config] unrecognized git remote format: ${raw}`);
    _gitHubRepoUrl = null;
    return null;
  } catch {
    _gitHubRepoUrl = null;
    return null;
  }
}

// ── Startup check ──
import { existsSync } from "fs";

export function checkMemoryDir(): void {
  const missing: string[] = [];
  if (!existsSync(SOUL_PATH)) missing.push("SOUL.md");
  if (!existsSync(MEMORY_PATH)) missing.push("MEMORY.md");
  if (!existsSync(join(EGG_MEMORY_DIR, "CLAUDE.md"))) missing.push("CLAUDE.md");

  if (missing.length > 0) {
    console.error(
      `Error: not an egg-memory directory (missing ${missing.join(", ")})\n` +
      `Run egg from inside your egg-memory directory.`
    );
    process.exit(1);
  }
}
