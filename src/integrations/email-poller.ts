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
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private readonly hasCredentials: boolean;
  private lastFullIngestDate: string | null = null;
  private fullIngestRunning = false;

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
    // Full ingest on startup after 3 minutes (let other systems initialize).
    // Incremental polling starts only after the startup ingest finishes,
    // so we don't race the interval against the startup ingest.
    this.startupTimeoutId = setTimeout(() => void this.startupPoll(), 3 * 60_000);
  }

  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Full ingest on startup, then start the regular poll interval. */
  private async startupPoll(): Promise<void> {
    this.startupTimeoutId = null;
    await this.runFullIngest("startup");
    await this.incrementalCheck();

    // Now start the regular interval — no overlap with startup ingest.
    this.intervalId = setInterval(() => void this.poll(), EMAIL_POLL_INTERVAL_MS);
  }

  /** Regular poll: incremental check, plus full ingest once per day. */
  private async poll(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastFullIngestDate !== today) {
      await this.runFullIngest("daily");
    }

    await this.incrementalCheck();
  }

  /** Run a full Gmail ingest with a concurrency guard. */
  private async runFullIngest(reason: string): Promise<void> {
    if (this.fullIngestRunning) {
      logEmail(`Skipping ${reason} full Gmail ingest — already running`);
      return;
    }

    this.fullIngestRunning = true;
    logEmail(`Starting ${reason} full Gmail ingest...`);
    try {
      await intakeGmail();
      this.lastFullIngestDate = new Date().toISOString().slice(0, 10);
      logEmail(`${reason} full Gmail ingest complete`);
    } catch (err) {
      logEmail(`ERROR in ${reason} full Gmail ingest: ${err}`);
    } finally {
      this.fullIngestRunning = false;
    }
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
