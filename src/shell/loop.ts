import { getEggMessages, Message, Attachment } from "./imessage-reader.js";
import { BlueBubblesClient } from "./bluebubbles.js";
import { Sender } from "./sender.js";
import { loadState, saveState, ShellState } from "./state.js";
import { callBrain, initBrainSession } from "../brain/index.js";
import { getEggUserPhone, NUDGES_DIR, NUDGES_SENT_DIR } from "../config.js";
import { TaskRunner } from "./tasks.js";
import { generateImage } from "./image-gen.js";
import { OuraPoller } from "../integrations/oura.js";
import { HeartbeatPoller } from "../integrations/heartbeat.js";
import { ImessageIngestPoller } from "../senses/imessage-ingest.js";
import { GoogleIngestPoller } from "../integrations/google-ingest.js";
import {
  recordTokenUsage,
  getDailySummary,
  formatSummaryMessages,
  formatSummaryLogLine,
  getPacificDate,
  getPacificHour,
  loadTokenState,
  saveTokenState,
} from "../token-tracker.js";
import { logApiSpend } from "../logger.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from "fs";
import { join, extname } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
]);

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const EXTENSION_TO_MEDIA_TYPE: Record<string, ImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

let anthropicClient: Anthropic | null = null;
let anthropicKeyMissing = false;
function getAnthropicClient(): Anthropic | null {
  if (anthropicKeyMissing) return null;
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("ANTHROPIC_API_KEY not set — image captioning disabled");
      anthropicKeyMissing = true;
      return null;
    }
    anthropicClient = new Anthropic();
    console.log("[attach] anthropic client initialized for image captioning");
  }
  return anthropicClient;
}

async function captionImage(filepath: string): Promise<string> {
  console.log("[attach] captioning image:", filepath);
  if (!existsSync(filepath)) {
    console.error(`captionImage: file does not exist: ${filepath}`);
    return "attachment";
  }
  if (!getAnthropicClient()) return "attachment";

  try {
    const ext = extname(filepath).toLowerCase();
    const fileStat = statSync(filepath);
    console.log(`captionImage: ${filepath} (ext=${ext}, size=${fileStat.size} bytes)`);

    let mediaType = EXTENSION_TO_MEDIA_TYPE[ext];
    let imageData: string;
    let tmpFile: string | null = null;

    if (HEIC_EXTENSIONS.has(ext)) {
      // HEIC/HEIF not supported by the API — convert to JPEG via sips
      try {
        tmpFile = join(tmpdir(), `egg-heic-${Date.now()}.jpg`);
        execSync(`sips -s format jpeg ${JSON.stringify(filepath)} --out ${JSON.stringify(tmpFile)}`, {
          stdio: "pipe",
          timeout: 15_000,
        });
        if (!existsSync(tmpFile) || statSync(tmpFile).size === 0) {
          console.error(`HEIC conversion produced empty/missing file: ${tmpFile}`);
          return "image (HEIC)";
        }
        imageData = readFileSync(tmpFile).toString("base64");
        mediaType = "image/jpeg";
      } catch (err) {
        console.error("HEIC conversion failed:", err);
        return "image (HEIC)";
      }
    } else {
      if (!mediaType) return "image";
      imageData = readFileSync(filepath).toString("base64");
    }

    if (!imageData || imageData.length < 100) {
      console.error(`Image data too small or empty: ${filepath} (${imageData?.length ?? 0} base64 chars)`);
      return "image";
    }
    const client = getAnthropicClient();
    if (!client) return "attachment";

    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageData },
              },
              {
                type: "text",
                text: "Describe this image in one short sentence (under 15 words). Just the description, no preamble.",
              },
            ],
          },
        ],
      });

      recordTokenUsage("claude-haiku-4-5-20251001", response.usage.input_tokens, response.usage.output_tokens);
      const textBlock = response.content.find((b) => b.type === "text");
      const description = textBlock && "text" in textBlock ? textBlock.text.trim() : "";
      console.log("[attach] caption:", description);
      return description || "image";
    } finally {
      if (tmpFile) {
        try { unlinkSync(tmpFile); } catch {}
      }
    }
  } catch (error) {
    console.error("[attach] captioning failed:", error);
    return "attachment";
  }
}

