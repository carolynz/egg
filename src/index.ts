#!/usr/bin/env node

import { Command } from "commander";
import { ShellLoop } from "./shell/loop.js";
import { callBrain } from "./brain/index.js";
import { senseDaily, senseImessage, generateTodayMd } from "./senses/index.js";
import { runOnboard } from "./commands/onboard.js";
import { ouraAuth } from "./integrations/oura.js";
import { googleAuth } from "./integrations/google.js";
import { intakeCalendar, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./integrations/gcal.js";
import { intakeGmail } from "./integrations/gmail.js";
import { intakeMercury } from "./integrations/mercury.js";
import { pushDashboard } from "./commands/push-dashboard.js";
import {
  EGG_MEMORY_DIR,
  NUDGES_DIR,
  NUDGES_SENT_DIR,
  QUIET_START,
  QUIET_END,
  checkMemoryDir,
} from "./config.js";
import { Sender } from "./shell/sender.js";
import { BlueBubblesClient } from "./shell/bluebubbles.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { initLogFiles, BRAIN_LOG, TASKS_LOG } from "./logger.js";
import { acquireLock } from "./lockfile.js";

function tailLogFiles(): void {
  initLogFiles();
  for (const logPath of [BRAIN_LOG, TASKS_LOG]) {
    const label = logPath.endsWith("brain.log") ? "brain" : "tasks";
    const tail = spawn("tail", ["-F", logPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    tail.stdout!.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        process.stdout.write(`[log:${label}] ${line}\n`);
      }
    });
    tail.unref();
  }
}

process.on("unhandledRejection", (reason, _promise) => {
  console.error("[egg] Unhandled Promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[egg] Uncaught exception:", error);
});

const program = new Command();

program.name("egg").description("Egg — your bold personal AI agent").version("0.1.0");

// ── serve ──
program
  .command("serve")
  .description("Start the iMessage poll loop")
  .option("--bb-only", "Only use BlueBubbles for sending (no AppleScript fallback)")
  .action(async (opts: { bbOnly?: boolean }) => {
    acquireLock();
    checkMemoryDir();
    tailLogFiles();
    const loop = new ShellLoop(opts.bbOnly ?? false);
    await loop.init();
    await loop.run();
  });

// ── nudge ──
program
  .command("nudge")
  .description("Ask the brain if a nudge is warranted right now")
  .option("--dry-run", "Print brain output without writing a nudge file")
  .action(async (opts: { dryRun?: boolean }) => {
    checkMemoryDir();
    // Quiet hours check
    const hour = new Date().getHours();
    if (hour >= QUIET_START || hour < QUIET_END) {
      console.log(`Quiet hours (${QUIET_START}:00–${QUIET_END}:00) — skipping nudge`);
      return;
    }

    const prompt = [
      "Review goals.yaml, MEMORY.md, and recent daily/ digests.",
      "If a nudge is appropriate right now, write it to nudges/<timestamp>.md where <timestamp> is the current ISO timestamp.",
      "The file should contain only the nudge text (one line per text message).",
      "If no nudge is warranted, do nothing.",
    ].join("\n");

    if (opts.dryRun) {
      console.log("Dry run — brain prompt:");
      console.log(prompt);
      const reply = await callBrain({ history: [], message: prompt });
      console.log("\nBrain output:");
      console.log(reply);
      return;
    }

    // Skip if nudges are already queued — prevents duplicate delivery from frequent cron runs
    if (existsSync(NUDGES_DIR)) {
      const pending = readdirSync(NUDGES_DIR).filter((f) => f.endsWith(".md"));
      if (pending.length > 0) {
        console.log(`${pending.length} pending nudge(s) already queued — skipping`);
        return;
      }
    }

    await callBrain({ history: [], message: prompt });
    console.log("Nudge cycle complete — check nudges/ for any new files");
  });

