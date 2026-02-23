import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { EGG_BRAIN, EGG_MEMORY_DIR, EGG_MODEL, EGG_SESSION_MAX_AGE_MS, getGitHubRepoUrl } from "../config.js";
import { logBrainStart, logBrainEnd, logBrainSession } from "../logger.js";

const SESSION_FILE = join(EGG_MEMORY_DIR, ".egg-session.json");

// ── Session tracking ──
// Stored in-process so the long-running shell loop reuses sessions automatically.
// One-shot commands (nudge, intake) start fresh each invocation.
let currentSessionId: string | null = null;
let sessionCreatedAt = 0;

export function clearBrainSession(): void {
  if (currentSessionId) {
    logBrainSession("clear", currentSessionId);
  }
  currentSessionId = null;
  sessionCreatedAt = 0;
  try { unlinkSync(SESSION_FILE); } catch {}
}

export function getBrainSessionId(): string | null {
  return currentSessionId;
}

function isSessionValid(): boolean {
  if (!currentSessionId) return false;
  if (Date.now() - sessionCreatedAt > EGG_SESSION_MAX_AGE_MS) {
    logBrainSession("expired", currentSessionId);
    currentSessionId = null;
    sessionCreatedAt = 0;
    return false;
  }
  return true;
}

function saveSessionToDisk(): void {
  if (!currentSessionId) return;
  try {
    writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: currentSessionId, createdAt: sessionCreatedAt }));
  } catch (err) {
    console.warn("[brain] failed to persist session:", err);
  }
}

function loadSessionFromDisk(): void {
  try {
    if (!existsSync(SESSION_FILE)) return;
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    if (!data.sessionId || !data.createdAt) return;
    if (Date.now() - data.createdAt > EGG_SESSION_MAX_AGE_MS) {
      console.log("[brain] persisted session expired, discarding");
      try { unlinkSync(SESSION_FILE); } catch {}
      return;
    }
    currentSessionId = data.sessionId;
    sessionCreatedAt = data.createdAt;
    logBrainSession("restored", currentSessionId!);
  } catch {
    console.warn("[brain] failed to load persisted session, starting fresh");
  }
}

/** Call during serve startup to restore a persisted session. */
export function initBrainSession(): void {
  loadSessionFromDisk();
}

function getContextBlock(): string {
  const now = new Date();

  // ISO 8601 timestamp with local UTC offset (e.g. 2026-02-20T21:15:00-05:00)
  const tzOffsetMins = -now.getTimezoneOffset(); // positive = east of UTC
  const sign = tzOffsetMins >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffsetMins);
  const offsetHH = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offsetMM = String(absOffset % 60).padStart(2, "0");

  const pad = (n: number) => String(n).padStart(2, "0");
  const isoTimestamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${offsetHH}:${offsetMM}`;

  // IANA timezone name (e.g. "America/New_York") — best available location proxy
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `# context\nCurrent time: ${isoTimestamp}\nTimezone / location: ${timezone}\n`;
}

function buildPrompt(
  opts: {
    history: { role: string; content: string }[];
    message: string;
    runningTasks?: { id: string; prompt: string; startedAt: Date }[];
  },
  resuming: boolean,
): string {
  const lines: string[] = [];

  lines.push(getContextBlock());

  if (opts.runningTasks && opts.runningTasks.length > 0) {
    lines.push("Currently running tasks (DO NOT create duplicate tasks for these):");
    for (const t of opts.runningTasks) {
      const elapsed = Math.round((Date.now() - t.startedAt.getTime()) / 1000);
      lines.push(`  - task ${t.id} (running ${elapsed}s): ${t.prompt.slice(0, 150)}`);
    }
    lines.push("");
  }

  // Only include history when NOT resuming — the session already has it
  if (!resuming && opts.history.length > 0) {
    lines.push("Recent conversation history:");
    for (const msg of opts.history) {
      const tag = msg.role === "user" ? "[human]" : "[egg]";
      lines.push(`${tag} ${msg.content}`);
    }
    lines.push("");
  }

  lines.push(`[human] ${opts.message}`);
  lines.push("");
  lines.push(
    "Respond as Egg. Each line of your response will be sent as a separate text message.\n" +
    "IMPORTANT: Keep casual conversational replies to 1–2 short lines. Match the user's message length. " +
    "Only give longer responses when explaining something, answering a question, or when detail is genuinely needed.\n" +
    "If a visual would genuinely help (e.g., workout form, exercise demonstration), include [IMAGE: <detailed description>] on its own line. " +
    "Only use images when they add real value — keep descriptions specific and concrete.\n" +
    "If the user is requesting a timer (e.g. 'set a timer for 90 seconds', 'rest timer 2 min', 'timer 30s'), " +
    "include a timer marker on its own line: [TIMER: <value><unit>: <follow-up message>] " +
    "where unit is s/m/h and the follow-up message is contextually relevant (e.g. 'rest over — next set!'). " +
    "The marker is stripped before sending — only your other reply lines reach the user."
  );

  const repoUrl = getGitHubRepoUrl();
  if (repoUrl) {
    lines.push(
      `When answering questions about Egg's functionality or capabilities, reference the relevant source file ` +
      `and link to it on GitHub so the user can verify. Use the format: ${repoUrl}/blob/main/<filepath>`
    );
  }

  // Strip null bytes and other control chars that break child_process.spawn args
  return lines.join("\n").replace(/\x00/g, "").replace(/[\x01-\x08\x0e-\x1f]/g, "");
}

