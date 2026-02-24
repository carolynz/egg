import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import {
  EGG_BRAIN,
  EGG_MEMORY_DIR,
  EGG_MODEL,
  CHAT_DB,
} from "../config.js";
import { stripPII } from "../pii/index.js";
import {
  getGoogleOAuthConfig,
  loadAllAccounts,
  getAuthedClient,
} from "../integrations/google.js";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

// ── Types ─────────────────────────────────────────────────────────────────────

type Source = "imessage" | "gmail" | "gcal" | "all";
type Period = "6m" | "1y" | "2y" | "all";

interface OnboardCursor {
  source: string;
  lastProcessedId: string;
  lastProcessedDate: string;
  status: "in_progress" | "complete";
}

interface OnboardState {
  cursors: Record<string, OnboardCursor>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CURSOR_FILE = join(EGG_MEMORY_DIR, "data", "onboard-cursor.json");
const MAX_BATCH_CHARS = 15000;

// ── Cursor persistence ────────────────────────────────────────────────────────

function loadState(): OnboardState {
  try {
    if (existsSync(CURSOR_FILE)) {
      return JSON.parse(readFileSync(CURSOR_FILE, "utf-8"));
    }
  } catch {}
  return { cursors: {} };
}

function saveState(state: OnboardState): void {
  mkdirSync(join(EGG_MEMORY_DIR, "data"), { recursive: true });
  writeFileSync(CURSOR_FILE, JSON.stringify(state, null, 2));
}

// ── Period → Date ─────────────────────────────────────────────────────────────

function periodToDate(period: Period): Date {
  if (period === "all") return new Date(0);
  const now = new Date();
  const map: Record<string, number> = { "6m": 6, "1y": 12, "2y": 24 };
  const months = map[period] ?? 6;
  now.setMonth(now.getMonth() - months);
  return now;
}

// ── Brain spawning (resolve-not-reject) ───────────────────────────────────────

function spawnOnboardBrain(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      EGG_BRAIN,
      ["-p", prompt, "--output-format", "text", "--dangerously-skip-permissions", "--model", EGG_MODEL],
      {
        cwd: EGG_MEMORY_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      },
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => {
      errChunks.push(data);
      const line = data.toString("utf-8");
      if (line.trim()) process.stderr.write(`[onboard:brain] ${line}`);
    });

    child.on("error", (err) => {
      console.error(`[onboard] brain spawn error: ${err}`);
      resolve("");
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        console.error(`[onboard] brain exited with code ${code}: ${stderr.slice(0, 200)}`);
        resolve(stdout || "");
      } else {
        resolve(stdout);
      }
    });
  });
}

function buildDistillPrompt(source: string, batchLabel: string, content: string): string {
  return [
    `You are processing historical ${source} data for onboarding — distilling the user's life context into structured memory files.`,
    `This batch covers: ${batchLabel}`,
    "",
    "Based on the data below, create or update the relevant memory files:",
    "- people/{name}.md — relationship dossiers (who they are, how you interact, key topics)",
    "- daily/{YYYY-MM-DD}.md — timeline of key events for specific dates",
    "- projects/{name}.md — project context (what it is, status, key people involved)",
    "",
    "Rules:",
    "- Write SUMMARIES only — never store raw message/email content in files",
    "- If a file already exists, read it first and append under a dated heading",
    "- Create people/ projects/ daily/ directories if they don't exist",
    "- Focus on: relationships, commitments, project context, emotional signals, life events",
    "- Be concise — each dossier should be scannable, not exhaustive",
    "- Skip trivial/automated messages (receipts, spam, newsletters) unless they reveal something meaningful",
    "",
    "Data:",
    "",
    content,
  ].join("\n");
}

// ── iMessage onboarding ───────────────────────────────────────────────────────

interface ImessageRow {
  ROWID: number;
  text: string | null;
  is_from_me: number;
  unix_timestamp: number;
  sender_handle: string | null;
  chat_identifier: string | null;
  display_name: string | null;
}

