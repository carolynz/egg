import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { callBrain } from "../brain/index.js";
import {
  EGG_MEMORY_DIR,
  NUDGES_DIR,
  NUDGES_SENT_DIR,
  QUIET_START,
  QUIET_END,
  HEARTBEAT_INTERVAL_MS,
} from "../config.js";

// ── Logging ───────────────────────────────────────────────────────────────────

const HEARTBEAT_LOG = join(homedir(), ".egg", "logs", "heartbeat.log");

function logHeartbeat(message: string): void {
  console.log(`[heartbeat] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(HEARTBEAT_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

// ── Context gathering ─────────────────────────────────────────────────────────

function readFileSafe(path: string, maxChars = 4000): string {
  try {
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return content.length > maxChars ? content.slice(0, maxChars) + "\n...(truncated)" : content;
  } catch {
    return "";
  }
}

function getRecentFiles(dir: string, ext: string, maxFiles: number, maxAge: number): string[] {
  try {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .filter((f) => Date.now() - f.mtime < maxAge)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxFiles);
    return files.map((f) => f.path);
  } catch {
    return [];
  }
}

function gatherContext(): string {
  const sections: string[] = [];

  // Current time context
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  sections.push(`Current time: ${now.toLocaleString()} (${days[now.getDay()]})`);

  // MEMORY.md
  const memory = readFileSafe(join(EGG_MEMORY_DIR, "MEMORY.md"), 3000);
  if (memory) {
    sections.push(`## MEMORY.md\n${memory}`);
  }

  // goals.yaml
  const goals = readFileSafe(join(EGG_MEMORY_DIR, "goals.yaml"), 3000);
  if (goals) {
    sections.push(`## goals.yaml\n${goals}`);
  }

  // Recent daily digests (last 3 days)
  const dailyDir = join(EGG_MEMORY_DIR, "daily");
  const recentDailies = getRecentFiles(dailyDir, ".md", 3, 3 * 24 * 60 * 60 * 1000);
  if (recentDailies.length > 0) {
    const dailyContent = recentDailies
      .map((f) => {
        const name = f.split("/").pop() ?? f;
        return `### ${name}\n${readFileSafe(f, 2000)}`;
      })
      .join("\n\n");
    sections.push(`## Recent daily digests\n${dailyContent}`);
  }

  // Recently sent nudges (last 48 hours)
  const recentSent = getRecentFiles(NUDGES_SENT_DIR, ".md", 10, 48 * 60 * 60 * 1000);
  if (recentSent.length > 0) {
    const sentContent = recentSent
      .map((f) => {
        const name = f.split("/").pop() ?? f;
        return `- ${name}: ${readFileSafe(f, 500).split("\n").join(" | ")}`;
      })
      .join("\n");
    sections.push(`## Recently sent nudges (last 48h)\n${sentContent}`);
  }

  return sections.join("\n\n");
}

// ── Heartbeat prompt ──────────────────────────────────────────────────────────

function buildHeartbeatPrompt(context: string): string {
  return [
    "You are running a periodic heartbeat check. Your job is to decide whether to send a proactive nudge right now.",
    "",
    "Here is the current context:",
    "",
    context,
    "",
    "Instructions:",
    "- Only send a nudge if there's something genuinely worth saying right now.",
    "- Good reasons to nudge: a goal deadline is approaching, it's a good time of day for a habit they're tracking, they haven't done something they usually do by this time, encouragement after a tough day, a timely reminder tied to their goals.",
    "- Bad reasons to nudge: nothing specific to say, a similar nudge was sent recently, it's not a natural time for the nudge topic.",
    "- Check the recently sent nudges to avoid repeating yourself or spamming.",
    "- If you decide to nudge: write the nudge text to a new file at nudges/<timestamp>.md where <timestamp> is the current ISO timestamp with colons/dots replaced by dashes. The file should contain only the nudge text (one line per text message). Keep it short and natural — 1-3 lines max.",
    "- If no nudge is warranted: do nothing, output nothing. It's completely fine to skip.",
  ].join("\n");
}

// ── HeartbeatPoller ───────────────────────────────────────────────────────────

export class HeartbeatPoller {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    const intervalMin = Math.round(HEARTBEAT_INTERVAL_MS / 60_000);
    logHeartbeat(`Heartbeat poller starting (every ${intervalMin} minutes)`);
    // Run first check after a short delay (don't fire immediately on startup)
    setTimeout(() => void this.poll(), 60_000);
    this.intervalId = setInterval(() => void this.poll(), HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      // Quiet hours check
      const hour = new Date().getHours();
      if (hour >= QUIET_START || hour < QUIET_END) {
        logHeartbeat(`Quiet hours (${QUIET_START}:00–${QUIET_END}:00) — skipping`);
        return;
      }

      // Skip if nudges are already queued
      if (existsSync(NUDGES_DIR)) {
        const pending = readdirSync(NUDGES_DIR).filter((f) => f.endsWith(".md"));
        if (pending.length > 0) {
          logHeartbeat(`${pending.length} pending nudge(s) already queued — skipping`);
          return;
        }
      }

      logHeartbeat("Running heartbeat check...");
      const context = gatherContext();
      const prompt = buildHeartbeatPrompt(context);

      await callBrain({ history: [], message: prompt });
      logHeartbeat("Heartbeat check complete");
    } catch (err) {
      logHeartbeat(`ERROR in heartbeat poll: ${err}`);
    }
  }
}
