/**
 * Bedtime rehearsal nudge — triggered in the late evening.
 *
 * Two prompts leveraging the last 30 minutes before sleep as a
 * high-plasticity window for overnight consolidation:
 *   1. "what did you ship today?" — reinforces the "I ship things" identity circuit
 *   2. "what's tomorrow's brave thing?" — mental rehearsal primes motor circuits
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { EGG_MEMORY_DIR, NUDGES_DIR, NUDGES_SENT_DIR } from "../config.js";
import { callBrain } from "../brain/index.js";

function readFileSafe(path: string, maxChars = 8000): string {
  try {
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return content.length > maxChars ? content.slice(0, maxChars) + "\n...(truncated)" : content;
  } catch {
    return "";
  }
}

/**
 * Check if a bedtime rehearsal nudge was already sent today.
 */
function hasBedrimeRehearsalNudgeToday(): boolean {
  try {
    if (!existsSync(NUDGES_SENT_DIR)) return false;
    const today = new Date().toISOString().slice(0, 10);
    const files = readdirSync(NUDGES_SENT_DIR).filter(
      (f) => f.includes(today) && f.includes("bedtime") && f.endsWith(".md"),
    );
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * Generate a bedtime rehearsal nudge.
 * Returns the nudge text, or empty string if generation should be skipped.
 */
export async function generateBedrimeRehearsalNudge(): Promise<string> {
  if (hasBedrimeRehearsalNudgeToday()) {
    console.log("[bedtime] already sent a bedtime rehearsal nudge today — skipping");
    return "";
  }

  const todayContent = readFileSafe(join(EGG_MEMORY_DIR, "today.md"), 4000);
  const goals = readFileSafe(join(EGG_MEMORY_DIR, "goals.yaml"), 4000);
  const goalProgress = readFileSafe(join(EGG_MEMORY_DIR, "goal-progress.yaml"), 1500);

  const prompt = [
    "It's bedtime wind-down time. The last 30 minutes before sleep are a high-plasticity window — mental rehearsal now primes overnight consolidation.",
    "",
    "Write a short bedtime rehearsal nudge (2-3 lines, one per iMessage) that asks two things:",
    "1. 'what did you ship today?' — a review prompt that reinforces the 'I ship things' identity circuit",
    "2. 'what's tomorrow's brave thing?' — a mental rehearsal prompt that primes overnight consolidation for tomorrow's scariest action",
    "",
    "## Rules",
    "- Keep it light and conversational, in Egg's voice — lowercase, direct, warm underneath the edge",
    "- Don't lecture about neuroscience. Just ask the questions naturally.",
    "- If today.md shows tasks that were on the plan, you can reference them ('did you actually send that email?') but keep it brief",
    "- Each line = one iMessage. Keep each under 200 chars.",
    "- 2-3 messages total. No more.",
    "- Don't say 'good night' or be sappy. Just ask the questions.",
    "",
    "## Context",
    "",
    "### Today's plan (today.md)",
    todayContent || "No today.md available.",
    "",
    "### Active goals (goals.yaml)",
    goals || "No goals available.",
    "",
    "### Goal progress (this week)",
    goalProgress || "No progress data.",
  ].join("\n");

  const nudge = await callBrain({ history: [], message: prompt });
  console.log(`[bedtime] rehearsal nudge generated (${nudge.length} chars)`);
  return nudge;
}

/**
 * Schedule a bedtime rehearsal nudge: generate and write to nudges/.
 */
export async function scheduleBedrimeRehearsalNudge(): Promise<void> {
  try {
    const nudgeText = await generateBedrimeRehearsalNudge();
    if (!nudgeText.trim()) return;

    mkdirSync(NUDGES_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const nudgePath = join(NUDGES_DIR, `${timestamp}-bedtime.md`);
    writeFileSync(nudgePath, nudgeText);
    console.log(`[bedtime] rehearsal nudge written to ${nudgePath}`);
  } catch (err) {
    console.error("[bedtime] failed to generate bedtime rehearsal nudge:", err);
  }
}