async function onboardImessage(since: Date, state: OnboardState): Promise<void> {
  const cursorKey = "imessage";
  const cursor = state.cursors[cursorKey];
  if (cursor?.status === "complete") {
    console.log("[onboard] iMessage already completed — skipping. Delete data/onboard-cursor.json to re-run.");
    return;
  }

  if (!existsSync(CHAT_DB)) {
    console.error(`[onboard] chat.db not found at ${CHAT_DB}`);
    return;
  }

  console.log(`[onboard] iMessage: processing messages since ${since.toISOString().slice(0, 10)}`);

  const db = new Database(CHAT_DB, { fileMustExist: true });
  db.pragma("query_only = ON");

  // Convert JS date to macOS absolute time (seconds since 2001-01-01 * 1e9)
  const macAbsoluteTime = BigInt(Math.floor((since.getTime() / 1000 - 978307200) * 1000000000));
  const resumeRowid = cursor?.lastProcessedId ? parseInt(cursor.lastProcessedId, 10) : 0;

  const stmt = db.prepare(
    `SELECT
      m.ROWID,
      m.text,
      m.is_from_me,
      m.date / 1000000000 + 978307200 as unix_timestamp,
      h.id as sender_handle,
      c.chat_identifier,
      c.display_name
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE m.date > ? AND m.ROWID > ? AND m.associated_message_type = 0
    ORDER BY m.date ASC
    LIMIT 500`,
  );

  let totalProcessed = 0;
  let lastRowid = resumeRowid;
  let hasMore = true;

  while (hasMore) {
    const rows = stmt.all(macAbsoluteTime, lastRowid) as ImessageRow[];
    if (rows.length === 0) {
      hasMore = false;
      break;
    }

    // Group by chat thread
    const threads = new Map<string, ImessageRow[]>();
    for (const row of rows) {
      if (!row.text) continue;
      const key = row.chat_identifier || row.sender_handle || "unknown";
      const existing = threads.get(key);
      if (existing) existing.push(row);
      else threads.set(key, [row]);
    }

    // Build batches of threads up to MAX_BATCH_CHARS
    let batchContent = "";
    let batchThreads: string[] = [];
    let batchRowid = lastRowid;

    for (const [threadId, msgs] of threads) {
      const displayName = msgs[0].display_name || threadId;
      const lines: string[] = [`### Thread: ${displayName} (${threadId})`];

      for (const msg of msgs) {
        const direction = msg.is_from_me ? "→ sent" : "← received";
        const from = msg.is_from_me ? "me" : (msg.sender_handle || "them");
        const ts = msg.unix_timestamp;
        const time = ts
          ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")
          : "unknown";
        const text = stripPII(msg.text || "");
        if (!text) continue;
        lines.push(`  [${time}] ${direction} (${from}): ${text}`);
        batchRowid = Math.max(batchRowid, msg.ROWID);
      }

      const section = lines.join("\n");
      if (batchContent.length + section.length > MAX_BATCH_CHARS && batchContent.length > 0) {
        // Flush current batch
        const label = `iMessage threads: ${batchThreads.join(", ")}`;
        const prompt = buildDistillPrompt("iMessage", label, batchContent);
        console.log(`[onboard] iMessage batch: ${batchThreads.length} threads, ${batchContent.length} chars`);
        await spawnOnboardBrain(prompt);

        batchContent = "";
        batchThreads = [];
      }

      batchContent += section + "\n\n";
      batchThreads.push(displayName);
    }

    // Flush remaining batch
    if (batchContent.trim()) {
      const label = `iMessage threads: ${batchThreads.join(", ")}`;
      const prompt = buildDistillPrompt("iMessage", label, batchContent);
      console.log(`[onboard] iMessage batch: ${batchThreads.length} threads, ${batchContent.length} chars`);
      await spawnOnboardBrain(prompt);
    }

    lastRowid = rows[rows.length - 1].ROWID;
    totalProcessed += rows.length;

    // Save cursor after each page
    state.cursors[cursorKey] = {
      source: "imessage",
      lastProcessedId: String(lastRowid),
      lastProcessedDate: new Date().toISOString(),
      status: "in_progress",
    };
    saveState(state);

    console.log(`[onboard] iMessage: processed ${totalProcessed} messages so far (ROWID ${lastRowid})`);
  }

  db.close();

  state.cursors[cursorKey] = {
    source: "imessage",
    lastProcessedId: String(lastRowid),
    lastProcessedDate: new Date().toISOString(),
    status: "complete",
  };
  saveState(state);

  console.log(`[onboard] iMessage complete: ${totalProcessed} messages processed`);
}

// ── Gmail onboarding ──────────────────────────────────────────────────────────

interface GmailEmailMeta {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
}

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function fetchGmailForOnboard(
  auth: OAuth2Client,
  afterDate: Date,
  beforeDate: Date,
): Promise<GmailEmailMeta[]> {
  const gmail = google.gmail({ version: "v1", auth });

  const afterEpoch = Math.floor(afterDate.getTime() / 1000);
  const beforeEpoch = Math.floor(beforeDate.getTime() / 1000);
  const query = `after:${afterEpoch} before:${beforeEpoch}`;

  const messageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });

    for (const msg of res.data.messages ?? []) {
      if (msg.id) messageIds.push(msg.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(`[onboard] Gmail: found ${messageIds.length} messages`);

  const emails: GmailEmailMeta[] = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        }).catch(() => null),
      ),
    );

    for (const res of results) {
      if (!res) continue;
      const msg = res.data;
      const headers = msg.payload?.headers ?? [];

      const dateStr = getHeader(headers, "Date");
      let isoDate: string;
      try {
        isoDate = new Date(dateStr).toISOString();
      } catch {
        isoDate = dateStr;
      }

      emails.push({
        id: msg.id ?? "",
        threadId: msg.threadId ?? "",
        date: isoDate,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To").split(",").map((s) => s.trim()).filter(Boolean),
        subject: getHeader(headers, "Subject"),
        snippet: msg.snippet ?? "",
      });
    }

    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= messageIds.length) {
      console.log(`[onboard] Gmail: fetched ${Math.min(i + BATCH_SIZE, messageIds.length)}/${messageIds.length}`);
    }
  }

  return emails;
}

