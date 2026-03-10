import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import {
  getGoogleOAuthConfig,
  loadAllAccounts,
  getAuthedClient,
  logGoogle,
} from "./google.js";
import { EGG_MEMORY_DIR } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface EmailMeta {
  id: string;
  threadId: string;
  date: string;         // ISO datetime
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  labels: string[];
  snippet: string;      // Gmail's auto-generated snippet (~200 chars)
  isStarred: boolean;
  isImportant: boolean;
}

interface GmailMonthFile {
  month: string;        // YYYY-MM
  account: string;
  emails: EmailMeta[];
}

// ── Output directory ─────────────────────────────────────────────────────────

function getGmailDir(): string {
  return join(EGG_MEMORY_DIR, "data", "gmail");
}

// ── Header extraction ────────────────────────────────────────────────────────

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Fetch messages for a single account ──────────────────────────────────────

async function fetchGmailMessages(
  auth: OAuth2Client,
  afterDate: Date,
  beforeDate: Date,
): Promise<EmailMeta[]> {
  const gmail = google.gmail({ version: "v1", auth });

  // Gmail search query for date range
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);
  const beforeEpoch = Math.floor(beforeDate.getTime() / 1000);
  const query = `after:${afterEpoch} before:${beforeEpoch}`;

  const allMessages: EmailMeta[] = [];
  let pageToken: string | undefined;
  let listCount = 0;

  // First, list all message IDs matching the query
  const messageIds: string[] = [];
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
    listCount++;
    if (listCount % 5 === 0) {
      logGoogle(`  Listed ${messageIds.length} message IDs so far...`);
    }
  } while (pageToken);

  logGoogle(`  Found ${messageIds.length} messages total. Fetching metadata...`);

  // Fetch metadata in batches
  const BATCH_SIZE = 50;
  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
        }).catch((err) => {
          logGoogle(`  WARNING: failed to fetch message ${id}: ${err}`);
          return null;
        }),
      ),
    );

    for (const res of results) {
      if (!res) continue;
      const msg = res.data;
      const headers = msg.payload?.headers ?? [];
      const labels = msg.labelIds ?? [];

      const dateStr = getHeader(headers, "Date");
      let isoDate: string;
      try {
        isoDate = new Date(dateStr).toISOString();
      } catch {
        isoDate = dateStr;
      }

      allMessages.push({
        id: msg.id ?? "",
        threadId: msg.threadId ?? "",
        date: isoDate,
        from: getHeader(headers, "From"),
        to: parseAddressList(getHeader(headers, "To")),
        cc: parseAddressList(getHeader(headers, "Cc")),
        subject: getHeader(headers, "Subject"),
        labels,
        snippet: msg.snippet ?? "",
        isStarred: labels.includes("STARRED"),
        isImportant: labels.includes("IMPORTANT"),
      });
    }

    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= messageIds.length) {
      logGoogle(`  Fetched metadata for ${Math.min(i + BATCH_SIZE, messageIds.length)}/${messageIds.length} messages`);
    }
  }

  return allMessages;
}

// ── Group emails by month ────────────────────────────────────────────────────

function groupByMonth(emails: EmailMeta[]): Map<string, EmailMeta[]> {
  const byMonth = new Map<string, EmailMeta[]>();
  for (const email of emails) {
    const month = email.date.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(email);
  }
  return byMonth;
}

// ── Write gmail data to egg-memory ───────────────────────────────────────────

function writeGmailData(account: string, emails: EmailMeta[]): void {
  const dir = getGmailDir();
  const accountDir = join(dir, account.replace(/@/g, "_at_").replace(/\./g, "_"));
  mkdirSync(accountDir, { recursive: true });

  const byMonth = groupByMonth(emails);
  const sortedMonths = [...byMonth.keys()].sort();

  for (const month of sortedMonths) {
    const monthEmails = byMonth.get(month)!;
    // Sort by date within month
    monthEmails.sort((a, b) => a.date.localeCompare(b.date));

    const monthFile: GmailMonthFile = {
      month,
      account,
      emails: monthEmails,
    };
    writeFileSync(join(accountDir, `${month}.json`), JSON.stringify(monthFile, null, 2));
  }

  // Write starred/important emails to a separate highlights file
  const highlights = emails.filter((e) => e.isStarred || e.isImportant);
  if (highlights.length > 0) {
    highlights.sort((a, b) => a.date.localeCompare(b.date));
    writeFileSync(
      join(accountDir, "_highlights.json"),
      JSON.stringify({ account, count: highlights.length, emails: highlights }, null, 2),
    );
    logGoogle(`Gmail: wrote ${highlights.length} highlighted emails for ${account}`);
  }

  // Write summary index
  const summary = {
    account,
    dateRange: {
      from: sortedMonths[0],
      to: sortedMonths[sortedMonths.length - 1],
    },
    totalEmails: emails.length,
    totalMonths: sortedMonths.length,
    starredCount: emails.filter((e) => e.isStarred).length,
    importantCount: emails.filter((e) => e.isImportant).length,
    topSenders: getTopSenders(emails, 20),
    pulledAt: new Date().toISOString(),
  };
  writeFileSync(join(accountDir, "_index.json"), JSON.stringify(summary, null, 2));

  logGoogle(`Gmail: wrote ${emails.length} emails across ${sortedMonths.length} months for ${account}`);
}

