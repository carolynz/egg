/**
 * Goal progress tracking — tracks weekly progress per active goal.
 *
 * Persists to goal-progress.yaml in egg-memory.
 * Read by the daily planner and heartbeat for goal-aware nudges.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { EGG_MEMORY_DIR } from "../config.js";

const PROGRESS_FILE = join(EGG_MEMORY_DIR, "goal-progress.yaml");

export interface GoalProgressEntry {
  [key: string]: string | number | null;
}

export interface GoalProgress {
  [goalId: string]: GoalProgressEntry;
}

/** Get the Monday of the current week as YYYY-MM-DD */
function getCurrentWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0
  const monday = new Date(now);
  monday.setDate(monday.getDate() - diff);
  return monday.toISOString().slice(0, 10);
}

/** Simple YAML parser for our flat goal-progress format */
function parseProgressYaml(content: string): GoalProgress {
  const progress: GoalProgress = {};
  let currentGoal = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level goal key (no leading spaces, ends with colon)
    const goalMatch = line.match(/^(\S[^:]+):\s*$/);
    if (goalMatch) {
      currentGoal = goalMatch[1].trim();
      progress[currentGoal] = {};
      continue;
    }

    // Nested key-value under a goal
    if (currentGoal && line.startsWith("  ")) {
      const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        let value: string | number | null = kvMatch[2].trim();

        // Parse types
        if (value === "null" || value === "~" || value === "") {
          value = null;
        } else if (/^-?\d+$/.test(value)) {
          value = parseInt(value, 10);
        } else if (/^-?\d+\.\d+$/.test(value)) {
          value = parseFloat(value);
        }

        progress[currentGoal][key] = value;
      }
    }
  }

  return progress;
}

/** Serialize progress to YAML */
function serializeProgressYaml(progress: GoalProgress): string {
  const lines: string[] = [];
  for (const [goalId, data] of Object.entries(progress)) {
    lines.push(`${goalId}:`);
    for (const [key, value] of Object.entries(data)) {
      const yamlValue = value === null ? "null" : String(value);
      lines.push(`  ${key}: ${yamlValue}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Load goal progress from disk. Returns default structure if file doesn't exist. */
export function loadGoalProgress(): GoalProgress {
  if (!existsSync(PROGRESS_FILE)) {
    return getDefaultProgress();
  }

  try {
    const content = readFileSync(PROGRESS_FILE, "utf-8");
    return parseProgressYaml(content);
  } catch {
    return getDefaultProgress();
  }
}

/** Save goal progress to disk */
export function saveGoalProgress(progress: GoalProgress): void {
  writeFileSync(PROGRESS_FILE, serializeProgressYaml(progress));
}

/** Get default progress structure based on known goals */
function getDefaultProgress(): GoalProgress {
  const weekStart = getCurrentWeekStart();

  return {
    "body-2026": {
      workouts_this_week: 0,
      target: 3,
      last_workout: null,
      week_start: weekStart,
    },
    "money-2026": {
      cameras_sold_this_week: 0,
      revenue_this_month: 0,
      week_start: weekStart,
    },
    "admin-zero-2026": {
      items_cleared_this_week: 0,
      week_start: weekStart,
    },
    "baseline-2026": {
      routines_completed_this_week: 0,
      target: 7,
      week_start: weekStart,
    },
  };
}

/** Reset weekly counters if the week has rolled over */
export function updateWeekStart(): void {
  const progress = loadGoalProgress();
  const currentWeek = getCurrentWeekStart();
  let changed = false;

  for (const [, data] of Object.entries(progress)) {
    if (data.week_start !== currentWeek) {
      // Reset weekly counters
      for (const key of Object.keys(data)) {
        if (key.endsWith("_this_week") && typeof data[key] === "number") {
          data[key] = 0;
        }
      }
      data.week_start = currentWeek;
      changed = true;
    }
  }

  if (changed) {
    saveGoalProgress(progress);
  }
}

/** Increment a counter for a goal (e.g., record a workout) */
export function incrementGoalCounter(goalId: string, field: string, amount = 1): void {
  const progress = loadGoalProgress();
  if (!progress[goalId]) {
    progress[goalId] = { week_start: getCurrentWeekStart() };
  }
  const current = typeof progress[goalId][field] === "number" ? (progress[goalId][field] as number) : 0;
  progress[goalId][field] = current + amount;
  saveGoalProgress(progress);
}

/** Update a specific field for a goal */
export function updateGoalField(goalId: string, field: string, value: string | number | null): void {
  const progress = loadGoalProgress();
  if (!progress[goalId]) {
    progress[goalId] = { week_start: getCurrentWeekStart() };
  }
  progress[goalId][field] = value;
  saveGoalProgress(progress);
}
