import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Store token data in egg-memory/data/ if available, else fall back to ~/.egg/
const memoryDir = process.env.EGG_MEMORY_DIR || process.cwd();
const DATA_DIR = join(memoryDir, "data");
const FALLBACK_DIR = join(homedir(), ".egg");

function resolveDataDir(): string {
  // Use egg-memory data dir if it looks like a memory dir (has SOUL.md or MEMORY.md),
  // otherwise fall back to ~/.egg/
  if (existsSync(join(memoryDir, "SOUL.md")) || existsSync(join(memoryDir, "MEMORY.md"))) {
    return DATA_DIR;
  }
  return FALLBACK_DIR;
}

const EGG_DATA_DIR = resolveDataDir();
export const TOKEN_USAGE_FILE = join(EGG_DATA_DIR, "token_usage.jsonl");
const TOKEN_STATE_FILE = join(EGG_DATA_DIR, "token-state.json");

// Pricing per million tokens (input, output)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":           { input: 15,   output: 75  },
  "claude-sonnet-4-6":         { input: 3,    output: 15  },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4   },
  "claude-haiku-4-5":          { input: 0.80, output: 4   },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

export interface TokenRecord {
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface TokenState {
  lastSentDate: string;
}

function getPricing(model: string): { input: number; output: number } {
  if (PRICING[model]) return PRICING[model];
  // Prefix match (e.g. "claude-haiku-4-5-20251001" matches "claude-haiku-4-5")
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return price;
  }
  return DEFAULT_PRICING;
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = getPricing(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
  const cost = computeCost(model, inputTokens, outputTokens);
  const record: TokenRecord = {
    timestamp: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
  };
  try {
    mkdirSync(EGG_DATA_DIR, { recursive: true });
    appendFileSync(TOKEN_USAGE_FILE, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error("[token-tracker] failed to record token usage:", err);
  }
}

/** Current date in Pacific time, formatted as YYYY-MM-DD. */
export function getPacificDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Current hour in Pacific time (0–23). */
export function getPacificHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = parts.find((p) => p.type === "hour");
  // "24" can appear at midnight — normalize to 0
  return hour ? parseInt(hour.value, 10) % 24 : 0;
}

export interface DailySummary {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelBreakdown: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export function getDailySummary(date?: string): DailySummary {
  const targetDate = date ?? getPacificDate();
  const summary: DailySummary = {
    date: targetDate,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelBreakdown: {},
  };

  if (!existsSync(TOKEN_USAGE_FILE)) return summary;

  const lines = readFileSync(TOKEN_USAGE_FILE, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as TokenRecord;
      const recordDate = new Date(record.timestamp).toLocaleDateString("en-CA", {
        timeZone: "America/Los_Angeles",
      });
      if (recordDate !== targetDate) continue;

      summary.inputTokens += record.input_tokens;
      summary.outputTokens += record.output_tokens;
      summary.costUsd += record.cost_usd;

      if (!summary.modelBreakdown[record.model]) {
        summary.modelBreakdown[record.model] = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      }
      summary.modelBreakdown[record.model].inputTokens += record.input_tokens;
      summary.modelBreakdown[record.model].outputTokens += record.output_tokens;
      summary.modelBreakdown[record.model].costUsd += record.cost_usd;
    } catch {
      // skip malformed lines
    }
  }

  return summary;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function fmtModel(model: string): string {
  return model
    .replace("claude-opus-4-6", "opus-4-6")
    .replace("claude-sonnet-4-6", "sonnet-4-6")
    .replace("claude-haiku-4-5-20251001", "haiku-4-5")
    .replace("claude-haiku-4-5", "haiku-4-5");
}

/** Format a daily summary as iMessage lines (one text per element). */
export function formatSummaryMessages(summary: DailySummary): string[] {
  const msgs: string[] = [];
  msgs.push(`today's api spend: ~$${summary.costUsd.toFixed(2)}`);
  msgs.push(`input: ${fmtK(summary.inputTokens)} tokens / output: ${fmtK(summary.outputTokens)} tokens`);

  const models = Object.keys(summary.modelBreakdown);
  if (models.length === 1) {
    msgs.push(`model: ${fmtModel(models[0])}`);
  } else if (models.length > 1) {
    for (const model of models) {
      const mb = summary.modelBreakdown[model];
      msgs.push(`${fmtModel(model)}: $${mb.costUsd.toFixed(3)}`);
    }
  }

  return msgs;
}

/** Format a daily summary as a single log line (without the leading timestamp). */
export function formatSummaryLogLine(summary: DailySummary): string {
  const models = Object.keys(summary.modelBreakdown).map(fmtModel).join(", ");
  return `API SPEND   | $${summary.costUsd.toFixed(2)} | input:${fmtK(summary.inputTokens)} output:${fmtK(summary.outputTokens)} | ${models || "none"}`;
}

export function loadTokenState(): TokenState {
  try {
    return JSON.parse(readFileSync(TOKEN_STATE_FILE, "utf-8")) as TokenState;
  } catch {
    return { lastSentDate: "" };
  }
}

export function saveTokenState(state: TokenState): void {
  try {
    mkdirSync(EGG_DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[token-tracker] failed to save token state:", err);
  }
}
