/**
 * TodayRefreshPoller — periodically refreshes today.md during waking hours.
 *
 * Runs every 15 minutes (configurable) between 9 AM and 2 AM ET.
 * Only calls the brain if data sources have changed (calendar, goals,
 * time-based priority shift, or task completion detected).
 */

import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  TODAY_REFRESH_INTERVAL_MS,
  WAKING_HOUR_START,
  WAKING_HOUR_END,
} from "../config.js";
import { refreshTodayMd } from "../senses/daily-planner.js";

const LOG_PATH = join(homedir(), ".egg", "logs", "today-refresh.log");

function log(message: string): void {
  console.log(`[today-refresh] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

/** Check if current hour is within waking hours (handles overnight span like 9AM-2AM) */
function isWakingHour(): boolean {
  const hour = new Date().getHours();
  if (WAKING_HOUR_START < WAKING_HOUR_END) {
    // Simple range (e.g., 9-22)
    return hour >= WAKING_HOUR_START && hour < WAKING_HOUR_END;
  }
  // Overnight range (e.g., 9 AM to 2 AM): active if hour >= start OR hour < end
  return hour >= WAKING_HOUR_START || hour < WAKING_HOUR_END;
}

export class TodayRefreshPoller {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    const intervalMin = Math.round(TODAY_REFRESH_INTERVAL_MS / 60_000);
    log(`Starting (every ${intervalMin} min, waking hours ${WAKING_HOUR_START}:00–${WAKING_HOUR_END}:00)`);
    // First check after 5 minutes (let morning generation complete first)
    setTimeout(() => void this.poll(), 5 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), TODAY_REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      if (!isWakingHour()) {
        log(`Outside waking hours — skipping`);
        return;
      }

      log("Checking for today.md refresh...");
      const result = await refreshTodayMd();
      if (result) {
        log("today.md refreshed successfully");
      } else {
        log("No refresh needed");
      }
    } catch (err) {
      log(`ERROR: ${err}`);
    }
  }
}
