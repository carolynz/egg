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
  type: "backlog_complete" | "backlog_note" | "project_note" | "people_note" | "people_create" | "goal_note";
  match?: string;       // for backlog types: substring match
  file?: string;        // for project_note / people_note: existing filename
  name?: string;        // for people_create: display name
  email?: string;       // for people_create: email address
  goalId?: string;      // for goal_note
  note: string;
  reason: string;
}

interface ProjectSnippet {
  file: string;
  snippet: string;       // first ~300 chars of content
}

interface PersonSnippet {
  file: string;
  snippet: string;       // first ~200 chars of content
}

interface MemoryContext {
  backlog: string;
  projects: ProjectSnippet[];
  people: PersonSnippet[];
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

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function loadMemoryContext(): MemoryContext {
  let backlog = "";
  try {
    const p = join(EGG_MEMORY_DIR, "backlog.md");
    if (existsSync(p)) backlog = readFileSync(p, "utf-8");
  } catch {}

  // Load project files with content snippets for better matching
  const projects: ProjectSnippet[] = [];
  try {
    const dir = join(EGG_MEMORY_DIR, "projects");
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        try {
          const content = readFileSync(join(dir, file), "utf-8");
          projects.push({ file, snippet: truncate(content, 300) });
        } catch {}
      }
    }
  } catch {}

  // Load people files with content snippets for sender/recipient matching
  const people: PersonSnippet[] = [];
  try {
    const dir = join(EGG_MEMORY_DIR, "people");
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        try {
          const content = readFileSync(join(dir, file), "utf-8");
          people.push({ file, snippet: truncate(content, 200) });
        } catch {}
      }
    }
  } catch {}

  let goalsSummary = "";
  try {
    const p = join(EGG_MEMORY_DIR, "goals.yaml");
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      const lines = content.split("\n");
      const summaryLines: string[] = [];
      for (const line of lines) {
        if (/^\s+-\s+id:/.test(line) || /^\s+title:/.test(line) || /^\s+status:/.test(line)) {
          summaryLines.push(line);
        }
        if (/^\s+(REVENUE|TARGET|MISOGI|SHOPIFY|PRODUCTION|DEADLINE|MILESTONE)/i.test(line.trim())) {
          summaryLines.push(line);
        }
      }
      goalsSummary = summaryLines.join("\n");
    }
  } catch {}

  return { backlog, projects, people, goalsSummary };
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

  // Build project context with snippets
  const projectContext = context.projects.map((p) =>
    `- ${p.file}: ${p.snippet}`
  ).join("\n");

  // Build people context with snippets
  const peopleContext = context.people.map((p) =>
    `- ${p.file}: ${p.snippet}`
  ).join("\n");

  const prompt = `You are analyzing emails to detect updates for a user's personal task/project management system. Today is ${today}.

## Backlog (backlog.md) — incomplete items only
${context.backlog.split("\n").filter((l) => l.includes("- [ ]")).join("\n") || "(empty)"}

## Project files (projects/*.md) with summaries
${projectContext || "(none)"}

## People files (people/*.md) with summaries
${peopleContext || "(none)"}

## Goals
${context.goalsSummary || "(none)"}

## Emails to analyze
${emailList}

## Task
Identify concrete updates to make. Look for:

1. **SENT emails completing backlog tasks** — user sent an invoice, follow-up, scheduled something, emailed someone about X → mark that task done. Match the sent email's recipient + subject against open backlog items.

2. **INBOUND emails with status updates** on known tasks/projects — reply confirming receipt, payment received, approval granted, shipment update, deadline change → add a note to the relevant backlog item or project file.

3. **Emails involving known people** — from/to someone who has a people file → add a brief dated interaction note to their dossier. Match by name OR email address in the people file snippet.

4. **New contacts worth tracking** — if an inbound email is from a real person (not automated/marketing) who does NOT have a people file, and the email suggests an ongoing relationship (not a cold email or one-off), create a new people file with people_create.

5. **Goal-relevant events** — payment received, deal confirmed, revenue milestone, production update → add note to the relevant goal.

6. **Mercury banking notifications** — Mercury sends emails about invoices (sent, viewed, paid), transfers, and account activity. If you see emails from Mercury (mercury.com, notifications@mercury.com), extract the financial event and update the relevant project file (likely financial-dashboard.md) or backlog item. Examples:
   - "Invoice #123 has been paid — $5,000" → update backlog or financial-dashboard.md
   - "Invoice viewed by CompanyName" → add note to relevant project
   - "Transfer complete" → note in financial-dashboard.md

## Update types
- \`backlog_complete\`: Mark an incomplete task as done. "match" = unique substring from a \`- [ ]\` line.
- \`backlog_note\`: Add a status note to an incomplete task. "match" = unique substring from a \`- [ ]\` line.
- \`project_note\`: Append a dated note to a project file. "file" = exact filename from list above.
- \`people_note\`: Append a dated note to a person's dossier. "file" = exact filename from list above.
- \`people_create\`: Create a new people dossier. "name" = person's display name, "email" = their email address.
- \`goal_note\`: Add a note to a goal. "goalId" = goal ID from goals list.

## Rules
- ONLY suggest updates you are HIGHLY CONFIDENT about — clear match between email and item.
- For backlog_complete: "match" must be a unique substring from an INCOMPLETE (- [ ]) backlog item. Do NOT mark items already marked [x].
- For project_note/people_note: "file" must exactly match a filename from the lists above.
- For people_create: only for real people with meaningful interactions, never for automated senders, support addresses, or noreply addresses.
- Skip marketing, transactional receipts (order confirmations, shipping notices from stores), and automated emails.
- Keep notes under 80 chars. Be specific (include names, dates, amounts).
- If no updates are warranted, return [].

Return ONLY a JSON array:
[{"type":"backlog_complete","match":"substring","note":"completion note","reason":"email #N"},{"type":"people_create","name":"Jane Smith","email":"jane@example.com","note":"SVA professor, reached out about collaboration","reason":"email #N"}]`;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 20_000),
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
      if (u.type === "people_create" && !u.name) return false;
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

function applyPeopleCreate(name: string, email: string | undefined, note: string): boolean {
  try {
    const peopleDir = join(EGG_MEMORY_DIR, "people");
    mkdirSync(peopleDir, { recursive: true });

    // Generate filename from name: lowercase, spaces to dashes, strip non-alpha
    const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const filePath = join(peopleDir, `${slug}.md`);

    // Don't overwrite existing file
    if (existsSync(filePath)) {
      logSync(`WARNING: people file already exists: ${slug}.md — skipping create`);
      return false;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const emailLine = email ? `\n> Email: ${email}` : "";
    const content = `> ${name}${emailLine}

## ${dateStr} (auto from email)
${note}
`;

    writeFileSync(filePath, content);
    logSync(`✓ People create: ${slug}.md`);
    return true;
  } catch (err) {
    logSync(`ERROR people create: ${err}`);
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
      case "people_create":
        success = applyPeopleCreate(update.name!, update.email, update.note);
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