function getTopSenders(emails: EmailMeta[], limit: number): { sender: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of emails) {
    const sender = e.from;
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([sender, count]) => ({ sender, count }));
}

// ── Fetch sent messages ─────────────────────────────────────────────────────

async function fetchSentGmailMessages(
  auth: OAuth2Client,
  afterDate: Date,
  beforeDate: Date,
): Promise<EmailMeta[]> {
  const gmail = google.gmail({ version: "v1", auth });

  const afterEpoch = Math.floor(afterDate.getTime() / 1000);
  const beforeEpoch = Math.floor(beforeDate.getTime() / 1000);
  const query = `in:sent after:${afterEpoch} before:${beforeEpoch}`;

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

  logGoogle(`  Found ${messageIds.length} sent messages. Fetching metadata...`);

  const allMessages: EmailMeta[] = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
        }).catch((err) => {
          logGoogle(`  WARNING: failed to fetch sent message ${id}: ${err}`);
          return null;
        }),
      ),
    );

    for (const res of results) {
      if (!res) continue;
      const msg = res.data;
      const headers = msg.payload?.headers ?? [];
      const labels = msg.labelIds ?? [];

      const dateStr = getHeader(headers, "Date");
      let isoDate: string;
      try {
        isoDate = new Date(dateStr).toISOString();
      } catch {
        isoDate = dateStr;
      }

      allMessages.push({
        id: msg.id ?? "",
        threadId: msg.threadId ?? "",
        date: isoDate,
        from: getHeader(headers, "From"),
        to: parseAddressList(getHeader(headers, "To")),
        cc: parseAddressList(getHeader(headers, "Cc")),
        subject: getHeader(headers, "Subject"),
        labels,
        snippet: msg.snippet ?? "",
        isStarred: labels.includes("STARRED"),
        isImportant: labels.includes("IMPORTANT"),
      });
    }

    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= messageIds.length) {
      logGoogle(`  Fetched sent metadata for ${Math.min(i + BATCH_SIZE, messageIds.length)}/${messageIds.length}`);
    }
  }

  return allMessages;
}

// ── Write sent gmail data to egg-memory ─────────────────────────────────────

function writeSentGmailData(account: string, emails: EmailMeta[]): void {
  const dir = getGmailDir();
  const accountDir = join(dir, account.replace(/@/g, "_at_").replace(/\./g, "_"));
  mkdirSync(accountDir, { recursive: true });

  const byMonth = groupByMonth(emails);
  const sortedMonths = [...byMonth.keys()].sort();

  for (const month of sortedMonths) {
    const monthEmails = byMonth.get(month)!;
    monthEmails.sort((a, b) => a.date.localeCompare(b.date));

    const monthFile: GmailMonthFile = {
      month,
      account,
      emails: monthEmails,
    };
    writeFileSync(join(accountDir, `sent-${month}.json`), JSON.stringify(monthFile, null, 2));
  }

  logGoogle(`Gmail: wrote ${emails.length} sent emails across ${sortedMonths.length} months for ${account}`);
}

// ── Main intake function ─────────────────────────────────────────────────────

export async function intakeGmail(): Promise<void> {
  const config = getGoogleOAuthConfig();
  if (!config) {
    console.error("[gmail] No Google OAuth config found. Run `egg google:auth` first.");
    process.exit(1);
  }

  const accounts = loadAllAccounts();
  if (accounts.length === 0) {
    console.error("[gmail] No Google accounts configured. Run `egg google:auth` first.");
    process.exit(1);
  }

  // 6 months back from now
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // Sent emails: only last 48 hours (for outbound monitoring / anti-nag)
  const sentAfter = new Date(now);
  sentAfter.setHours(sentAfter.getHours() - 48);

  logGoogle(`Gmail intake: ${sixMonthsAgo.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}`);

  for (const account of accounts) {
    logGoogle(`Fetching Gmail messages for ${account.email}...`);
    try {
      const client = await getAuthedClient(config, account);

      // Inbound emails (6 months)
      const emails = await fetchGmailMessages(client, sixMonthsAgo, now);
      logGoogle(`Fetched ${emails.length} emails for ${account.email}`);
      writeGmailData(account.email, emails);

      // Sent emails (last 48h)
      logGoogle(`Fetching sent emails for ${account.email}...`);
      const sentEmails = await fetchSentGmailMessages(client, sentAfter, now);
      logGoogle(`Fetched ${sentEmails.length} sent emails for ${account.email}`);
      if (sentEmails.length > 0) {
        writeSentGmailData(account.email, sentEmails);
      }
    } catch (err) {
      logGoogle(`ERROR fetching Gmail for ${account.email}: ${err}`);
      console.error(`[gmail] Failed for ${account.email}:`, err);
    }
  }

  logGoogle("Gmail intake complete.");
}
