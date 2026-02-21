import { spawn } from "child_process";
import { EGG_BRAIN, EGG_MEMORY_DIR } from "../config.js";
import { logBrainStart, logBrainEnd } from "../logger.js";

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

export async function callBrain(opts: {
  history: { role: string; content: string }[];
  message: string;
  runningTasks?: { id: string; prompt: string; startedAt: Date }[];
}): Promise<string> {
  // Format conversation history + new message as a single prompt
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

  if (opts.history.length > 0) {
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

  // Strip null bytes and other control chars that break child_process.spawn args
  const prompt = lines.join("\n").replace(/\x00/g, "").replace(/[\x01-\x08\x0e-\x1f]/g, "");

  console.log(`[brain] calling claude with ${opts.history.length} history messages + current message (${opts.message.length} chars)`);
  logBrainStart(prompt);
  const brainStartTime = Date.now();

  const args = ["-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(EGG_BRAIN, args, {
      cwd: EGG_MEMORY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      logBrainEnd(code, Date.now() - brainStartTime);
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