// ── deliver-nudges ──
// (Called from within serve loop, but also available as standalone)
async function deliverNudges(sender: Sender): Promise<void> {
  if (!existsSync(NUDGES_DIR)) return;

  const files = readdirSync(NUDGES_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return;

  mkdirSync(NUDGES_SENT_DIR, { recursive: true });

  for (const file of files) {
    const filePath = join(NUDGES_DIR, file);
    const text = readFileSync(filePath, "utf-8").trim();
    if (!text) continue;

    console.log(`Delivering nudge: ${file}`);
    const chunks = text.split("\n").filter(Boolean);
    for (const chunk of chunks) {
      await sender.send(chunk);
    }

    renameSync(filePath, join(NUDGES_SENT_DIR, file));
  }
}

// ── intake ──
const intake = program.command("intake").description("Run data intake");

intake
  .command("imessage")
  .description("Process iMessage history — create/update dossiers and MEMORY.md, then commit and push")
  .action(async () => {
    checkMemoryDir();
    await senseImessage();
  });

intake
  .command("daily")
  .description("Generate a daily context digest")
  .action(async () => {
    checkMemoryDir();
    await senseDaily();
  });

intake
  .command("today")
  .description("Generate today.md — structured daily plan from calendar, goals, backlog, and emails")
  .action(async () => {
    checkMemoryDir();
    await generateTodayMd();
    console.log("today.md generated successfully");
  });

// ── oura:auth ──
program
  .command("oura:auth")
  .description("Authorize Egg to access your Oura ring via OAuth2")
  .action(async () => {
    await ouraAuth();
  });

// ── google:auth ──
program
  .command("google:auth")
  .description("Authorize a Google account (Gmail + Calendar) via OAuth2")
  .action(async () => {
    await googleAuth();
  });

// ── intake gcal ──
intake
  .command("gcal")
  .description("Pull 6 months of Google Calendar events into egg-memory")
  .action(async () => {
    await intakeCalendar();
  });

// ── intake gmail ──
intake
  .command("gmail")
  .description("Pull 6 months of Gmail metadata into egg-memory")
  .action(async () => {
    await intakeGmail();
  });

// ── calendar:create ──
program
  .command("calendar:create")
  .description("Create a Google Calendar event")
  .requiredOption("--title <title>", "Event title")
  .requiredOption("--start <datetime>", "Start time (ISO datetime)")
  .requiredOption("--end <datetime>", "End time (ISO datetime)")
  .option("--account <email>", "Google account email", process.env.EGG_GOOGLE_ACCOUNT)
  .option("--calendar <id>", "Calendar ID", "primary")
  .option("--location <location>", "Event location")
  .option("--description <description>", "Event description")
  .action(async (opts: {
    title: string;
    start: string;
    end: string;
    account: string;
    calendar: string;
    location?: string;
    description?: string;
  }) => {
    try {
      const result = await createCalendarEvent(opts.account, opts.calendar, {
        title: opts.title,
        start: opts.start,
        end: opts.end,
        location: opts.location,
        description: opts.description,
      });
      console.log(`Event created: ${result.eventId}`);
      console.log(`Link: ${result.link}`);
    } catch (err) {
      console.error("[calendar:create] Failed:", err);
      process.exit(1);
    }
  });

// ── calendar:update ──
program
  .command("calendar:update")
  .description("Update/move a Google Calendar event")
  .requiredOption("--event-id <id>", "Event ID to update")
  .option("--title <title>", "New event title")
  .option("--start <datetime>", "New start time (ISO datetime)")
  .option("--end <datetime>", "New end time (ISO datetime)")
  .option("--account <email>", "Google account email", process.env.EGG_GOOGLE_ACCOUNT)
  .option("--calendar <id>", "Calendar ID", "primary")
  .option("--location <location>", "New event location")
  .option("--description <description>", "New event description")
  .action(async (opts: {
    eventId: string;
    title?: string;
    start?: string;
    end?: string;
    account: string;
    calendar: string;
    location?: string;
    description?: string;
  }) => {
    try {
      const result = await updateCalendarEvent(opts.account, opts.eventId, opts.calendar, {
        title: opts.title,
        start: opts.start,
        end: opts.end,
        location: opts.location,
        description: opts.description,
      });
      console.log(`Event updated: ${result.eventId}`);
      console.log(`Link: ${result.link}`);
    } catch (err) {
      console.error("[calendar:update] Failed:", err);
      process.exit(1);
    }
  });

// ── calendar:delete ──
program
  .command("calendar:delete")
  .description("Delete a Google Calendar event")
  .requiredOption("--event-id <id>", "Event ID to delete")
  .option("--account <email>", "Google account email", process.env.EGG_GOOGLE_ACCOUNT)
  .option("--calendar <id>", "Calendar ID", "primary")
  .action(async (opts: {
    eventId: string;
    account: string;
    calendar: string;
  }) => {
    try {
      await deleteCalendarEvent(opts.account, opts.eventId, opts.calendar);
      console.log(`Event deleted: ${opts.eventId}`);
    } catch (err) {
      console.error("[calendar:delete] Failed:", err);
      process.exit(1);
    }
  });

// ── intake mercury ──
intake
  .command("mercury")
  .description("Pull Mercury bank account balances and recent transactions")
  .action(async () => {
    await intakeMercury();
  });

// ── push ──
const push = program.command("push").description("Push data to external services");

push
  .command("dashboard")
  .description("Push Mercury financial snapshot to the Cloudflare dashboard Worker")
  .action(async () => {
    await pushDashboard();
  });

// ── onboard ──
program
  .command("onboard")
  .description("Onboard Egg by distilling historical data into memory files")
  .option("--source <source>", "Data source: imessage, gmail, gcal, all", "all")
  .option("--period <period>", "Time period: 6m, 1y, 2y, all", "6m")
  .action(async (opts: { source: string; period: string }) => {
    checkMemoryDir();
    const validSources = ["imessage", "gmail", "gcal", "all"];
    const validPeriods = ["6m", "1y", "2y", "all"];
    if (!validSources.includes(opts.source)) {
      console.error(`Invalid source: ${opts.source}. Must be one of: ${validSources.join(", ")}`);
      process.exit(1);
    }
    if (!validPeriods.includes(opts.period)) {
      console.error(`Invalid period: ${opts.period}. Must be one of: ${validPeriods.join(", ")}`);
      process.exit(1);
    }
    await runOnboard(
      opts.source as "imessage" | "gmail" | "gcal" | "all",
      opts.period as "6m" | "1y" | "2y" | "all",
    );
  });

// ── status ──
program
  .command("status")
  .description("Show Egg status")
  .action(() => {
    console.log(`Memory dir: ${EGG_MEMORY_DIR}`);
    console.log(`Chat DB: ${process.env.CHAT_DB ?? "~/Library/Messages/chat.db"}`);

    if (existsSync(NUDGES_DIR)) {
      const pending = readdirSync(NUDGES_DIR).filter((f) => f.endsWith(".md"));
      console.log(`Pending nudges: ${pending.length}`);
    } else {
      console.log("Pending nudges: 0");
    }
  });

program.parse();

export { deliverNudges };
