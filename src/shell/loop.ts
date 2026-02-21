import { getEggMessages, Message } from "./imessage-reader.js";
import { BlueBubblesClient } from "./bluebubbles.js";
import { Sender } from "./sender.js";
import { loadState, saveState, ShellState } from "./state.js";
import { callBrain } from "../brain/index.js";
import { EGG_USER_PHONE, NUDGES_DIR, NUDGES_SENT_DIR } from "../config.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ShellLoop {
  private bb: BlueBubblesClient;
  private sender: Sender;
  private state: ShellState;
  private seenSet: Set<number>;
  private userPhoneNorm: string;
  private running = false;

  constructor(bbOnly: boolean) {
    this.bb = new BlueBubblesClient();
    this.sender = new Sender(this.bb, bbOnly);
    this.state = loadState();
    this.seenSet = new Set(this.state.seenRowids);
    this.userPhoneNorm = normalizePhone(EGG_USER_PHONE);
  }

  async init(): Promise<void> {
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
    const forward = `[Someone texted Egg] From ${msg.sender}: ${msg.text}`;
    console.log(`Forwarding stranger message from ${msg.sender}`);
    await this.sender.send(forward);
  }

  private async sendReply(text: string): Promise<boolean> {
    const chunks = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (chunks.length === 0) return false;

    let success = false;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await this.bb.startTyping();
        const delay = Math.min(3000, Math.max(800, chunks[i].length * 5));
        await sleep(delay);
      }
      const sent = await this.sender.send(chunks[i]);
      if (sent) success = true;
      else console.error(`Failed to send chunk ${i + 1}/${chunks.length}`);
    }
    return success;
  }

  private async handleStartupRecovery(): Promise<void> {
    if (!this.state.pendingMessage) return;

    console.log(`Recovering unreplied message: ${this.state.pendingMessage.slice(0, 100)}`);
    try {
      await this.bb.startTyping();
      const reply = await callBrain({
        history: this.state.history,
        message: this.state.pendingMessage,
      });
      if (reply) {
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

  private async deliverNudges(): Promise<void> {
    if (!existsSync(NUDGES_DIR)) return;
    const files = readdirSync(NUDGES_DIR).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return;

    mkdirSync(NUDGES_SENT_DIR, { recursive: true });
    for (const file of files) {
      const filePath = join(NUDGES_DIR, file);
      const text = readFileSync(filePath, "utf-8").trim();
      if (!text) continue;

      console.log(`Delivering nudge: ${file}`);
      await this.sendReply(text);
      renameSync(filePath, join(NUDGES_SENT_DIR, file));
    }
  }

  async pollOnce(): Promise<boolean> {
    // 0. Deliver any pending nudges
    await this.deliverNudges();

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

    // Track ROWIDs
    for (const m of newMsgs) this.seenSet.add(m.rowid);
    if (this.seenSet.size > 200) {
      const cutoff = this.state.lastRowid - 50;
      this.seenSet = new Set([...this.seenSet].filter((r) => r > cutoff));
    }

    // 2. Separate reactions from normal messages
    const normal = newMsgs.filter((m) => !m.reactionType);
    let inbound = normal.filter((m) => !m.isFromMe);
    this.state.lastRowid = maxRowid;

    if (inbound.length === 0) {
      this.persist();
      return false;
    }

    // EARLY SAVE
    this.persist();

    // 3. Stranger check
    const strangers = inbound.filter((m) => this.isStranger(m.sender));
    inbound = inbound.filter((m) => !this.isStranger(m.sender));

    for (const s of strangers) await this.forwardStranger(s);
    if (inbound.length === 0) return false;

    // 4. Debounce: wait for user to finish typing
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
    }

    // 5. Mark read, start typing
    await this.bb.markRead();
    await this.bb.startTyping();

    // 6. Combine batched messages
    const combinedText = inbound.map((m) => m.text).join("\n");
    console.log(`Received ${inbound.length} message(s): ${combinedText.slice(0, 100)}`);

    this.state.history.push({ role: "user", content: combinedText });

    // PENDING: mark as awaiting reply
    this.state.pendingMessage = combinedText;
    this.persist();

    // 7. Get reply from brain
    let reply: string;
    try {
      reply = await callBrain({
        history: this.state.history.slice(0, -1), // exclude the just-added user msg
        message: combinedText,
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

    // 8. Send reply
    const success = await this.sendReply(reply);
    await this.bb.stopTyping();

    if (!success) console.error("Failed to send reply");

    // 9. Update history, clear pending
    this.state.history.push({ role: "assistant", content: reply });
    this.state.pendingMessage = null;
    this.persist();

    return success;
  }

  async run(): Promise<void> {
    this.running = true;

    const shutdown = () => {
      console.log("Shutting down — saving state");
      this.running = false;
      this.persist();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await this.handleStartupRecovery();

    console.log("Shell loop starting (poll every 3s)");
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error("Poll error:", err);
      }
      await sleep(3000);
    }
  }
}