async function processAttachments(attachments: Attachment[]): Promise<string[]> {
  console.log(`[attach] processing ${attachments.length} attachment(s) for message`);
  const captions: string[] = [];
  for (const att of attachments) {
    if (IMAGE_MIME_TYPES.has(att.mimeType.toLowerCase())) {
      const caption = await captionImage(att.filename);
      captions.push(`[image: ${caption}]`);
      console.log(`[attach] ${att.filename} → image (caption: "${caption}")`);
    } else {
      captions.push(`[attachment: ${att.mimeType}]`);
      console.warn(`[attach] ${att.filename} → skipped (not image: ${att.mimeType})`);
    }
  }
  return captions;
}

export class ShellLoop {
  private bb: BlueBubblesClient;
  private sender: Sender;
  private taskRunner: TaskRunner;
  private ouraPoller: OuraPoller;
  private heartbeatPoller: HeartbeatPoller;
  private imessageIngestPoller: ImessageIngestPoller;
  private googleIngestPoller: GoogleIngestPoller;
  private state: ShellState;
  private seenSet: Set<number>;
  private userPhoneNorm: string;
  private running = false;
  private lastDailySummaryDate: string = loadTokenState().lastSentDate;

  constructor(bbOnly: boolean) {
    this.bb = new BlueBubblesClient();
    this.sender = new Sender(this.bb, bbOnly);
    this.state = loadState();
    this.seenSet = new Set(this.state.seenRowids);
    this.userPhoneNorm = normalizePhone(getEggUserPhone());
    this.taskRunner = new TaskRunner(this.sender, (text) => {
      this.state.history.push({ role: "assistant", content: text });
      this.persist();
    });
    this.ouraPoller = new OuraPoller();
    this.heartbeatPoller = new HeartbeatPoller();
    this.imessageIngestPoller = new ImessageIngestPoller();
    this.googleIngestPoller = new GoogleIngestPoller();
  }

  async init(): Promise<void> {
    initBrainSession();
    await this.bb.init();
  }

  private persist(): void {
    this.state.seenRowids = [...this.seenSet];
    saveState(this.state);
  }

  private isStranger(sender: string): boolean {
    if (!sender || !this.userPhoneNorm) return false;
    return normalizePhone(sender) !== this.userPhoneNorm;
  }

  private async forwardStranger(msg: Message): Promise<void> {
    let content = msg.text;
    if (msg.attachments && msg.attachments.length > 0) {
      const attDesc = msg.attachments.map((a) => `[attachment: ${a.mimeType}]`).join(" ");
      content = content ? `${attDesc} ${content}` : attDesc;
    }
    const forward = `[Someone texted Egg] From ${msg.sender}: ${content}`;
    console.log(`Forwarding stranger message from ${msg.sender}`);
    await this.sender.send(forward);
  }

  // Matches [IMAGE: some description] on its own line (case-insensitive)
  private static readonly IMAGE_MARKER_RE = /^\[IMAGE:\s*(.+?)\]$/i;