async function onboardGmail(since: Date, state: OnboardState): Promise<void> {
  const cursorKey = "gmail";
  const cursor = state.cursors[cursorKey];
  if (cursor?.status === "complete") {
    console.log("[onboard] Gmail already completed — skipping. Delete data/onboard-cursor.json to re-run.");
    return;
  }

  const config = getGoogleOAuthConfig();
  if (!config) {
    console.error("[onboard] No Google OAuth config. Run `egg google:auth` first.");
    return;
  }

  const accounts = loadAllAccounts();
  if (accounts.length === 0) {
    console.error("[onboard] No Google accounts configured. Run `egg google:auth` first.");
    return;
  }

  const now = new Date();

  for (const account of accounts) {
    console.log(`[onboard] Gmail: processing ${account.email}`);
    try {
      const client = await getAuthedClient(config, account);
      const emails = await fetchGmailForOnboard(client, since, now);

      // Group by thread
      const threads = new Map<string, GmailEmailMeta[]>();
      for (const email of emails) {
        const existing = threads.get(email.threadId);
        if (existing) existing.push(email);
        else threads.set(email.threadId, [email]);
      }

      // Build batches
      let batchContent = "";
      let batchCount = 0;
      let batchNum = 0;
      let lastId = cursor?.lastProcessedId ?? "";

      for (const [threadId, threadEmails] of threads) {
        // If resuming, skip already-processed threads
        if (lastId && threadId <= lastId) continue;

        threadEmails.sort((a, b) => a.date.localeCompare(b.date));
        const subject = threadEmails[0].subject || "(no subject)";
        const lines: string[] = [`### Thread: ${subject}`];

        for (const email of threadEmails) {
          const from = stripPII(email.from);
          const to = email.to.map((t) => stripPII(t)).join(", ");
          const snippet = stripPII(email.snippet);
          lines.push(`  [${email.date.slice(0, 16)}] From: ${from} → To: ${to}`);
          lines.push(`  Subject: ${stripPII(email.subject)}`);
          lines.push(`  Snippet: ${snippet}`);
          lines.push("");
        }

        const section = lines.join("\n");
        if (batchContent.length + section.length > MAX_BATCH_CHARS && batchContent.length > 0) {
          batchNum++;
          const prompt = buildDistillPrompt("Gmail", `${account.email} batch ${batchNum} (${batchCount} threads)`, batchContent);
          console.log(`[onboard] Gmail batch ${batchNum}: ${batchCount} threads, ${batchContent.length} chars`);
          await spawnOnboardBrain(prompt);
          batchContent = "";
          batchCount = 0;
        }

        batchContent += section + "\n";
        batchCount++;
        lastId = threadId;

        // Save cursor periodically
        state.cursors[cursorKey] = {
          source: "gmail",
          lastProcessedId: lastId,
          lastProcessedDate: new Date().toISOString(),
          status: "in_progress",
        };
        saveState(state);
      }

      // Flush remaining
      if (batchContent.trim()) {
        batchNum++;
        const prompt = buildDistillPrompt("Gmail", `${account.email} batch ${batchNum} (${batchCount} threads)`, batchContent);
        console.log(`[onboard] Gmail batch ${batchNum}: ${batchCount} threads, ${batchContent.length} chars`);
        await spawnOnboardBrain(prompt);
      }
    } catch (err) {
      console.error(`[onboard] Gmail failed for ${account.email}:`, err);
    }
  }

  state.cursors[cursorKey] = {
    source: "gmail",
    lastProcessedId: "",
    lastProcessedDate: new Date().toISOString(),
    status: "complete",
  };
  saveState(state);
  console.log("[onboard] Gmail complete");
}

// ── GCal onboarding ───────────────────────────────────────────────────────────

interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  attendees: string[];
  calendar: string;
}

