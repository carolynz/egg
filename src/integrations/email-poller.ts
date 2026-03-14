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
  private lastFullIngestDate: string | null = null;

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
    // Startup run does a full ingest + incremental check
    setTimeout(() => void this.startupPoll(), 3 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), EMAIL_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Full ingest on startup, then incremental check. */
  private async startupPoll(): Promise<void> {
    logEmail("Starting full Gmail ingest (startup)...");
    try {
      await intakeGmail();
      this.lastFullIngestDate = new Date().toISOString().slice(0, 10);
      logEmail("Full Gmail ingest complete (startup)");
    } catch (err) {
      logEmail(`ERROR in Gmail ingest (startup): ${err}`);
    }

    await this.incrementalCheck();
  }

  /** Regular poll: incremental check only. Run full ingest once per day. */
  private async poll(): Promise<void> {
    // Run full ingest once per day (if we haven't already today)
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastFullIngestDate !== today) {
      logEmail("Starting daily full Gmail ingest...");
      try {
        await intakeGmail();
        this.lastFullIngestDate = today;
        logEmail("Daily full Gmail ingest complete");
      } catch (err) {
        logEmail(`ERROR in daily Gmail ingest: ${err}`);
      }
    }

    await this.incrementalCheck();
  }

  private async incrementalCheck(): Promise<void> {
    logEmail("Starting incremental email check...");
    try {
      await checkNewEmails();
      logEmail("Email check complete");
    } catch (err) {
      logEmail(`ERROR in email check: ${err}`);
    }
  }
}
