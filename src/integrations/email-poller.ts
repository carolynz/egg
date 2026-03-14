import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  getGoogleOAuthConfig,
  loadAllAccounts,
} from "./google.js";
import { intakeGmail } from "./gmail.js";
import { checkNewEmails } from "./email-check.js";
import { EMAIL_POLL_INTERVAL_MS } from "../config.js";
import { EMAIL_POLLER_LOG } from "../logger.js";

function logEmail(message: string): void {
  console.log(`[email-poller] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(EMAIL_POLLER_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function hasGoogleCredentials(): boolean {
  const config = getGoogleOAuthConfig();
  if (!config) return false;
  const accounts = loadAllAccounts();
  return accounts.length > 0;
}

export class EmailPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly hasCredentials: boolean;

  constructor() {
    this.hasCredentials = hasGoogleCredentials();
  }

  start(): void {
    if (!this.hasCredentials) {
      logEmail("No Google credentials found — email poller disabled");
      return;
    }

    const intervalMin = Math.round(EMAIL_POLL_INTERVAL_MS / 60_000);
    logEmail(`Email poller starting (every ${intervalMin} minutes)`);
    // First run after 3 minutes (let other systems initialize)
    setTimeout(() => void this.poll(), 3 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), EMAIL_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    // Gmail ingest (full intake — writes to egg-memory)
    logEmail("Starting Gmail ingest...");
    try {
      await intakeGmail();
      logEmail("Gmail ingest complete");
    } catch (err) {
      logEmail(`ERROR in Gmail ingest: ${err}`);
    }

    // Fast email check (notifications, reply tracking)
    logEmail("Starting email check...");
    try {
      await checkNewEmails();
      logEmail("Email check complete");
    } catch (err) {
      logEmail(`ERROR in email check: ${err}`);
    }
  }
}