async function fetchCalEvents(
  auth: OAuth2Client,
  timeMin: string,
  timeMax: string,
): Promise<CalEvent[]> {
  const cal = google.calendar({ version: "v3", auth });
  const calListRes = await cal.calendarList.list();
  const calendars = calListRes.data.items ?? [];
  const allEvents: CalEvent[] = [];

  for (const calEntry of calendars) {
    const calId = calEntry.id;
    const calName = calEntry.summary ?? calId ?? "Unknown";
    if (!calId) continue;

    let pageToken: string | undefined;
    do {
      const res = await cal.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
        pageToken,
      });

      for (const ev of res.data.items ?? []) {
        const start = ev.start?.dateTime ?? ev.start?.date ?? "";
        const end = ev.end?.dateTime ?? ev.end?.date ?? "";
        allEvents.push({
          id: ev.id ?? "",
          title: ev.summary ?? "(no title)",
          start,
          end,
          location: ev.location ?? null,
          description: ev.description ? ev.description.slice(0, 500) : null,
          attendees: (ev.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
          calendar: calName,
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return allEvents;
}

async function onboardGcal(since: Date, state: OnboardState): Promise<void> {
  const cursorKey = "gcal";
  const cursor = state.cursors[cursorKey];
  if (cursor?.status === "complete") {
    console.log("[onboard] GCal already completed — skipping. Delete data/onboard-cursor.json to re-run.");
    return;
  }

  const config = getGoogleOAuthConfig();
  if (!config) {
    console.error("[onboard] No Google OAuth config. Run `egg google:auth` first.");
    return;
  }

  const accounts = loadAllAccounts();
  if (accounts.length === 0) {
    console.error("[onboard] No Google accounts configured. Run `egg google:auth` first.");
    return;
  }

  const now = new Date();

  for (const account of accounts) {
    console.log(`[onboard] GCal: processing ${account.email}`);
    try {
      const client = await getAuthedClient(config, account);
      const events = await fetchCalEvents(client, since.toISOString(), now.toISOString());
      console.log(`[onboard] GCal: fetched ${events.length} events for ${account.email}`);

      // Group by month
      const byMonth = new Map<string, CalEvent[]>();
      for (const ev of events) {
        const month = ev.start.slice(0, 7); // YYYY-MM
        const existing = byMonth.get(month);
        if (existing) existing.push(ev);
        else byMonth.set(month, [ev]);
      }

      const sortedMonths = [...byMonth.keys()].sort();
      let lastMonth = cursor?.lastProcessedId ?? "";

      for (const month of sortedMonths) {
        if (lastMonth && month <= lastMonth) continue;

        const monthEvents = byMonth.get(month)!;
        monthEvents.sort((a, b) => a.start.localeCompare(b.start));

        const lines: string[] = [`### ${month} — ${monthEvents.length} events`];
        for (const ev of monthEvents) {
          const title = stripPII(ev.title);
          const location = ev.location ? `, location: ${stripPII(ev.location)}` : "";
          const attendeeStr = ev.attendees.length > 0
            ? `, attendees: ${ev.attendees.map((a) => stripPII(a)).join(", ")}`
            : "";
          const desc = ev.description
            ? `\n    ${stripPII(ev.description).slice(0, 200)}`
            : "";
          lines.push(`  [${ev.start.slice(0, 16)}–${ev.end.slice(11, 16) || ev.end.slice(0, 10)}] ${title}${location}${attendeeStr}${desc}`);
        }

        const content = lines.join("\n");
        const prompt = buildDistillPrompt("Google Calendar", `${account.email} — ${month}`, content);
        console.log(`[onboard] GCal batch: ${month} — ${monthEvents.length} events, ${content.length} chars`);
        await spawnOnboardBrain(prompt);

        lastMonth = month;
        state.cursors[cursorKey] = {
          source: "gcal",
          lastProcessedId: lastMonth,
          lastProcessedDate: new Date().toISOString(),
          status: "in_progress",
        };
        saveState(state);
      }
    } catch (err) {
      console.error(`[onboard] GCal failed for ${account.email}:`, err);
    }
  }

  state.cursors[cursorKey] = {
    source: "gcal",
    lastProcessedId: "",
    lastProcessedDate: new Date().toISOString(),
    status: "complete",
  };
  saveState(state);
  console.log("[onboard] GCal complete");
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runOnboard(source: Source, period: Period): Promise<void> {
  const since = periodToDate(period);
  const state = loadState();

  console.log(`[onboard] Starting onboarding: source=${source}, period=${period}, since=${since.toISOString().slice(0, 10)}`);

  const sources: Source[] = source === "all" ? ["imessage", "gmail", "gcal"] : [source];

  for (const src of sources) {
    try {
      switch (src) {
        case "imessage":
          await onboardImessage(since, state);
          break;
        case "gmail":
          await onboardGmail(since, state);
          break;
        case "gcal":
          await onboardGcal(since, state);
          break;
      }
    } catch (err) {
      console.error(`[onboard] ${src} failed:`, err);
    }
  }

  console.log("[onboard] Onboarding complete.");
}
