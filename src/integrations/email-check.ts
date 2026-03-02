import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import Anthropic from "@anthropic-ai/sdk";
import {
  getGoogleOAuthConfig,
  loadAllAccounts,
  getAuthedClient,
  logGoogle,
} from "./google.js";
import { EGG_MEMORY_DIR, EMAIL_CHECK_INTERVAL_MS, NUDGES_DIR } from "../config.js";
import { EMAIL_CHECK_LOG } from "../logger.js";
import { recordTokenUsage } from "../token-tracker.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface NewEmail {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  labels: string[];
  isStarred: boolean;
  isImportant: boolean;
  hasUnsubscribe: boolean;
  categoryLabels: string[];   // CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, etc.
  body?: string;              // full text body (fetched on demand for notable emails)
}

interface SentThread {
  threadId: string;
  subject: string;
  sentAt: number;        // unix ms
  to: string[];
  replied: boolean;
}

interface EmailCheckCursor {
  lastCheckAt: number;           // unix ms
  seenMessageIds: string[];      // recent IDs for dedup (keep last 500)
  sentThreads: SentThread[];     // outbound threads to watch for replies
}

// ── State ────────────────────────────────────────────────────────────────────

const CURSOR_FILE = join(EGG_MEMORY_DIR, "data", "email-check-cursor.json");
const MAX_SEEN_IDS = 500;
const MAX_NUDGES_PER_CHECK = 3;
const OPEN_THREAD_WINDOW_MS = 48 * 60 * 60 * 1000;   // 48 hours
const OPEN_THREAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;   // 24 hours
const MAX_SENT_THREADS = 200;