  // Matches [TIMER: 90s: follow-up message] on its own line (case-insensitive)
  // Unit can be s/sec/second/seconds/m/min/minute/minutes/h/hr/hour/hours
  private static readonly TIMER_MARKER_RE = /^\[TIMER:\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?::\s*(.+))?\]$/i;

  /**
   * Scan a brain reply for [TIMER: ...] markers. For each one found:
   *   - write a scheduled nudge file to NUDGES_DIR/<dueAt_ms>.md
   *   - strip the marker line from the reply
   * Returns the cleaned reply and the number of timers scheduled.
   */
  private scheduleTimerNudges(reply: string): { cleaned: string; count: number } {
    const lines = reply.split("\n");
    const kept: string[] = [];
    let count = 0;

    for (const line of lines) {
      const match = line.trim().match(ShellLoop.TIMER_MARKER_RE);
      if (!match) {
        kept.push(line);
        continue;
      }

      const value = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      const message = match[3]?.trim() || "⏱ timer done";

      let ms: number;
      if (unit.startsWith("h")) {
        ms = value * 3_600_000;
      } else if (unit.startsWith("m")) {
        ms = value * 60_000;
      } else {
        ms = value * 1_000;
      }

      const dueAt = Date.now() + ms;
      mkdirSync(NUDGES_DIR, { recursive: true });
      writeFileSync(join(NUDGES_DIR, `${dueAt}.md`), message);
      console.log(`[timer] scheduled: "${message}" in ${Math.round(ms / 1000)}s (due ${new Date(dueAt).toISOString()})`);
      count++;
    }

    return { cleaned: kept.join("\n"), count };
  }

  private async sendReply(text: string): Promise<boolean> {
    const raw = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (raw.length === 0) return false;

    // Deduplicate adjacent identical lines — guards against the brain
    // repeating a sentence or the reply being re-sent after a restart.
    const chunks = raw.filter((c, i) => i === 0 || c !== raw[i - 1]);
    if (chunks.length < raw.length) {
      console.warn(`[send] deduped ${raw.length - chunks.length} repeated chunk(s)`);
    }

    let success = false;
    let sentAny = false;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const imageMatch = chunk.match(ShellLoop.IMAGE_MARKER_RE);

      if (imageMatch) {
        const prompt = imageMatch[1].trim();
        console.log(`[send] image chunk ${i + 1}/${chunks.length}: "${prompt.slice(0, 80)}"`);
        const filepath = await generateImage(prompt);
        if (filepath) {
          const sent = await this.sender.sendImage(filepath);
          if (sent) { success = true; sentAny = true; }
          else console.error(`[send] Failed to send image chunk ${i + 1}/${chunks.length}`);
          try { unlinkSync(filepath); } catch {}
        } else {
          // Image generation unavailable or failed — send a brief text fallback
          console.warn(`[send] image generation failed, sending text fallback`);
          const sent = await this.sender.send(`[couldn't generate image]`);
          if (sent) { success = true; sentAny = true; }
        }
      } else {
        let delay = 0;
        if (sentAny) {
          await this.bb.startTyping();
          delay = Math.min(3000, Math.max(800, chunk.length * 5));
          await sleep(delay);
        }
        const preview = chunk.length > 80 ? chunk.slice(0, 80) + "..." : chunk;
        console.log(`[send] chunk ${i + 1}/${chunks.length}: "${preview}" (${delay}ms delay)`);
        const sent = await this.sender.send(chunk);
        if (sent) { success = true; sentAny = true; }
        else console.error(`[send] Failed to send chunk ${i + 1}/${chunks.length}`);
      }
    }
    console.log(`[send] all ${chunks.length} chunk(s) delivered`);
    return success;
  }

  private async handleStartupRecovery(): Promise<void> {
    // Send reboot confirmation if we restarted after a task
    if (this.state.restarting) {
      console.log("Restarted after task — sending reboot confirmation");
      await this.sender.send("🥚 rebooted");
      this.state.history.push({ role: "assistant", content: "🥚 rebooted" });
      this.state.restarting = false;
      // Clear any pending message: a task restart via process.exit() can
      // interrupt a reply mid-send. Attempting recovery here would send it
      // a second time. Drop it — the next message from the user continues
      // the conversation naturally.
      this.state.pendingMessage = null;
      this.persist();
      return;
    }

    if (!this.state.pendingMessage) return;

    console.log(`--- Recovering unreplied message ---`);
    console.log(this.state.pendingMessage);
    console.log(`--- End recovery message (${this.state.pendingMessage.length} chars) ---`);
    try {
      await this.bb.startTyping();
      const reply = await callBrain({
        history: this.state.history,
        message: this.state.pendingMessage,
      });
      if (reply) {
        console.log(`--- Egg reply (recovery) ---`);
        console.log(reply);
        console.log(`--- End reply (${reply.length} chars) ---`);
        await this.sendReply(reply);
        this.state.history.push({ role: "assistant", content: reply });
      }
      await this.bb.stopTyping();
    } catch (err) {
      console.error("Failed to recover pending message:", err);
    }
    this.state.pendingMessage = null;
    this.persist();
  }

  private isCancelIntent(text: string): boolean {
    const t = text.toLowerCase().trim();
    // Standalone cancel words (whole message)
    if (/^(stop|cancel|abort|nvm|nevermind|never mind|kill it|kill that|forget it)[\s!.?]*$/.test(t)) return true;
    // "cancel/stop/abort/kill + that/it/task/this"
    if (/\b(cancel|stop|abort|kill)\b.{0,30}\b(that|it|the task|this task|task)\b/.test(t)) return true;
    // "never mind" / "forget it" as phrases
    if (/\b(never\s*mind|forget\s*it)\b/.test(t)) return true;
    return false;
  }

  private startNudgeWatcher(): void {
    mkdirSync(NUDGES_DIR, { recursive: true });
    let delivering = false;
    const watcher = watch(NUDGES_DIR, async (event, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      if (delivering) return;
      delivering = true;
      // Small delay to ensure the file is fully written before we read it
      await sleep(300);
      try {
        await this.deliverNudges();
      } catch (err) {
        console.error("[nudge-watcher] error delivering nudge:", err);
      } finally {
        delivering = false;
      }
    });
    console.log(`[nudge-watcher] watching ${NUDGES_DIR}`);
    process.on("exit", () => watcher.close());
  }

  private async deliverNudges(): Promise<void> {
    if (!existsSync(NUDGES_DIR)) return;
    const files = readdirSync(NUDGES_DIR).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return;

    const now = Date.now();
    mkdirSync(NUDGES_SENT_DIR, { recursive: true });
    for (const file of files) {
      // Timer nudges are named <unix_ms>.md — skip if not yet due
      const stem = file.slice(0, -3);
      if (/^\d+$/.test(stem)) {
        const dueAt = parseInt(stem, 10);
        if (dueAt > now) {
          console.log(`[timer] nudge ${file} not due yet (${Math.ceil((dueAt - now) / 1000)}s remaining)`);
          continue;
        }
      }

      const filePath = join(NUDGES_DIR, file);
      const sentPath = join(NUDGES_SENT_DIR, file);

      // Skip nudges older than 24 hours
      const ageMs = Date.now() - statSync(filePath).mtimeMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        console.warn(`[nudge] skipping stale nudge ${file} (${Math.round(ageMs / 3_600_000)}h old)`);
        renameSync(filePath, sentPath);
        continue;
      }

      const text = readFileSync(filePath, "utf-8").trim();
      if (!text) {
        console.warn(`[nudge] skipping empty nudge file: ${file}`);
        renameSync(filePath, sentPath);
        continue;
      }

      // Claim the file before sending — prevents re-delivery if serve restarts mid-send
      renameSync(filePath, sentPath);
      console.log(`Delivering nudge: ${file}`);
      await this.sendReply(text);
    }
  }

  async pollOnce(): Promise<boolean> {
    // 0. Deliver pending nudges and check for tasks
    await this.deliverNudges();
    await this.taskRunner.checkForTasks();

    // 1. Fetch new messages
    const { messages: newMsgs, maxRowid } = getEggMessages(
      this.state.lastRowid,
      this.seenSet,
    );

    if (newMsgs.length === 0) {
      if (maxRowid > this.state.lastRowid) {
        this.state.lastRowid = maxRowid;
        this.persist();
      }
      return false;
    }

    console.log(`[poll] fetched ${newMsgs.length} raw messages (rowids: ${newMsgs.map((m) => m.rowid).join(", ")})`);

    // Track ROWIDs
    for (const m of newMsgs) this.seenSet.add(m.rowid);
    if (this.seenSet.size > 200) {
      const cutoff = this.state.lastRowid - 50;
      this.seenSet = new Set([...this.seenSet].filter((r) => r > cutoff));
    }

    // 2. Separate reactions from normal messages
    const reactions = newMsgs.filter((m) => m.reactionType);
    const normal = newMsgs.filter((m) => !m.reactionType);
    if (reactions.length > 0) {
      console.warn(`[route] skipping ${reactions.length} reaction(s): ${reactions.map((m) => m.reactionType).join(", ")}`);
    }
    let inbound = normal.filter((m) => !m.isFromMe);
    this.state.lastRowid = maxRowid;

    if (inbound.length === 0) {
      console.log(`[route] no actionable messages after filtering`);
      this.persist();
      return false;
    }

    // EARLY SAVE
    this.persist();

    // 3. Stranger check
    const strangers = inbound.filter((m) => this.isStranger(m.sender));
    inbound = inbound.filter((m) => !this.isStranger(m.sender));

    for (const s of strangers) {
      console.log(`[route] stranger detected: ${s.sender} → forwarding`);
      await this.forwardStranger(s);
    }
    if (inbound.length === 0) {
      console.log(`[route] no actionable messages after filtering`);
      return false;
    }

    const senders = [...new Set(inbound.map((m) => m.sender))].join(", ");
    console.log(`[route] ${inbound.length} inbound user message(s) from ${senders}`);

    // 4. Debounce: wait for user to finish typing
    console.log(`[poll] debouncing — waiting for user to stop typing...`);
    let totalWait = 0;
    while (totalWait < 10_000) {
      await sleep(2000);
      totalWait += 2000;

      const { messages: more, maxRowid: newerRowid } = getEggMessages(
        this.state.lastRowid,
        this.seenSet,
      );
      for (const m of more) this.seenSet.add(m.rowid);

      const moreInbound = more.filter((m) => !m.isFromMe && !m.reactionType);
      if (moreInbound.length === 0) {
        if (newerRowid > this.state.lastRowid) this.state.lastRowid = newerRowid;
        break;
      }
      inbound.push(...moreInbound);
      this.state.lastRowid = newerRowid;
      console.log(`[poll] debounce: +${moreInbound.length} more message(s), total wait ${totalWait}ms`);
    }
    console.log(`[poll] debounce complete — ${inbound.length} total messages batched`);

    // 5. Mark read, start typing
    await this.bb.markRead();
    await this.bb.startTyping();

    // 6. Combine batched messages, processing any image attachments
    const parts: string[] = [];
    for (const m of inbound) {
      let msgContent = "";
      if (m.attachments && m.attachments.length > 0) {
        const captions = await processAttachments(m.attachments);
        msgContent = captions.join("\n");
        if (m.text) msgContent += "\n" + m.text;
      } else {
        msgContent = m.text;
      }
      parts.push(msgContent);
    }
    const combinedText = parts.join("\n");
    console.log(`--- Received ${inbound.length} message(s) ---`);
    console.log(combinedText);
    console.log(`--- End message (${combinedText.length} chars) ---`);

    // 7. Check for cancellation intent before calling brain
    if (this.taskRunner.hasRunningTasks && this.isCancelIntent(combinedText)) {
      console.log(`[cancel] cancellation intent detected: "${combinedText.slice(0, 80)}"`);
      await this.taskRunner.cancelAll();
      await this.bb.stopTyping();
      this.state.lastRowid = maxRowid;
      this.persist();
      return true;
    }

    this.state.history.push({ role: "user", content: combinedText });

    // PENDING: mark as awaiting reply
    this.state.pendingMessage = combinedText;
    this.persist();

    // 8. Get reply from brain
    console.log(`[brain] === PROMPT START ===`);
    console.log(combinedText);
    console.log(`[brain] === PROMPT END ===`);

    let reply: string;
    try {
      reply = await callBrain({
        history: this.state.history.slice(0, -1), // exclude the just-added user msg
        message: combinedText,
        runningTasks: this.taskRunner.runningTaskSummaries,
      });
    } catch (err) {
      console.error("Brain call failed:", err);
      await this.bb.stopTyping();
      this.state.pendingMessage = null;
      this.persist();
      return false;
    }

    if (!reply) {
      console.warn("Brain returned empty reply");
      await this.bb.stopTyping();
      this.state.pendingMessage = null;
      this.persist();
      return false;
    }

    const replyLines = reply.split("\n").filter((l) => l.trim()).length;
    console.log(`[brain] reply received (${reply.length} chars, ${replyLines} lines)`);
    console.log(`--- Egg reply ---`);
    console.log(reply);
    console.log(`--- End reply (${reply.length} chars) ---`);

    // 9a. Extract any timer markers and schedule nudges
    const { cleaned: timerCleaned, count: timerCount } = this.scheduleTimerNudges(reply);
    if (timerCount > 0) {
      console.log(`[timer] stripped ${timerCount} timer marker(s) from reply`);
      reply = timerCleaned;
    }

    // 9. Send reply
    const success = await this.sendReply(reply);
    await this.bb.stopTyping();

    if (!success) console.error("Failed to send reply");

    // 10. Update history, clear pending
    this.state.history.push({ role: "assistant", content: reply });
    this.state.pendingMessage = null;
    this.persist();

    return success;
  }

  private async checkDailySummary(): Promise<void> {
    if (getPacificHour() !== 23) return;
    const today = getPacificDate();
    if (this.lastDailySummaryDate === today) return;

    this.lastDailySummaryDate = today;
    saveTokenState({ lastSentDate: today });

    const summary = getDailySummary(today);
    const msgs = formatSummaryMessages(summary);
    console.log(`[token-tracker] sending daily summary: ${msgs[0]}`);
    try {
      for (const msg of msgs) {
        await this.sender.send(msg);
      }
    } catch (err) {
      console.error("[token-tracker] failed to send daily summary:", err);
    }
    logApiSpend(formatSummaryLogLine(summary));
  }

  async run(): Promise<void> {
    this.running = true;

    const shutdown = () => {
      console.log("Shutting down — saving state");
      this.running = false;
      this.ouraPoller.stop();
      this.heartbeatPoller.stop();
      this.imessageIngestPoller.stop();
      this.googleIngestPoller.stop();
      this.persist();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await this.handleStartupRecovery();
    this.startNudgeWatcher();
    this.ouraPoller.start();
    this.heartbeatPoller.start();
    this.imessageIngestPoller.start();
    this.googleIngestPoller.start();

    console.log("Shell loop starting (poll every 3s)");
    while (this.running) {
      try {
        await this.checkDailySummary();
        await this.pollOnce();
      } catch (err) {
        console.error("Poll error:", err);
      }
      await sleep(3000);
    }
  }
}
