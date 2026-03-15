import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
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

interface CalendarEvent {
  id: string;
  title: string;
  start: string;       // ISO datetime or date
  end: string;         // ISO datetime or date
  allDay: boolean;
  location: string | null;
  description: string | null;
  attendees: string[];  // email addresses
  calendar: string;     // calendar name
  status: string;       // confirmed, tentative, cancelled
}

interface CalendarDayFile {
  date: string;         // YYYY-MM-DD
  account: string;      // email
  events: CalendarEvent[];
}

// ── Output directory ─────────────────────────────────────────────────────────

function getCalendarDir(): string {
  return join(EGG_MEMORY_DIR, "data", "calendar");
}

// ── Calendar list cache ─────────────────────────────────────────────────────

// Calendars to skip — not used by the user
const SKIPPED_CALENDARS = new Set(["RC Calendar"]);

interface CachedCalendarList {
  items: Array<{ id?: string | null; summary?: string | null }>;
  fetchedAt: number;
}

const calendarListCache = new Map<string, CachedCalendarList>();
const CALENDAR_LIST_CACHE_MS = 60 * 60 * 1000; // 1 hour

// ── Fetch events for a single account ────────────────────────────────────────

async function fetchCalendarEvents(
  auth: OAuth2Client,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const cal = google.calendar({ version: "v3", auth });

  // Use cached calendar list if available and fresh (< 1 hour old)
  const cacheKey = `${auth.credentials.access_token ?? "default"}`;
  const cached = calendarListCache.get(cacheKey);
  let calendars: Array<{ id?: string | null; summary?: string | null }>;

  if (cached && Date.now() - cached.fetchedAt < CALENDAR_LIST_CACHE_MS) {
    calendars = cached.items;
    logGoogle("Calendar list: using cached result");
  } else {
    const calListRes = await cal.calendarList.list({
      showHidden: true,
      minAccessRole: "reader",
    });
    calendars = calListRes.data.items ?? [];
    calendarListCache.set(cacheKey, { items: calendars, fetchedAt: Date.now() });
    logGoogle(`Calendar list: fetched ${calendars.length} calendars (cached for 1h)`);
  }

  const allEvents: CalendarEvent[] = [];

  for (const calEntry of calendars) {
    const calId = calEntry.id;
    const calName = calEntry.summary ?? calId ?? "Unknown";
    if (!calId) continue;

    // Skip calendars the user doesn't use
    if (SKIPPED_CALENDARS.has(calName)) {
      logGoogle(`Calendar: skipping "${calName}"`);
      continue;
    }

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
        const allDay = !ev.start?.dateTime;

        allEvents.push({
          id: ev.id ?? "",
          title: ev.summary ?? "(no title)",
          start,
          end,
          allDay,
          location: ev.location ?? null,
          description: ev.description ? ev.description.slice(0, 500) : null,
          attendees: (ev.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
          calendar: calName,
          status: ev.status ?? "confirmed",
        });
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return allEvents;
}

// ── Group events by date ─────────────────────────────────────────────────────

function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    // Extract date from ISO datetime or date string
    const date = ev.start.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(ev);
  }
  return byDate;
}

// ── Write calendar data to egg-memory ────────────────────────────────────────

function mergeEvents(
  existing: CalendarEvent[],
  incoming: CalendarEvent[],
  date: string,
  account: string,
): CalendarEvent[] {
  const incomingById = new Map(incoming.map((e) => [e.id, e]));
  const merged = new Map<string, CalendarEvent>();

  // Start with existing events — keep unless explicitly cancelled in API response
  for (const ev of existing) {
    const fresh = incomingById.get(ev.id);
    if (fresh) {
      // API returned this event — use the updated version
      if (fresh.status === "cancelled") {
        logGoogle(`Calendar [${account}] ${date}: removed cancelled event "${ev.title}" (${ev.id})`);
      } else {
        merged.set(ev.id, fresh);
      }
      incomingById.delete(ev.id);
    } else {
      // API didn't return this event — keep it (may be a transient omission)
      merged.set(ev.id, ev);
    }
  }

  // Add any new events not previously seen
  for (const [id, ev] of incomingById) {
    if (ev.status === "cancelled") continue;
    merged.set(id, ev);
    logGoogle(`Calendar [${account}] ${date}: added event "${ev.title}" (${ev.id})`);
  }

  return [...merged.values()];
}

function writeCalendarData(account: string, events: CalendarEvent[]): void {
  const dir = getCalendarDir();
  const accountDir = join(dir, account.replace(/@/g, "_at_").replace(/\./g, "_"));
  mkdirSync(accountDir, { recursive: true });

  const byDate = groupByDate(events);
  const sortedDates = [...byDate.keys()].sort();

  // Also load dates from existing files that may not appear in the current API response
  const allDates = new Set(sortedDates);

  for (const date of sortedDates) {
    const filePath = join(accountDir, `${date}.json`);
    const incoming = byDate.get(date)!;

    // Load existing events for this date
    let existing: CalendarEvent[] = [];
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8")) as CalendarDayFile;
        existing = raw.events;
      } catch {
        // Corrupted file — overwrite with incoming data
      }
    }

    const merged = mergeEvents(existing, incoming, date, account);
    const dayFile: CalendarDayFile = {
      date,
      account,
      events: merged,
    };
    writeFileSync(filePath, JSON.stringify(dayFile, null, 2));
    allDates.add(date);
  }

  const finalDates = [...allDates].sort();

  // Write a summary index
  const summary = {
    account,
    dateRange: { from: finalDates[0], to: finalDates[finalDates.length - 1] },
    totalEvents: events.length,
    totalDays: finalDates.length,
    calendars: [...new Set(events.map((e) => e.calendar))],
    pulledAt: new Date().toISOString(),
  };
  writeFileSync(join(accountDir, "_index.json"), JSON.stringify(summary, null, 2));

  logGoogle(`Calendar: wrote ${events.length} events across ${finalDates.length} days for ${account}`);
}

// ── Main intake function ─────────────────────────────────────────────────────

export async function intakeCalendar(): Promise<void> {
  const config = getGoogleOAuthConfig();
  if (!config) {
    console.error("[gcal] No Google OAuth config found. Run `egg google:auth` first.");
    process.exit(1);
  }

  const accounts = loadAllAccounts();
  if (accounts.length === 0) {
    console.error("[gcal] No Google accounts configured. Run `egg google:auth` first.");
    process.exit(1);
  }

  // 6 months back from now
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const fourteenDaysFromNow = new Date(now);
  fourteenDaysFromNow.setDate(fourteenDaysFromNow.getDate() + 14);

  const timeMin = sixMonthsAgo.toISOString();
  const timeMax = fourteenDaysFromNow.toISOString();

  logGoogle(`Calendar intake: ${sixMonthsAgo.toISOString().slice(0, 10)} → ${fourteenDaysFromNow.toISOString().slice(0, 10)}`);

  for (const account of accounts) {
    logGoogle(`Fetching calendar events for ${account.email}...`);
    try {
      const client = await getAuthedClient(config, account);
      const events = await fetchCalendarEvents(client, timeMin, timeMax);
      logGoogle(`Fetched ${events.length} events for ${account.email}`);
      writeCalendarData(account.email, events);
    } catch (err) {
      logGoogle(`ERROR fetching calendar for ${account.email}: ${err}`);
      console.error(`[gcal] Failed for ${account.email}:`, err);
    }
  }

  logGoogle("Calendar intake complete.");
}