function logCheck(message: string): void {
  console.log(`[email-check] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(EMAIL_CHECK_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function loadCursor(): EmailCheckCursor {
  try {
    if (existsSync(CURSOR_FILE)) {
      return JSON.parse(readFileSync(CURSOR_FILE, "utf-8"));
    }
  } catch {}
  return { lastCheckAt: 0, seenMessageIds: [], sentThreads: [] };
}

function saveCursor(cursor: EmailCheckCursor): void {
  try {
    mkdirSync(join(EGG_MEMORY_DIR, "data"), { recursive: true });
    // Prune seen IDs to keep only the most recent
    if (cursor.seenMessageIds.length > MAX_SEEN_IDS) {
      cursor.seenMessageIds = cursor.seenMessageIds.slice(-MAX_SEEN_IDS);
    }
    // Prune old sent threads (older than 48h or replied)
    const cutoff = Date.now() - OPEN_THREAD_WINDOW_MS;
    cursor.sentThreads = cursor.sentThreads
      .filter((t) => !t.replied && t.sentAt > cutoff)
      .slice(-MAX_SENT_THREADS);
    writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
  } catch (err) {
    logCheck(`ERROR saving cursor: ${err}`);
  }
}

// ── Known contacts detection ─────────────────────────────────────────────────

function loadKnownContactNames(): Set<string> {
  const names = new Set<string>();
  const peopleDir = join(EGG_MEMORY_DIR, "people");
  try {
    if (!existsSync(peopleDir)) return names;
    for (const file of readdirSync(peopleDir)) {
      if (file.endsWith(".md")) {
        names.add(file.replace(/\.md$/, "").toLowerCase());
      }
    }
  } catch {}
  return names;
}

function isFromKnownContact(from: string, knownNames: Set<string>): boolean {
  // Extract display name from "Name <email>" format
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) {
    const displayName = nameMatch[1].trim().toLowerCase();
    // Check each word of the display name against dossier filenames
    const words = displayName.split(/\s+/);
    for (const word of words) {
      if (word.length > 2 && knownNames.has(word)) return true;
    }
    // Check full name (spaces replaced with dashes, as dossier filenames may use)
    const normalized = displayName.replace(/\s+/g, "-");
    if (knownNames.has(normalized)) return true;
  }
  return false;
}

// ── Header helpers ───────────────────────────────────────────────────────────

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Fast email fetch (metadata only, incremental) ────────────────────────────

async function fetchNewMessages(
  auth: OAuth2Client,
  afterEpoch: number,
  accountEmail: string,
): Promise<NewEmail[]> {
  const gmail = google.gmail({ version: "v1", auth });

  // Query for emails after the last check timestamp
  const query = `after:${afterEpoch}`;

  // List message IDs only (lightweight)
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 100,  // cap per check — we only care about recent
  });

  const messageIds = (res.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => !!id);

  if (messageIds.length === 0) return [];

  // Fetch metadata in batches
  const BATCH_SIZE = 50;
  const emails: NewEmail[] = [];

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date", "List-Unsubscribe"],
        }).catch((err) => {
          logCheck(`WARNING: failed to fetch message ${id}: ${err}`);
          return null;
        }),
      ),
    );

    for (const r of results) {
      if (!r) continue;
      const msg = r.data;
      const headers = msg.payload?.headers ?? [];
      const labels = msg.labelIds ?? [];

      const dateStr = getHeader(headers, "Date");
      let isoDate: string;
      try {
        isoDate = new Date(dateStr).toISOString();
      } catch {
        isoDate = dateStr;
      }

      const categoryLabels = labels.filter((l) => l.startsWith("CATEGORY_"));

      emails.push({
        id: msg.id ?? "",
        threadId: msg.threadId ?? "",
        date: isoDate,
        from: getHeader(headers, "From"),
        to: parseAddressList(getHeader(headers, "To")),
        subject: getHeader(headers, "Subject"),
        snippet: msg.snippet ?? "",
        labels,
        isStarred: labels.includes("STARRED"),
        isImportant: labels.includes("IMPORTANT"),
        hasUnsubscribe: !!getHeader(headers, "List-Unsubscribe"),
        categoryLabels,
      });
    }
  }

  return emails;
}

// ── Anthropic client (for email summarization) ──────────────────────────────

let anthropicClient: Anthropic | null = null;
let anthropicKeyMissing = false;

function getAnthropicClient(): Anthropic | null {
  if (anthropicKeyMissing) return null;
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      logCheck("ANTHROPIC_API_KEY not set — email summary disabled");
      anthropicKeyMissing = true;
      return null;
    }
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ── Email body fetching ──────────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractTextBody(payload: any): string {
  if (!payload) return "";

  // Single-part text/plain message
  if (payload.body?.data && payload.mimeType === "text/plain") {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — find text/plain recursively
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const nested = extractTextBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

async function fetchEmailBody(auth: OAuth2Client, messageId: string): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    return extractTextBody(res.data.payload) || "";
  } catch (err) {
    logCheck(`WARNING: failed to fetch body for ${messageId}: ${err}`);
    return "";
  }
}

// ── AI summarization ─────────────────────────────────────────────────────────

async function summarizeEmails(emails: NewEmail[]): Promise<string | null> {
  const client = getAnthropicClient();
  if (!client) return null;

  const emailDescriptions = emails.map((e, i) => {
    const sender = e.from.replace(/<[^>]+>/, "").trim() || e.from;
    const body = e.body ? `\nBody:\n${e.body.slice(0, 2000)}` : "";
    return `Email ${i + 1}:\nFrom: ${sender}\nSubject: ${e.subject}\nSnippet: ${e.snippet}${body}`;
  }).join("\n\n---\n\n");

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `You are summarizing emails for a text message notification. For each email, write a concise summary starting with 📩.

Rules:
- Write in lowercase, casual tone
- For actionable emails, include: what it's about, who needs what, any deadlines, and how to respond
- For non-actionable emails (newsletters, FYIs, receipts), keep to one line ending with "— no action needed, just FYI"
- Separate multiple emails with a blank line
- Do NOT add any preamble or explanation, just the summaries

Format for actionable emails:
📩 [brief summary of what it's about]:

deadline: [date if mentioned]

[who] needs:
- [action item 1]
- [action item 2]

respond to: [email or instructions if applicable]

Format for non-actionable emails:
📩 [brief summary] — no action needed, just FYI

Here are the emails to summarize:

${emailDescriptions}`,
      }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    recordTokenUsage("claude-haiku-4-5-20251001", response.usage.input_tokens, response.usage.output_tokens);

    return text.trim();
  } catch (err) {
    logCheck(`WARNING: email summarization failed: ${err}`);
    return null;
  }
}

// ── Nudge writing ────────────────────────────────────────────────────────────

async function writeEmailNudge(
  emails: NewEmail[],
  authMap: Map<string, OAuth2Client>,
): Promise<void> {
  if (emails.length === 0) return;

  // Fetch full bodies for notable emails (at most MAX_NUDGES_PER_CHECK = 3)
  for (const email of emails) {
    const auth = authMap.get(email.id);
    if (auth) {
      email.body = await fetchEmailBody(auth, email.id);
    }
  }

  // Try AI summarization, fall back to raw format
  let content = await summarizeEmails(emails);

  if (!content) {
    // Fallback: raw format with 📩 prefix
    const lines: string[] = [];
    for (const email of emails) {
      const sender = email.from.replace(/<[^>]+>/, "").trim() || email.from;
      const star = email.isStarred ? " *" : "";
      lines.push(`📩 ${sender}: ${email.subject}${star}`);
      if (email.snippet) {
        const snip = email.snippet.length > 80
          ? email.snippet.slice(0, 77) + "..."
          : email.snippet;
        lines.push(`  "${snip}"`);
      }
    }
    content = lines.join("\n");
  }

  mkdirSync(NUDGES_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(NUDGES_DIR, `${ts}.md`), content);
  logCheck(`Wrote nudge for ${emails.length} email(s)`);
}

function writeOpenThreadsNudge(threads: SentThread[]): void {
  if (threads.length === 0) return;

  mkdirSync(NUDGES_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const lines: string[] = [];

  lines.push("Open email threads with no reply:");
  for (const t of threads.slice(0, 5)) {
    const age = Math.round((Date.now() - t.sentAt) / 3_600_000);
    const recipient = t.to[0]?.replace(/<[^>]+>/, "").trim() || t.to[0] || "unknown";
    lines.push(`- To ${recipient}: "${t.subject}" (${age}h ago)`);
  }

  writeFileSync(join(NUDGES_DIR, `${ts}.md`), lines.join("\n"));
  logCheck(`Wrote open-threads nudge for ${threads.length} thread(s)`);
}

// ── Marketing / newsletter detection ─────────────────────────────────────────

/** Sender prefixes that indicate automated/marketing mail */
const NOREPLY_PREFIXES = [
  "noreply@", "no-reply@", "no_reply@",
  "newsletter@", "newsletters@",
  "marketing@", "promo@", "promotions@",
  "deals@", "offers@", "sales@",
  "news@", "hello@", "info@",
  "updates@", "notifications@", "notify@",
  "mailer@", "bulk@", "bounce@",
  "support@", "team@",
];

/** Domains overwhelmingly used for promotional/marketing sends */
const PROMO_SENDER_DOMAINS = new Set([
  // Email service providers / marketing platforms
  "sendgrid.net", "mailchimp.com", "mailgun.org", "constantcontact.com",
  "hubspot.com", "hubspotmail.net", "klaviyo.com", "braze.com",
  "sailthru.com", "iterable.com", "customer.io", "intercom-mail.com",
  "mandrillapp.com", "postmarkapp.com", "amazonses.com",
  "sparkpostmail.com", "cmail19.com", "cmail20.com",
  // Retail / fashion
  "gap.com", "oldnavy.com", "bananarepublic.com", "athleta.com",
  "aritzia.com", "aliceandolivia.com", "nordstrom.com", "jcrew.com",
  "macys.com", "bloomingdales.com", "saks.com", "net-a-porter.com",
  "zara.com", "hm.com", "uniqlo.com", "nike.com", "adidas.com",
  "target.com", "walmart.com", "amazon.com", "costco.com",
  "urbanoutfitters.com", "anthropologie.com", "freepeople.com",
  "everlane.com", "madewell.com", "lululemon.com", "rei.com",
  // Tech / SaaS marketing
  "replit.com", "github.com", "notion.so", "figma.com",
  "canva.com", "shopify.com", "squarespace.com",
  "medium.com", "substack.com", "beehiiv.com",
  // Electronics / maker
  "adafruit.com", "sparkfun.com", "digikey.com", "mouser.com",
  // Food / delivery
  "doordash.com", "uber.com", "ubereats.com", "grubhub.com",
  "instacart.com", "caviar.com",
  // Travel
  "airbnb.com", "booking.com", "expedia.com", "hotels.com",
  "kayak.com", "southwest.com", "delta.com", "united.com",
  // News / media
  "politico.com",
  // Misc
  "groupon.com", "yelp.com", "nextdoor.com",
]);

/** Gmail category labels that indicate non-personal mail */
const PROMO_CATEGORY_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
]);

function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : email;
}

function isMarketingEmail(email: NewEmail): boolean {
  const addr = extractEmailAddress(email.from);
  const domain = extractDomain(addr);

  // Check sender prefix blocklist
  for (const prefix of NOREPLY_PREFIXES) {
    if (addr.startsWith(prefix)) return true;
  }

  // Check known promotional sender domains
  if (PROMO_SENDER_DOMAINS.has(domain)) return true;

  // Check Gmail category labels (PROMOTIONS / SOCIAL)
  for (const label of email.categoryLabels) {
    if (PROMO_CATEGORY_LABELS.has(label)) return true;
  }

  // Check for unsubscribe signals
  if (email.hasUnsubscribe) return true;
  const snippetLower = email.snippet.toLowerCase();
  if (snippetLower.includes("unsubscribe") || snippetLower.includes("opt out") || snippetLower.includes("email preferences")) {
    return true;
  }

  return false;
}

function isRealPerson(email: NewEmail): boolean {
  const addr = extractEmailAddress(email.from);
  for (const prefix of NOREPLY_PREFIXES) {
    if (addr.startsWith(prefix)) return false;
  }
  const domain = extractDomain(addr);
  if (PROMO_SENDER_DOMAINS.has(domain)) return false;
  return true;
}

// ── AI newsletter classification ─────────────────────────────────────────────

/** Session-level cache: sender domain → true (personal) / false (newsletter) */
const aiClassificationCache = new Map<string, boolean>();

/**
 * Uses Claude Haiku to classify whether an email is a newsletter/bulk send
 * or a genuine personal/business email. Only called for emails that passed
 * the cheap heuristic filter (isMarketingEmail).
 *
 * Returns true if PERSONAL, false if NEWSLETTER.
 * Falls back to true (let it through) on failure — better to over-notify.
 */
async function classifyEmailWithAI(email: NewEmail): Promise<boolean> {
  const addr = extractEmailAddress(email.from);
  const domain = extractDomain(addr);

  // Check cache first — avoid re-classifying the same sender domain
  if (aiClassificationCache.has(domain)) {
    return aiClassificationCache.get(domain)!;
  }

  const client = getAnthropicClient();
  if (!client) return true; // No API key → let it through

  const prompt = `Classify this email. Is it a newsletter, marketing email, automated notification, or bulk send? Or is it a personal/business email that someone specifically wrote to the recipient?

From: ${email.from}
Subject: ${email.subject}
Snippet: ${email.snippet}
Has unsubscribe header: ${email.hasUnsubscribe}

Reply with just one word: NEWSLETTER or PERSONAL.`;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 5000),
      ),
    ]);

    recordTokenUsage("claude-haiku-4-5-20251001", response.usage.input_tokens, response.usage.output_tokens);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toUpperCase();

    const isPersonal = !text.includes("NEWSLETTER");
    aiClassificationCache.set(domain, isPersonal);
    return isPersonal;
  } catch (err) {
    logCheck(`WARNING: AI classification failed for ${domain}: ${err}`);
    // Fall back to letting it through
    return true;
  }
}

// ── Email importance scoring ─────────────────────────────────────────────────

function isNotableEmail(
  email: NewEmail,
  knownNames: Set<string>,
  sentThreadIds: Set<string>,
): boolean {
  // Starred emails always pass — explicit user signal
  if (email.isStarred) return true;

  // Reject marketing/promotional emails early (even if Gmail says "important")
  if (isMarketingEmail(email)) return false;

  // Known contact (has a dossier in people/)
  if (isFromKnownContact(email.from, knownNames)) return true;

  // Reply to a thread the user sent
  if (sentThreadIds.has(email.threadId)) return true;

  // Real person + Gmail important (important is only useful combined with other signals)
  if (isRealPerson(email) && email.isImportant) return true;

  return false;
}

// ── Main check function ──────────────────────────────────────────────────────

async function checkNewEmails(): Promise<void> {
  const config = getGoogleOAuthConfig();
  if (!config) return;

  const accounts = loadAllAccounts();
  if (accounts.length === 0) return;

  const cursor = loadCursor();
  const now = Date.now();

  // On first run, start from 5 minutes ago to avoid a flood
  const lastCheck = cursor.lastCheckAt || (now - 5 * 60 * 1000);
  const afterEpoch = Math.floor(lastCheck / 1000);

  const seenSet = new Set(cursor.seenMessageIds);
  const knownNames = loadKnownContactNames();
  const sentThreadIds = new Set(cursor.sentThreads.map((t) => t.threadId));

  let allNew: NewEmail[] = [];
  const messageAuthMap = new Map<string, OAuth2Client>();

  for (const account of accounts) {
    try {
      const client = await getAuthedClient(config, account);
      const emails = await fetchNewMessages(client, afterEpoch, account.email);

      // Dedupe against seen IDs
      const unseen = emails.filter((e) => !seenSet.has(e.id));
      if (unseen.length > 0) {
        logCheck(`${unseen.length} new email(s) for ${account.email}`);
      }

      // Track auth clients for body fetching later
      for (const e of unseen) {
        messageAuthMap.set(e.id, client);
      }

      // Track sent emails for open thread detection
      for (const email of unseen) {
        const fromLower = email.from.toLowerCase();
        if (fromLower.includes(account.email.toLowerCase())) {
          // User sent this email — track the thread
          if (!sentThreadIds.has(email.threadId)) {
            cursor.sentThreads.push({
              threadId: email.threadId,
              subject: email.subject,
              sentAt: now,
              to: email.to,
              replied: false,
            });
            sentThreadIds.add(email.threadId);
          }
        } else {
          // Received email — check if it's a reply to a sent thread
          const sentThread = cursor.sentThreads.find((t) => t.threadId === email.threadId);
          if (sentThread) {
            sentThread.replied = true;
          }
        }

        seenSet.add(email.id);
      }

      allNew.push(...unseen);
    } catch (err) {
      logCheck(`ERROR checking ${account.email}: ${err}`);
    }
  }

  // Filter for notable emails (skip user's own sent emails)
  const accountEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
  const inbound = allNew.filter((e) => {
    const fromAddr = extractEmailAddress(e.from);
    return !accountEmails.has(fromAddr);
  });

  // AI classification: filter newsletters that slipped past heuristics
  const genuineInbound: NewEmail[] = [];
  for (const email of inbound) {
    // Skip AI check for starred emails (explicit user signal)
    if (email.isStarred) {
      genuineInbound.push(email);
      continue;
    }
    // Skip AI check for emails already caught by heuristic filter
    if (isMarketingEmail(email)) continue;

    const isGenuine = await classifyEmailWithAI(email);
    if (isGenuine) {
      genuineInbound.push(email);
    } else {
      logCheck(`AI classified as newsletter: ${email.from} — ${email.subject}`);
    }
  }

  const notable = genuineInbound.filter((e) => isNotableEmail(e, knownNames, sentThreadIds));

  if (notable.length > 0) {
    // Cap notifications to avoid spam
    const toNotify = notable.slice(0, MAX_NUDGES_PER_CHECK);
    await writeEmailNudge(toNotify, messageAuthMap);
    logCheck(`${notable.length} notable email(s), nudged ${toNotify.length}`);
  }

  // Check for open threads (sent > 24h ago, no reply yet)
  const openThreads = cursor.sentThreads.filter((t) => {
    if (t.replied) return false;
    const age = now - t.sentAt;
    return age >= OPEN_THREAD_MIN_AGE_MS && age <= OPEN_THREAD_WINDOW_MS;
  });

  // Surface open threads once per hour (check if we recently nudged about them)
  // We use a simple heuristic: only nudge if there are open threads AND
  // it's been at least 6 hours since last check started (avoid spamming)
  if (openThreads.length > 0 && cursor.lastCheckAt > 0) {
    const timeSinceStart = now - cursor.lastCheckAt;
    // Only nudge about open threads every ~6 hours worth of checks
    const sixHours = 6 * 60 * 60 * 1000;
    const checkNumber = Math.floor(now / sixHours);
    const lastCheckNumber = Math.floor(cursor.lastCheckAt / sixHours);
    if (checkNumber > lastCheckNumber) {
      writeOpenThreadsNudge(openThreads);
    }
  }

  // Update cursor
  cursor.lastCheckAt = now;
  cursor.seenMessageIds = [...seenSet];
  saveCursor(cursor);

  if (allNew.length > 0) {
    logCheck(`Check complete: ${allNew.length} new, ${notable.length} notable, ${openThreads.length} open threads`);
  }
}

// ── Poller ────────────────────────────────────────────────────────────────────

function hasGoogleCredentials(): boolean {
  const config = getGoogleOAuthConfig();
  if (!config) return false;
  const accounts = loadAllAccounts();
  return accounts.length > 0;
}

export class EmailCheckPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly hasCredentials: boolean;

  constructor() {
    this.hasCredentials = hasGoogleCredentials();
  }

  start(): void {
    if (!this.hasCredentials) {
      logCheck("No Google credentials found — fast email check disabled");
      return;
    }

    const intervalSec = Math.round(EMAIL_CHECK_INTERVAL_MS / 1000);
    logCheck(`Email check poller starting (every ${intervalSec}s)`);
    // First run after 5 minutes (let other systems initialize, stagger after Google ingest at 3min)
    setTimeout(() => void this.poll(), 5 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), EMAIL_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      await checkNewEmails();
    } catch (err) {
      logCheck(`ERROR in email check: ${err}`);
    }
  }
}
