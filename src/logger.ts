import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const EGG_LOG_DIR = join(homedir(), ".egg", "logs");

export const BRAIN_LOG = join(EGG_LOG_DIR, "brain.log");
export const TASKS_LOG = join(EGG_LOG_DIR, "tasks.log");
export const IMESSAGE_INGEST_LOG = join(EGG_LOG_DIR, "imessage-ingest.log");
export const GOOGLE_INGEST_LOG = join(EGG_LOG_DIR, "google-ingest.log");
export const PHOTOS_INGEST_LOG = join(EGG_LOG_DIR, "photos-ingest.log");
export const EMAIL_CHECK_LOG = join(EGG_LOG_DIR, "email-check.log");
export const EMAIL_POLLER_LOG = join(EGG_LOG_DIR, "email-poller.log");
export const CALENDAR_POLLER_LOG = join(EGG_LOG_DIR, "calendar-poller.log");
export const OUTBOUND_LOG = join(EGG_LOG_DIR, "outbound.log");

function ensureLogDir(): void {
  mkdirSync(EGG_LOG_DIR, { recursive: true });
}

function ts(): string {
  return new Date().toISOString();
}

function appendLog(filePath: string, message: string): void {
  try {
    ensureLogDir();
    appendFileSync(filePath, `[${ts()}] ${message}\n`);
  } catch {
    // best-effort — never crash serve over a log write failure
  }
}

/** Touch both log files so tail -F can follow them immediately. */
export function initLogFiles(): void {
  ensureLogDir();
  for (const f of [BRAIN_LOG, TASKS_LOG]) {
    try {
      writeFileSync(f, "", { flag: "a" });
    } catch {}
  }
}

export function logBrainStart(prompt: string): void {
  const preview = prompt.slice(0, 100).replace(/\n/g, " ");
  appendLog(BRAIN_LOG, `BRAIN START | ${preview}`);
}

export function logBrainEnd(exitCode: number | null, durationMs: number): void {
  const dur = Math.round(durationMs / 1000);
  appendLog(BRAIN_LOG, `BRAIN END   | exit=${exitCode ?? "?"} duration=${dur}s`);
}

export function logBrainSession(action: string, sessionId: string): void {
  appendLog(BRAIN_LOG, `SESSION     | ${action} session=${sessionId.slice(0, 12)}`);
}

export function logTaskStart(filename: string): void {
  appendLog(TASKS_LOG, `TASK START  | ${filename}`);
}

export function logTaskEnd(
  filename: string,
  exitCode: number | null,
  durationSec: number,
): void {
  appendLog(TASKS_LOG, `TASK END    | ${filename} exit=${exitCode ?? "?"} duration=${durationSec}s`);
}

export function logApiSpend(summary: string): void {
  appendLog(TASKS_LOG, summary);
}

export function logOutbound(contact: string, message: string, success: boolean): void {
  const status = success ? "OK" : "FAIL";
  const preview = message.slice(0, 200).replace(/\n/g, " ");
  appendLog(OUTBOUND_LOG, `${status} | to=${contact} | ${preview}`);
}
