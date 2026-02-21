import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const EGG_LOG_DIR = join(homedir(), ".egg", "logs");

export const BRAIN_LOG = join(EGG_LOG_DIR, "brain.log");
export const TASKS_LOG = join(EGG_LOG_DIR, "tasks.log");

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

export function logBrainThinking(text: string): void {
  try {
    ensureLogDir();
    // Append raw thinking text without extra timestamp (already in a START/END block)
    appendFileSync(BRAIN_LOG, text.endsWith("\n") ? text : text + "\n");
  } catch {
    // best-effort
  }
}

export function logBrainEnd(exitCode: number | null, durationMs: number): void {
  const dur = Math.round(durationMs / 1000);
  appendLog(BRAIN_LOG, `BRAIN END   | exit=${exitCode ?? "?"} duration=${dur}s`);
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