interface BrainJsonOutput {
  type?: string;
  result?: string;
  session_id?: string;
}

function parseJsonOutput(stdout: string): { reply: string; sessionId: string | null } {
  // The CLI may output multiple newline-delimited JSON objects (streaming).
  // Scan from the end for the "result" object.
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj: BrainJsonOutput = JSON.parse(lines[i]);
      if (obj.type === "result") {
        return {
          reply: obj.result ?? "",
          sessionId: obj.session_id ?? null,
        };
      }
    } catch {
      // not valid JSON, skip
    }
  }

  // Fallback: try parsing the entire stdout as one JSON object
  try {
    const obj: BrainJsonOutput = JSON.parse(stdout);
    return {
      reply: obj.result ?? stdout,
      sessionId: obj.session_id ?? null,
    };
  } catch {
    // Not JSON at all — treat entire stdout as plain text
    console.warn("[brain] failed to parse JSON output, using raw stdout");
    return { reply: stdout, sessionId: null };
  }
}

function spawnBrainProcess(args: string[], prompt: string): Promise<string> {
  logBrainStart(prompt);
  const startTime = Date.now();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(EGG_BRAIN, args, {
      cwd: EGG_MEMORY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => {
      errChunks.push(data);
      // Stream brain stderr in real-time for thinking traces
      const line = data.toString("utf-8");
      if (line.trim()) process.stderr.write(`[brain] ${line}`);
    });

    child.on("error", (err) => {
      logBrainEnd(null, Date.now() - startTime);
      reject(err);
    });

    child.on("close", (code) => {
      logBrainEnd(code, Date.now() - startTime);
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        reject(new Error(`${EGG_BRAIN} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function callBrain(opts: {
  history: { role: string; content: string }[];
  message: string;
  runningTasks?: { id: string; prompt: string; startedAt: Date }[];
}): Promise<string> {
  const resuming = isSessionValid();
  const prompt = buildPrompt(opts, resuming);

  const sessionTag = resuming
    ? ` [resuming ${currentSessionId!.slice(0, 8)}…]`
    : " [fresh session]";
  console.log(
    `[brain] calling claude with ${opts.history.length} history messages + current message (${opts.message.length} chars)${sessionTag}`,
  );

  const args = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--model", EGG_MODEL];
  if (resuming) {
    args.push("--resume", currentSessionId!);
  }

  try {
    const stdout = await spawnBrainProcess(args, prompt);
    const { reply, sessionId: newSessionId } = parseJsonOutput(stdout);

    // Update session tracking
    if (newSessionId) {
      if (!resuming) {
        sessionCreatedAt = Date.now();
        logBrainSession("new", newSessionId);
      } else {
        logBrainSession("reused", newSessionId);
      }
      currentSessionId = newSessionId;
      saveSessionToDisk();
    }

    return reply;
  } catch (err) {
    // If we were resuming, clear session and retry with a fresh one
    if (resuming) {
      console.warn("[brain] resume failed, retrying with fresh session");
      logBrainSession("resume-failed", currentSessionId!);
      clearBrainSession();

      try {
        const freshPrompt = buildPrompt(opts, false);
        const freshArgs = [
          "-p", freshPrompt, "--output-format", "json",
          "--dangerously-skip-permissions", "--model", EGG_MODEL,
        ];

        const stdout = await spawnBrainProcess(freshArgs, freshPrompt);
        const { reply, sessionId: newSessionId } = parseJsonOutput(stdout);

        if (newSessionId) {
          currentSessionId = newSessionId;
          sessionCreatedAt = Date.now();
          logBrainSession("new-after-retry", newSessionId);
          saveSessionToDisk();
        }

        return reply;
      } catch (retryErr) {
        clearBrainSession();
        throw retryErr;
      }
    }

    clearBrainSession();
    throw err;
  }
}
