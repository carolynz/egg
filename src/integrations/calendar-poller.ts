import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  getGoogleOAuthConfig,
  loadAllAccounts,
} from "./google.js";
import { intakeCalendar } from "./gcal.js";
import { CALENDAR_POLL_INTERVAL_MS } from "../config.js";
import { CALENDAR_POLLER_LOG } from "../logger.js";

function logCalendar(message: string): void {
  console.log(`[calendar-poller] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(CALENDAR_POLLER_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function hasGoogleCredentials(): boolean {
  const config = getGoogleOAuthConfig();
  if (!config) return false;
  const accounts = loadAllAccounts();
  return accounts.length > 0;
}

export class CalendarPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly hasCredentials: boolean;

  constructor() {
    this.hasCredentials = hasGoogleCredentials();
  }

  start(): void {
    if (!this.hasCredentials) {
      logCalendar("No Google credentials found — calendar poller disabled");
      return;
    }

    const intervalMin = Math.round(CALENDAR_POLL_INTERVAL_MS / 60_000);
    logCalendar(`Calendar poller starting (every ${intervalMin} minutes)`);
    // First run after 4 minutes (staggered after email poller at 3min)
    setTimeout(() => void this.poll(), 4 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), CALENDAR_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    logCalendar("Starting Calendar ingest...");
    try {
      await intakeCalendar();
      logCalendar("Calendar ingest complete");
    } catch (err) {
      logCalendar(`ERROR in Calendar ingest: ${err}`);
    }
  }
}
