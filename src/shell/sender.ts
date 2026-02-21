import { BlueBubblesClient } from "./bluebubbles.js";
import { sendAsEgg } from "./applescript.js";

export class Sender {
  private bb: BlueBubblesClient;
  private bbOnly: boolean;

  constructor(bb: BlueBubblesClient, bbOnly: boolean) {
    this.bb = bb;
    this.bbOnly = bbOnly;
  }

  async send(text: string): Promise<boolean> {
    const sent = await this.bb.sendText(text);
    if (sent) return true;
    if (this.bbOnly) return false;
    return sendAsEgg(text);
  }
}
