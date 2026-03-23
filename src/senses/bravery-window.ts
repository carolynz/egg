/**
 * Bravery window nudge — triggered after workout completion.
 *
 * Post-workout, BDNF and norepinephrine are elevated for ~2 hours,
 * suppressing the fear response. This nudge suggests ONE brave action
 * from today.md tasks, goals.yaml priorities, or backlog.md items —
 * picking the one that involves the most visibility, risk, or discomfort.
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
 * Detect workout completion in a conversation exchange.
 * Checks the user's message for signals that a workout just finished.
 */
export function detectWorkoutCompletion(userMessage: string): boolean {
  const text = userMessage.toLowerCase();

  // Direct workout completion signals
  const patterns = [
    /\b(?:just |done |finished )?work(?:ed)?\s*out\b/,
    /\bfinished\s+(?:my\s+)?(?:workout|lifting|training|gym|exercise|the\s+gym)\b/,
    /\b(?:just\s+)?(?:done|finished)\s+(?:at|with|from)\s+(?:the\s+)?gym\b/,
    /\bworkout\s+(?:done|complete|finished|over)\b/,
    /\b(?:just\s+)?(?:got\s+)?(?:back|home)\s+from\s+(?:the\s+)?gym\b/,
    /\bdone\s+(?:with\s+)?(?:my\s+)?(?:workout|lifting|training|exercise)\b/,
    /\b(?:just\s+)?(?:finished|completed|crushed|killed|smashed)\s+(?:my\s+)?(?:workout|session|lift|training)\b/,
    /\bpost[\s-]?workout\b/,
    /\bjust\s+lifted\b/,
    /\bjust\s+(?:did|hit)\s+(?:my\s+)?(?:workout|session|lift|training)\b/,
  ];

  return patterns.some((p) => p.test(text));
}

/**
 * Check if a bravery nudge was already sent today.
 */
function hasBraveryNudgeToday(): boolean {
  try {
    if (!existsSync(NUDGES_SENT_DIR)) return false;
    const today = new Date().toISOString().slice(0, 10);
    const files = readdirSync(NUDGES_SENT_DIR).filter(
      (f) => f.includes(today) && f.includes("bravery") && f.endsWith(".md"),
    );
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * Generate a bravery window nudge based on current tasks and goals.
 * Returns the nudge text, or empty string if generation should be skipped.
 */
export async function generateBraveryNudge(): Promise<string> {
  // Dedup: only one bravery nudge per day
  if (hasBraveryNudgeToday()) {
    console.log("[bravery] already sent a bravery nudge today — skipping");
    return "";
  }

  // Gather context
  const todayContent = readFileSafe(join(EGG_MEMORY_DIR, "today.md"), 4000);
  const goals = readFileSafe(join(EGG_MEMORY_DIR, "goals.yaml"), 4000);
  const backlog = readFileSafe(join(EGG_MEMORY_DIR, "backlog.md"), 3000);
  const goalProgress = readFileSafe(join(EGG_MEMORY_DIR, "goal-progress.yaml"), 1500);

  const prompt = [
    "The user just finished a workout. For the next ~2 hours, BDNF and norepinephrine are elevated — fear response is suppressed, neuroplasticity is peaking. This is their bravery window.",
    "",
    "Write a short nudge (2-3 lines, one per iMessage) that:",
    "1. Reminds them the bravery window is open (~2 hours of peak neuroplasticity)",
    "2. Suggests ONE specific brave action — the scariest, highest-visibility, most uncomfortable task from their current goals, today's plan, or backlog",
    "",
    "## Rules",
    "- Pick the task that involves the most risk, exposure, or discomfort (sending an email to someone important, posting something publicly, making a cold outreach, starting a scary creative project, having a hard conversation)",
    "- Be extremely specific — name the exact task, person, or action. Not 'reach out to someone' but 'email the Smithsonian contact about video documentation'",
    "- Keep it lowercase, direct, short — in Egg's voice",
    "- First line: mention the bravery window / neurochemistry briefly",
    "- Second line: the specific brave suggestion with 'brave thing:' prefix",
    "- Do NOT use generic motivational language. Be concrete and actionable.",
    "- Each line = one iMessage. Keep each under 200 chars.",
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
    "",
    "### Backlog (backlog.md)",
    backlog || "No backlog items.",
  ].join("\n");

  const nudge = await callBrain({ history: [], message: prompt });
  console.log(`[bravery] nudge generated (${nudge.length} chars)`);
  return nudge;
}

/**
 * Schedule a bravery window nudge: generate and write to nudges/.
 * Called from the shell loop after workout completion is detected.
 */
export async function scheduleBraveryNudge(): Promise<void> {
  try {
    const nudgeText = await generateBraveryNudge();
    if (!nudgeText.trim()) return;

    mkdirSync(NUDGES_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const nudgePath = join(NUDGES_DIR, `${timestamp}-bravery.md`);
    writeFileSync(nudgePath, nudgeText);
    console.log(`[bravery] nudge written to ${nudgePath}`);
  } catch (err) {
    console.error("[bravery] failed to generate bravery nudge:", err);
  }
}
