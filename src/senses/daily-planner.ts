/**
 * Daily planner — generates today.md each morning.
 *
 * Reads calendar, goals, backlog, recent emails, workout history,
 * and goal-progress tracking to produce a structured daily plan.
 * The brain synthesizes everything into a concise today.md.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { EGG_MEMORY_DIR } from "../config.js";
import { callBrain } from "../brain/index.js";
import { loadGoalProgress, updateWeekStart, GoalProgress } from "./goal-progress.js";

// ── Data readers ────────────────────────────────────────────────────────────

function readFileSafe(path: string, maxChars = 8000): string {
  try {
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return content.length > maxChars ? content.slice(0, maxChars) + "\n...(truncated)" : content;
  } catch {
    return "";
  }
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDayOfWeek(): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[new Date().getDay()];
}

/** Read today's calendar events from data/calendar/<account>/<date>.json */
function readCalendarEvents(date: string): string {
  const calDir = join(EGG_MEMORY_DIR, "data", "calendar");
  if (!existsSync(calDir)) return "";

  const sections: string[] = [];
  try {
    const accounts = readdirSync(calDir).filter((f: string) => !f.startsWith(".") && !f.startsWith("_"));
    for (const account of accounts) {
      const dayFile = join(calDir, account, `${date}.json`);
      if (!existsSync(dayFile)) continue;
      try {
        const data = JSON.parse(readFileSync(dayFile, "utf-8"));
        const events = data.events || [];
        if (events.length === 0) continue;

        for (const event of events) {
          if (event.status === "cancelled") continue;
          const startTime = event.allDay ? "All day" : new Date(event.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const endTime = event.allDay ? "" : ` – ${new Date(event.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
          const location = event.location ? ` (${event.location})` : "";
          sections.push(`- ${startTime}${endTime}: ${event.title}${location}`);
        }
      } catch {}
    }
  } catch {}

  return sections.length > 0 ? sections.join("\n") : "No calendar events today.";
}

/** Read recent emails (last 3 days) for action items */
function readRecentEmails(): string {
  const gmailDir = join(EGG_MEMORY_DIR, "data", "gmail");
  if (!existsSync(gmailDir)) return "";

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const monthKey = `${year}-${month}`;
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  const sections: string[] = [];
  try {
    const accounts = readdirSync(gmailDir).filter((f: string) => !f.startsWith(".") && !f.startsWith("_"));
    for (const account of accounts) {
      const monthFile = join(gmailDir, account, `${monthKey}.json`);
      if (!existsSync(monthFile)) continue;
      try {
        const data = JSON.parse(readFileSync(monthFile, "utf-8"));
        const emails = (data.emails || []) as Array<{
          date: string;
          from: string;
          subject: string;
          snippet: string;
          labels: string[];
          isStarred: boolean;
        }>;

        // Filter to recent, non-automated emails
        const recent = emails
          .filter((e) => new Date(e.date) >= threeDaysAgo)
          .filter((e) => {
            const from = e.from.toLowerCase();
            // Skip automated/transactional
            return !from.includes("noreply") && !from.includes("no-reply") &&
                   !from.includes("venmo@") && !from.includes("notifications@") &&
                   !from.includes("mailer-daemon");
          })
          .filter((e) => e.labels.includes("INBOX") || e.labels.includes("IMPORTANT") || e.isStarred)
          .slice(-15); // last 15 relevant

        for (const e of recent) {
          const fromName = e.from.replace(/<[^>]+>/, "").trim();
          sections.push(`- From ${fromName}: "${e.subject}" — ${e.snippet.slice(0, 120)}`);
        }
      } catch {}
    }
  } catch {}

  return sections.length > 0 ? sections.join("\n") : "";
}

/** Read workout history to determine training day status */
function readWorkoutHistory(): string {
  return readFileSafe(join(EGG_MEMORY_DIR, "data", "workouts.md"), 3000);
}

/** Read backlog.md (create if missing) */
function readBacklog(): string {
  const backlogPath = join(EGG_MEMORY_DIR, "backlog.md");
  if (!existsSync(backlogPath)) {
    writeFileSync(backlogPath, "# Backlog\n\nItems to do (not time-bound today):\n\n");
    return "";
  }
  return readFileSafe(backlogPath, 3000);
}

/** Read recent Oura/sleep data from recent daily digests or nudges */
function readSleepData(): string {
  const dailyDir = join(EGG_MEMORY_DIR, "daily");
  if (!existsSync(dailyDir)) return "";

  // Check today's or yesterday's daily digest for sleep info
  const today = getTodayDate();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const date of [today, yesterday]) {
    const digestPath = join(dailyDir, `${date}.md`);
    const content = readFileSafe(digestPath, 2000);
    if (content) {
      // Extract sleep-related lines
      const sleepLines = content.split("\n").filter((l) =>
        /sleep|oura|readiness|hrv|resting.*heart|deep sleep|rem|bedtime|wake/i.test(l)
      );
      if (sleepLines.length > 0) {
        return sleepLines.join("\n");
      }
    }
  }
  return "";
}

/** Format goal progress for the prompt */
function formatGoalProgress(progress: GoalProgress): string {
  const lines: string[] = [];
  for (const [goalId, data] of Object.entries(progress)) {
    const entries = Object.entries(data)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`- ${goalId}: ${entries}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No goal progress tracked yet.";
}

// ── Main generation ─────────────────────────────────────────────────────────

export async function generateTodayMd(): Promise<string> {
  const today = getTodayDate();
  const dayOfWeek = getDayOfWeek();

  // Ensure goal progress week is current
  updateWeekStart();

  // Gather all data sources
  const calendarEvents = readCalendarEvents(today);
  const goals = readFileSafe(join(EGG_MEMORY_DIR, "goals.yaml"), 4000);
  const backlog = readBacklog();
  const recentEmails = readRecentEmails();
  const workoutHistory = readWorkoutHistory();
  const sleepData = readSleepData();
  const goalProgress = formatGoalProgress(loadGoalProgress());

  // Build the prompt for brain to generate today.md
  const prompt = [
    `Generate today.md for ${today} (${dayOfWeek}).`,
    "",
    "Use the data below to create a structured daily plan. Write ONLY the today.md content, nothing else.",
    "",
    "## Format",
    "```",
    `# Today — ${today} (${dayOfWeek})`,
    "",
    "## Schedule",
    "(calendar events with times)",
    "",
    "## Must-do (hard deadlines today)",
    "- [ ] ...",
    "",
    "## Should-do (important, not urgent)",
    "- [ ] ...",
    "",
    "## Workout",
    "(if it's a training day — target 3x/week)",
    "- [ ] routine details pulled from workout program",
    "",
    "## Backlog (top items from backlog.md)",
    "- item 1",
    "- item 2",
    "```",
    "",
    "## Rules",
    "- Be specific and actionable (not 'work out' but 'Day B: rows 3x10, farmer carry 3x30s, curls 3x12, dead hang')",
    "- Slot workout into a calendar gap if possible (e.g. '25 min between 2-4pm gap')",
    "- Call out the #1 priority for the day",
    "- If goal progress shows falling behind (e.g. 0/3 workouts and it's Wednesday), flag it",
    "- Pull only top 3-5 backlog items, ranked by importance",
    "- If sleep data shows poor sleep, note it and suggest a lighter day",
    "- Must-do items should ONLY be things with actual hard deadlines today",
    "- Should-do items are important tasks that could be done today",
    "- Check recent emails for anything requiring a response or action",
    "",
    "## Data sources",
    "",
    `### Calendar events for ${today}`,
    calendarEvents,
    "",
    "### Active goals (goals.yaml)",
    goals,
    "",
    "### Goal progress (this week)",
    goalProgress,
    "",
    "### Workout history",
    workoutHistory || "No workout history available.",
    "",
    "### Sleep/readiness data",
    sleepData || "No sleep data available.",
    "",
    "### Recent emails (last 3 days)",
    recentEmails || "No recent actionable emails.",
    "",
    "### Current backlog",
    backlog || "Backlog is empty.",
  ].join("\n");

  console.log("[planner] generating today.md...");
  const result = await callBrain({ history: [], message: prompt });

  // Write today.md
  const todayPath = join(EGG_MEMORY_DIR, "today.md");
  writeFileSync(todayPath, result);
  console.log(`[planner] wrote ${todayPath} (${result.length} chars)`);

  return result;
}

/**
 * Generate a smart morning nudge message based on today.md.
 * Returns the nudge text (to be written to nudges/).
 */
export async function generateMorningNudge(): Promise<string> {
  const today = getTodayDate();
  const todayPath = join(EGG_MEMORY_DIR, "today.md");

  // Generate today.md first if it doesn't exist or is stale
  let todayContent: string;
  if (existsSync(todayPath)) {
    const content = readFileSync(todayPath, "utf-8");
    // Check if it's for today (first line contains the date)
    if (content.includes(today)) {
      todayContent = content;
    } else {
      todayContent = await generateTodayMd();
    }
  } else {
    todayContent = await generateTodayMd();
  }

  const sleepData = readSleepData();
  const goalProgress = formatGoalProgress(loadGoalProgress());

  const prompt = [
    "Write a concise morning nudge message (3-5 text messages, one per line).",
    "",
    "## Rules",
    "- Reference actual calendar events with times ('you have X at Y time')",
    "- Call out the #1 priority for the day",
    "- If sleep data available and shows poor sleep, be gentler and suggest a recovery-focused day",
    "- Include pre-filled decisions where possible ('25 min workout between 2-4pm gap' not just 'work out today')",
    "- Keep it natural and concise — fits in 3-5 text messages max",
    "- Each line = one iMessage. Keep each line under 160 chars",
    "- Start with a brief greeting appropriate to the time/context, not generic 'good morning'",
    "- Don't repeat the entire today.md — just the highlights",
    "- If goal progress is behind, mention it naturally",
    "",
    "## Today's plan",
    todayContent,
    "",
    "## Goal progress (this week)",
    goalProgress,
    "",
    "## Sleep data",
    sleepData || "No sleep data available.",
  ].join("\n");

  const nudge = await callBrain({ history: [], message: prompt });
  console.log(`[planner] morning nudge generated (${nudge.length} chars)`);
  return nudge;
}
