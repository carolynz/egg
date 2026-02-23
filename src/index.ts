#!/usr/bin/env node

import { Command } from "commander";
import { ShellLoop } from "./shell/loop.js";
import { callBrain } from "./brain/index.js";
import { senseDaily, senseImessage } from "./senses/index.js";
import { ouraAuth } from "./integrations/oura.js";
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

// ── oura:auth ──
program
  .command("oura:auth")
  .description("Authorize Egg to access your Oura ring via OAuth2")
  .action(async () => {
    await ouraAuth();
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
