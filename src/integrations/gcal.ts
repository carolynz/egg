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

// ── Fetch events for a single account ────────────────────────────────────────

async function fetchCalendarEvents(
  auth: OAuth2Client,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const cal = google.calendar({ version: "v3", auth });

  // List all calendars the user has access to
  const calListRes = await cal.calendarList.list();
  const calendars = calListRes.data.items ?? [];

  const allEvents: CalendarEvent[] = [];

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

function writeCalendarData(account: string, events: CalendarEvent[]): void {
  const dir = getCalendarDir();
  const accountDir = join(dir, account.replace(/@/g, "_at_").replace(/\./g, "_"));
  mkdirSync(accountDir, { recursive: true });

  const byDate = groupByDate(events);
  const sortedDates = [...byDate.keys()].sort();

  for (const date of sortedDates) {
    const dayEvents = byDate.get(date)!;
    const dayFile: CalendarDayFile = {
      date,
      account,
      events: dayEvents,
    };
    writeFileSync(join(accountDir, `${date}.json`), JSON.stringify(dayFile, null, 2));
  }

  // Write a summary index
  const summary = {
    account,
    dateRange: { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] },
    totalEvents: events.length,
    totalDays: sortedDates.length,
    calendars: [...new Set(events.map((e) => e.calendar))],
    pulledAt: new Date().toISOString(),
  };
  writeFileSync(join(accountDir, "_index.json"), JSON.stringify(summary, null, 2));

  logGoogle(`Calendar: wrote ${events.length} events across ${sortedDates.length} days for ${account}`);
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

  const timeMin = sixMonthsAgo.toISOString();
  const timeMax = now.toISOString();

  logGoogle(`Calendar intake: ${sixMonthsAgo.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}`);

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
