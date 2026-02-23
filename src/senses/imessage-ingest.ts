import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getAllMessages, ThreadMessage } from "../shell/imessage-reader.js";
import {
  EGG_BRAIN,
  EGG_MEMORY_DIR,
  EGG_MODEL,
  IMESSAGE_INGEST_INTERVAL_MS,
  QUIET_START,
  QUIET_END,
} from "../config.js";
import { IMESSAGE_INGEST_LOG } from "../logger.js";

const CURSOR_FILE = join(EGG_MEMORY_DIR, "data", "imessage-cursor.json");
const MAX_PROMPT_CHARS = 8000;

interface IngestCursor {
  lastRowid: number;
  lastRunAt: string;
}

function logIngest(message: string): void {
  console.log(`[imessage-ingest] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(IMESSAGE_INGEST_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function loadCursor(): IngestCursor {
  try {
    if (existsSync(CURSOR_FILE)) {
      return JSON.parse(readFileSync(CURSOR_FILE, "utf-8"));
    }
  } catch {}
  return { lastRowid: 0, lastRunAt: "" };
}

function saveCursor(cursor: IngestCursor): void {
  try {
    mkdirSync(join(EGG_MEMORY_DIR, "data"), { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
  } catch (err) {
    logIngest(`ERROR saving cursor: ${err}`);
  }
}

/** Group messages by chat thread, return map of chatIdentifier → messages. */
function groupByThread(messages: ThreadMessage[]): Map<string, ThreadMessage[]> {
  const groups = new Map<string, ThreadMessage[]>();
  for (const msg of messages) {
    const key = msg.chatIdentifier || msg.sender || "unknown";
    const existing = groups.get(key);
    if (existing) {
      existing.push(msg);
    } else {
      groups.set(key, [msg]);
    }
  }
  return groups;
}

/** Format grouped messages into a prompt section, respecting char budget. */
function formatThreadsForPrompt(threads: Map<string, ThreadMessage[]>): string {
  const sections: string[] = [];
  let totalChars = 0;

  for (const [threadId, msgs] of threads) {
    if (totalChars >= MAX_PROMPT_CHARS) break;

    const displayName = msgs[0].displayName || threadId;
    const lines: string[] = [`### Thread: ${displayName} (${threadId})`];

    for (const msg of msgs) {
      const direction = msg.isFromMe ? "→ sent" : "← received";
      const from = msg.isFromMe ? "me" : (msg.sender || "them");
      const line = `  [${msg.time}] ${direction} (${from}): ${msg.text}`;
      lines.push(line);
    }

    const section = lines.join("\n");
    if (totalChars + section.length > MAX_PROMPT_CHARS && sections.length > 0) break;
    sections.push(section);
    totalChars += section.length;
  }

  return sections.join("\n\n");
}

function buildIngestPrompt(threadContent: string): string {
  return [
    "You are processing the user's personal iMessage conversations to maintain context about their social landscape.",
    "",
    "Below are recent messages from various threads. For each thread with meaningful content:",
    "1. Create or update the relevant person's dossier in people/{name}.md",
    "2. Write SUMMARIES only — never store raw message content in files",
    "3. Focus on: topics discussed, plans mentioned, emotional signals, relationship dynamics, commitments made",
    "4. Flag anything time-sensitive or important by including it prominently in the dossier",
    "5. If you can identify the contact's name from context, use that as the filename. Otherwise use the phone/email handle.",
    "6. Keep dossier updates concise — append a dated section, don't rewrite the whole file",
    "",
    "If a people/ directory doesn't exist, create it.",
    "If a dossier already exists, read it first and append new information under a dated heading.",
    "",
    "Recent messages:",
    "",
    threadContent,
  ].join("\n");
}

function spawnIngestBrain(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      EGG_BRAIN,
      ["-p", prompt, "--output-format", "text", "--dangerously-skip-permissions", "--model", EGG_MODEL],
      {
        cwd: EGG_MEMORY_DIR,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      },
    );

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Brain exited with code ${code}`));
      else resolve();
    });
  });
}

/** Run a single ingestion cycle. Exported for use by CLI one-shot and poller. */
export async function runIngestCycle(): Promise<void> {
  const cursor = loadCursor();
  logIngest(`Checking for new messages since ROWID ${cursor.lastRowid}`);

  const { messages, maxRowid } = getAllMessages(cursor.lastRowid);

  if (messages.length === 0) {
    logIngest("No new messages");
    if (maxRowid > cursor.lastRowid) {
      saveCursor({ lastRowid: maxRowid, lastRunAt: new Date().toISOString() });
    }
    return;
  }

  logIngest(`Found ${messages.length} new messages across threads`);

  const threads = groupByThread(messages);
  logIngest(`Grouped into ${threads.size} thread(s): ${[...threads.keys()].join(", ")}`);

  const threadContent = formatThreadsForPrompt(threads);
  if (!threadContent.trim()) {
    logIngest("No meaningful content to process");
    saveCursor({ lastRowid: maxRowid, lastRunAt: new Date().toISOString() });
    return;
  }

  const prompt = buildIngestPrompt(threadContent);
  logIngest(`Spawning brain for ingestion (${prompt.length} chars prompt)`);

  try {
    await spawnIngestBrain(prompt);
    logIngest("Ingestion complete");
  } catch (err) {
    logIngest(`ERROR during brain processing: ${err}`);
  }

  saveCursor({ lastRowid: maxRowid, lastRunAt: new Date().toISOString() });
}

export class ImessageIngestPoller {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    const intervalMin = Math.round(IMESSAGE_INGEST_INTERVAL_MS / 60_000);
    logIngest(`iMessage ingest poller starting (every ${intervalMin} minutes)`);
    // First run after 2 minutes (let other systems initialize)
    setTimeout(() => void this.poll(), 2 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), IMESSAGE_INGEST_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      // Respect quiet hours
      const hour = new Date().getHours();
      if (hour >= QUIET_START || hour < QUIET_END) {
        logIngest(`Quiet hours (${QUIET_START}:00–${QUIET_END}:00) — skipping`);
        return;
      }

      await runIngestCycle();
    } catch (err) {
      logIngest(`ERROR in ingest poll: ${err}`);
    }
  }
}
