import { BlueBubblesClient } from "./bluebubbles.js";
import { sendAsEgg, sendFileAsEgg } from "./applescript.js";

const DEDUP_WINDOW_MS = 5_000;

export class Sender {
  private bb: BlueBubblesClient;
  private bbOnly: boolean;
  private recentSends = new Map<string, number>();

  constructor(bb: BlueBubblesClient, bbOnly: boolean) {
    this.bb = bb;
    this.bbOnly = bbOnly;
  }

  async sendImage(filepath: string): Promise<boolean> {
    const sent = await this.bb.sendAttachment(filepath);
    if (sent) return true;
    if (this.bbOnly || this.bb.available) return false;
    return sendFileAsEgg(filepath);
  }

  async send(text: string): Promise<boolean> {
    const now = Date.now();

    // Deduplication guard: suppress identical sends within a short window.
    // This prevents double-sends when BB returns an error but already delivered
    // the message, or when recovery fires for an already-sent reply.
    const lastSent = this.recentSends.get(text);
    if (lastSent !== undefined && now - lastSent < DEDUP_WINDOW_MS) {
      console.warn(`[send] dedup guard: suppressing identical send within ${DEDUP_WINDOW_MS}ms`);
      return true;
    }
    this.recentSends.set(text, now);
    for (const [k, t] of this.recentSends.entries()) {
      if (now - t > DEDUP_WINDOW_MS) this.recentSends.delete(k);
    }

    const sent = await this.bb.sendText(text);
    if (sent) return true;

    // If BB is available (configured and reachable), don't fall back to
    // AppleScript. When BB uses its apple-script method (Private API off) and
    // returns a non-OK response, the message may have already been delivered —
    // a fallback would produce a duplicate.
    if (this.bbOnly || this.bb.available) return false;

    return sendAsEgg(text);
  }
}
