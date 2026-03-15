import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { basename } from "path";
import {
  BLUEBUBBLES_URL,
  BLUEBUBBLES_PASSWORD,
  getEggUserPhone,
} from "../config.js";

function encodeGuid(guid: string): string {
  return encodeURIComponent(guid);
}

export class BlueBubblesClient {
  private baseUrl: string;
  private password: string;
  private chatGuid: string;
  private chatGuidEncoded: string;
  available = false;
  privateApi = false;

  constructor() {
    this.baseUrl = BLUEBUBBLES_URL;
    this.password = BLUEBUBBLES_PASSWORD;
    const phone = getEggUserPhone();
    this.chatGuid = phone ? `iMessage;-;${phone}` : "";
    this.chatGuidEncoded = encodeGuid(this.chatGuid);
  }

  async init(): Promise<void> {
    if (!this.baseUrl || !this.password) {
      console.log("BlueBubbles not configured — rich features disabled");
      return;
    }
    if (await this.ping()) {
      this.available = true;
      await this.checkPrivateApi();
      if (this.privateApi) {
        console.log(`BlueBubbles connected at ${this.baseUrl} (Private API active)`);
      } else {
        console.log(`BlueBubbles connected at ${this.baseUrl} (Private API NOT connected)`);
      }
    } else {
      console.log(`BlueBubbles unreachable at ${this.baseUrl} — falling back to AppleScript`);
    }
  }

  private params(): string {
    return `password=${encodeURIComponent(this.password)}`;
  }

  private async post(path: string, json?: Record<string, unknown>): Promise<Response | null> {
    try {
      const resp = await fetch(`${this.baseUrl}${path}?${this.params()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json ?? {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.warn(`BlueBubbles POST ${path} → ${resp.status}: ${body.slice(0, 200)}`);
        return null;
      }
      return resp;
    } catch {
      return null;
    }
  }

  private async get(path: string): Promise<Response | null> {
    try {
      const resp = await fetch(`${this.baseUrl}${path}?${this.params()}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return null;
      return resp;
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    const resp = await this.get("/api/v1/server/info");
    return resp !== null;
  }

  private async checkPrivateApi(): Promise<void> {
    const resp = await this.get("/api/v1/server/info");
    if (!resp) return;
    try {
      const data = (await resp.json()) as { data?: { private_api?: boolean } };
      this.privateApi = data?.data?.private_api ?? false;
    } catch {
      this.privateApi = false;
    }
  }

  async sendText(text: string): Promise<boolean> {
    if (!this.available || !this.chatGuid) return false;
    const method = this.privateApi ? "private-api" : "apple-script";
    const resp = await this.post("/api/v1/message/text", {
      chatGuid: this.chatGuid,
      message: text,
      method,
      tempGuid: `temp-${randomUUID()}`,
    });
    return resp !== null;
  }

  async sendTextTo(phone: string, text: string): Promise<boolean> {
    if (!this.available) return false;
    const chatGuid = `iMessage;-;${phone}`;
    const method = this.privateApi ? "private-api" : "apple-script";
    const resp = await this.post("/api/v1/message/text", {
      chatGuid,
      message: text,
      method,
      tempGuid: `temp-${randomUUID()}`,
    });
    return resp !== null;
  }

  async startTyping(): Promise<void> {
    if (!this.available || !this.privateApi || !this.chatGuid) return;
    await this.post(`/api/v1/chat/${this.chatGuidEncoded}/typing`, {
      status: "started",
    });
  }

  async stopTyping(): Promise<void> {
    if (!this.available || !this.privateApi || !this.chatGuid) return;
    await this.post(`/api/v1/chat/${this.chatGuidEncoded}/typing`, {
      status: "stopped",
    });
  }

  async markRead(): Promise<void> {
    if (!this.available || !this.privateApi || !this.chatGuid) return;
    await this.post(`/api/v1/chat/${this.chatGuidEncoded}/read`);
  }

  async sendAttachment(filepath: string): Promise<boolean> {
    if (!this.available || !this.chatGuid) return false;

    const fileData = readFileSync(filepath);
    const filename = basename(filepath);
    const form = new FormData();
    form.append("chatGuid", this.chatGuid);
    form.append("name", filename);
    form.append("method", this.privateApi ? "private-api" : "apple-script");
    form.append("tempGuid", `temp-${randomUUID()}`);
    form.append("attachment", new Blob([fileData], { type: "image/png" }), filename);

    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/message/attachment?${this.params()}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.warn(`BlueBubbles sendAttachment → ${resp.status}: ${body.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("BlueBubbles sendAttachment failed:", err);
      return false;
    }
  }
}
