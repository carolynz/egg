/**
 * Email-to-memory sync: cross-references new emails against egg-memory files
 * (backlog.md, projects/*.md, people/*.md, goals.yaml) and applies updates.
 *
 * Runs as part of the email check cycle — after emails are classified and
 * nudges are written, this module checks if any emails relate to known
 * tasks/projects/people and updates the memory files accordingly.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { EGG_MEMORY_DIR } from "../config.js";
import { recordTokenUsage } from "../token-tracker.js";

// ── Logging ─────────────────────────────────────────────────────────────────

const EMAIL_SYNC_LOG = join(homedir(), ".egg", "logs", "email-sync.log");

function logSync(message: string): void {
  console.log(`[email-sync] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(EMAIL_SYNC_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmailForSync {
  direction: "inbound" | "sent";
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  body?: string;
}

interface MemoryUpdate {
  type: "backlog_complete" | "backlog_note" | "project_note" | "people_note" | "goal_note";
  match?: string;
  file?: string;
  goalId?: string;
  note: string;
  reason: string;
}

interface MemoryContext {
  backlog: string;
  projectFiles: string[];
  peopleFiles: string[];
  goalsSummary: string;
}

// ── Concurrency guard ───────────────────────────────────────────────────────

let syncRunning = false;

// ── Anthropic client ────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;
let anthropicKeyMissing = false;

function getAnthropicClient(): Anthropic | null {
  if (anthropicKeyMissing) return null;
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      logSync("ANTHROPIC_API_KEY not set — email-memory sync disabled");
      anthropicKeyMissing = true;
      return null;
    }
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ── Load memory context ─────────────────────────────────────────────────────

function loadMemoryContext(): MemoryContext {
  let backlog = "";
  try {
    const p = join(EGG_MEMORY_DIR, "backlog.md");
    if (existsSync(p)) backlog = readFileSync(p, "utf-8");
  } catch {}

  let projectFiles: string[] = [];
  try {
    const dir = join(EGG_MEMORY_DIR, "projects");
    if (existsSync(dir)) {
      projectFiles = readdirSync(dir).filter((f) => f.endsWith(".md"));
    }
  } catch {}

  let peopleFiles: string[] = [];
  try {
    const dir = join(EGG_MEMORY_DIR, "people");
    if (existsSync(dir)) {
      peopleFiles = readdirSync(dir).filter((f) => f.endsWith(".md"));
    }
  } catch {}

  let goalsSummary = "";
  try {
    const p = join(EGG_MEMORY_DIR, "goals.yaml");
    if (existsSync(p)) {
      // Read goal IDs and titles only to keep prompt compact
      const content = readFileSync(p, "utf-8");
      const lines = content.split("\n");
      const summaryLines: string[] = [];
      for (const line of lines) {
        if (/^\s+-\s+id:/.test(line) || /^\s+title:/.test(line) || /^\s+status:/.test(line)) {
          summaryLines.push(line);
        }
        // Include key revenue/milestone mentions from notes
        if (/^\s+(REVENUE|TARGET|MISOGI|SHOPIFY|PRODUCTION|DEADLINE|MILESTONE)/i.test(line.trim())) {
          summaryLines.push(line);
        }
      }
      goalsSummary = summaryLines.join("\n");
    }
  } catch {}

  return { backlog, projectFiles, peopleFiles, goalsSummary };
}

// ── AI cross-reference ──────────────────────────────────────────────────────

const MAX_EMAILS_FOR_SYNC = 15;

async function classifyEmailUpdates(
  emails: EmailForSync[],
  context: MemoryContext,
): Promise<MemoryUpdate[]> {
  const client = getAnthropicClient();
  if (!client) return [];

  const today = new Date().toISOString().slice(0, 10);

  // Build compact email list
  const emailList = emails.slice(0, MAX_EMAILS_FOR_SYNC).map((e, i) => {
    const body = e.body ? `\n   Body: ${e.body.slice(0, 400)}` : "";
    return `${i + 1}. [${e.direction.toUpperCase()}] From: ${e.from} → To: ${e.to.join(", ")}\n   Subject: ${e.subject}\n   Snippet: ${e.snippet}${body}`;
  }).join("\n\n");

  const prompt = `You are analyzing emails to detect updates for a user's personal task/project management system. Today is ${today}.

## Backlog (backlog.md)
${context.backlog}

## Project files (projects/*.md)
${context.projectFiles.join(", ")}

## People files (people/*.md)
${context.peopleFiles.join(", ")}

## Goals
${context.goalsSummary}

## Emails to analyze
${emailList}

## Task
Identify concrete updates to make. Look for:
1. **SENT emails completing backlog tasks** (user sent invoice, follow-up, scheduled something → mark done)
2. **INBOUND emails with status updates** on known tasks/projects (reply confirming receipt, payment, approval → add note)
3. **Emails involving known people** (from/to someone with a people file → brief interaction note)
4. **Goal-relevant events** (payment received, deal confirmed, revenue milestone)

## Rules
- ONLY suggest updates you are HIGHLY CONFIDENT about — clear match between email and item.
- For backlog_complete: "match" must be a unique substring from an INCOMPLETE (- [ ]) backlog item.
- Do NOT mark items already marked [x] as complete again.
- For project_note/people_note: "file" must exactly match a filename from the lists above.
- Skip marketing, transactional, automated, and routine emails.
- Keep notes under 80 chars. Be specific (include names, dates, amounts).
- If no updates are warranted, return [].

Return ONLY a JSON array:
[{"type":"backlog_complete","match":"substring","note":"completion note","reason":"email #N"},{"type":"people_note","file":"name.md","note":"interaction note","reason":"email #N"}]`;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 15_000),
      ),
    ]);

    recordTokenUsage(
      "claude-haiku-4-5-20251001",
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // Strip markdown code fences if present
    const jsonStr = text.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();
    const updates = JSON.parse(jsonStr) as MemoryUpdate[];

    if (!Array.isArray(updates)) {
      logSync("WARNING: AI returned non-array response");
      return [];
    }

    // Validate each update has required fields
    return updates.filter((u) => {
      if (!u.type || !u.note) return false;
      if ((u.type === "backlog_complete" || u.type === "backlog_note") && !u.match) return false;
      if ((u.type === "project_note" || u.type === "people_note") && !u.file) return false;
      if (u.type === "goal_note" && !u.goalId) return false;
      return true;
    });
  } catch (err) {
    logSync(`WARNING: email-memory classification failed: ${err}`);
    return [];
  }
}

// ── Apply individual updates ────────────────────────────────────────────────

function shortDate(): string {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function applyBacklogComplete(match: string, note: string): boolean {
  const backlogPath = join(EGG_MEMORY_DIR, "backlog.md");
  try {
    const content = readFileSync(backlogPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("- [ ]") && lines[i].toLowerCase().includes(match.toLowerCase())) {
        lines[i] = lines[i].replace("- [ ]", "- [x]");
        const suffix = note
          ? ` — ${note} (done ${shortDate()})`
          : ` — done ${shortDate()}`;
        lines[i] = lines[i].trimEnd() + suffix;
        writeFileSync(backlogPath, lines.join("\n"));
        logSync(`✓ Backlog complete: ${match}`);
        return true;
      }
    }

    logSync(`WARNING: backlog item not found: "${match}"`);
    return false;
  } catch (err) {
    logSync(`ERROR backlog complete: ${err}`);
    return false;
  }
}

function applyBacklogNote(match: string, note: string): boolean {
  const backlogPath = join(EGG_MEMORY_DIR, "backlog.md");
  try {
    const content = readFileSync(backlogPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("- [ ]") && lines[i].toLowerCase().includes(match.toLowerCase())) {
        lines[i] = lines[i].trimEnd() + ` | ${note} (${shortDate()})`;
        writeFileSync(backlogPath, lines.join("\n"));
        logSync(`✓ Backlog note: ${match}`);
        return true;
      }
    }

    logSync(`WARNING: backlog item not found for note: "${match}"`);
    return false;
  } catch (err) {
    logSync(`ERROR backlog note: ${err}`);
    return false;
  }
}

function applyProjectNote(file: string, note: string): boolean {
  const projectPath = join(EGG_MEMORY_DIR, "projects", file);
  try {
    if (!existsSync(projectPath)) {
      logSync(`WARNING: project file not found: ${file}`);
      return false;
    }

    let content = readFileSync(projectPath, "utf-8");
    content = content.trimEnd() + `\n\n### ${shortDate()} (auto from email)\n${note}\n`;
    writeFileSync(projectPath, content);
    logSync(`✓ Project note: ${file}`);
    return true;
  } catch (err) {
    logSync(`ERROR project note: ${err}`);
    return false;
  }
}

function applyPeopleNote(file: string, note: string): boolean {
  const peoplePath = join(EGG_MEMORY_DIR, "people", file);
  try {
    if (!existsSync(peoplePath)) {
      logSync(`WARNING: people file not found: ${file}`);
      return false;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    let content = readFileSync(peoplePath, "utf-8");
    content = content.trimEnd() + `\n\n## ${dateStr} (auto from email)\n${note}\n`;
    writeFileSync(peoplePath, content);
    logSync(`✓ People note: ${file}`);
    return true;
  } catch (err) {
    logSync(`ERROR people note: ${err}`);
    return false;
  }
}

function applyGoalNote(goalId: string, note: string): boolean {
  const goalsPath = join(EGG_MEMORY_DIR, "goals.yaml");
  try {
    if (!existsSync(goalsPath)) {
      logSync(`WARNING: goals.yaml not found`);
      return false;
    }

    const content = readFileSync(goalsPath, "utf-8");
    const lines = content.split("\n");

    // Find the goal's id line
    let goalLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === `id: ${goalId}`) {
        goalLineIdx = i;
        break;
      }
    }
    if (goalLineIdx < 0) {
      logSync(`WARNING: goal not found: ${goalId}`);
      return false;
    }

    // Find the end of this goal's notes block — it's the line before the next
    // top-level list item (  - id:) or end of file.
    let insertIdx = lines.length;
    for (let i = goalLineIdx + 1; i < lines.length; i++) {
      if (/^\s{2}-\s+id:/.test(lines[i])) {
        // Insert before the blank line preceding next goal (if any)
        insertIdx = i;
        while (insertIdx > goalLineIdx && lines[insertIdx - 1].trim() === "") {
          insertIdx--;
        }
        break;
      }
    }

    const noteLine = `      EMAIL (${shortDate()}): ${note}`;
    lines.splice(insertIdx, 0, noteLine);
    writeFileSync(goalsPath, lines.join("\n"));
    logSync(`✓ Goal note: ${goalId}`);
    return true;
  } catch (err) {
    logSync(`ERROR goal note: ${err}`);
    return false;
  }
}

// ── Apply all updates ───────────────────────────────────────────────────────

function applyUpdates(updates: MemoryUpdate[]): MemoryUpdate[] {
  const applied: MemoryUpdate[] = [];

  for (const update of updates) {
    let success = false;

    switch (update.type) {
      case "backlog_complete":
        success = applyBacklogComplete(update.match!, update.note);
        break;
      case "backlog_note":
        success = applyBacklogNote(update.match!, update.note);
        break;
      case "project_note":
        success = applyProjectNote(update.file!, update.note);
        break;
      case "people_note":
        success = applyPeopleNote(update.file!, update.note);
        break;
      case "goal_note":
        success = applyGoalNote(update.goalId!, update.note);
        break;
    }

    if (success) applied.push(update);
  }

  return applied;
}

// ── Git commit & push ───────────────────────────────────────────────────────

function commitAndPushUpdates(applied: MemoryUpdate[]): void {
  try {
    const status = execSync("git status --porcelain", {
      cwd: EGG_MEMORY_DIR,
      timeout: 10_000,
    }).toString().trim();

    if (!status) {
      logSync("No git changes to commit");
      return;
    }

    execSync("git add -A", { cwd: EGG_MEMORY_DIR, timeout: 10_000 });

    // Build a descriptive commit message
    const typeCounts = new Map<string, number>();
    for (const u of applied) {
      typeCounts.set(u.type, (typeCounts.get(u.type) ?? 0) + 1);
    }
    const summary = [...typeCounts.entries()]
      .map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`)
      .join(", ");

    const msg = `auto: email-memory sync (${summary})`;

    execSync(`git commit -m ${JSON.stringify(msg)}`, {
      cwd: EGG_MEMORY_DIR,
      timeout: 10_000,
    });

    execSync("git push", { cwd: EGG_MEMORY_DIR, timeout: 30_000 });

    logSync(`Committed & pushed: ${summary}`);
  } catch (err) {
    logSync(`ERROR git commit/push: ${err}`);
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function syncEmailsToMemory(
  inboundEmails: EmailForSync[],
  sentEmails: EmailForSync[],
): Promise<void> {
  const allEmails = [...sentEmails, ...inboundEmails]; // sent first (task completion)
  if (allEmails.length === 0) return;

  // Concurrency guard — don't overlap syncs
  if (syncRunning) {
    logSync("Skipping sync — already running");
    return;
  }
  syncRunning = true;

  try {
    logSync(`Syncing ${inboundEmails.length} inbound + ${sentEmails.length} sent email(s)`);

    const context = loadMemoryContext();
    const updates = await classifyEmailUpdates(allEmails, context);

    if (updates.length === 0) {
      logSync("No memory updates identified");
      return;
    }

    logSync(`AI identified ${updates.length} update(s)`);

    const applied = applyUpdates(updates);

    if (applied.length > 0) {
      commitAndPushUpdates(applied);
    }
  } catch (err) {
    logSync(`ERROR in email-memory sync: ${err}`);
  } finally {
    syncRunning = false;
  }
}
