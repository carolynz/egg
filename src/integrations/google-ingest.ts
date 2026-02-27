import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  getGoogleOAuthConfig,
  loadAllAccounts,
} from "./google.js";
import { intakeGmail } from "./gmail.js";
import { intakeCalendar } from "./gcal.js";
import { EGG_MEMORY_DIR, GOOGLE_INGEST_INTERVAL_MS } from "../config.js";
import { GOOGLE_INGEST_LOG } from "../logger.js";

const CURSOR_FILE = join(EGG_MEMORY_DIR, "data", "google-ingest-cursor.json");

interface IngestCursor {
  lastGmailRunAt: number;    // unix ms
  lastGcalRunAt: number;     // unix ms
}

function logIngest(message: string): void {
  console.log(`[google-ingest] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(GOOGLE_INGEST_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function loadCursor(): IngestCursor {
  try {
    if (existsSync(CURSOR_FILE)) {
      return JSON.parse(readFileSync(CURSOR_FILE, "utf-8"));
    }
  } catch {}
  return { lastGmailRunAt: 0, lastGcalRunAt: 0 };
}

function saveCursor(cursor: IngestCursor): void {
  try {
    mkdirSync(join(EGG_MEMORY_DIR, "data"), { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
  } catch (err) {
    logIngest(`ERROR saving cursor: ${err}`);
  }
}

function hasGoogleCredentials(): boolean {
  const config = getGoogleOAuthConfig();
  if (!config) return false;
  const accounts = loadAllAccounts();
  return accounts.length > 0;
}

export class GoogleIngestPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly hasCredentials: boolean;

  constructor() {
    this.hasCredentials = hasGoogleCredentials();
  }

  start(): void {
    if (!this.hasCredentials) {
      logIngest("No Google credentials found — Gmail/Calendar ingest disabled");
      return;
    }

    const intervalMin = Math.round(GOOGLE_INGEST_INTERVAL_MS / 60_000);
    logIngest(`Google ingest poller starting (every ${intervalMin} minutes)`);
    // First run after 3 minutes (let other systems initialize)
    setTimeout(() => void this.poll(), 3 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), GOOGLE_INGEST_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    const cursor = loadCursor();
    const now = Date.now();

    // Run Gmail if enough time has passed
    if (now - cursor.lastGmailRunAt >= GOOGLE_INGEST_INTERVAL_MS) {
      logIngest("Starting Gmail ingest...");
      try {
        await intakeGmail();
        cursor.lastGmailRunAt = Date.now();
        logIngest("Gmail ingest complete");
      } catch (err) {
        logIngest(`ERROR in Gmail ingest: ${err}`);
      }
    }

    // Run Calendar if enough time has passed
    if (now - cursor.lastGcalRunAt >= GOOGLE_INGEST_INTERVAL_MS) {
      logIngest("Starting Calendar ingest...");
      try {
        await intakeCalendar();
        cursor.lastGcalRunAt = Date.now();
        logIngest("Calendar ingest complete");
      } catch (err) {
        logIngest(`ERROR in Calendar ingest: ${err}`);
      }
    }

    saveCursor(cursor);
  }
}
