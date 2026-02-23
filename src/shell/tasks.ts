import { execSync, spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { EGG_BRAIN, EGG_MODEL, TASKS_DIR, TASKS_DONE_DIR, getEggCodeDir, getGitHubRepoUrl } from "../config.js";
import { Sender } from "./sender.js";
import { loadState, saveState } from "./state.js";
import { logTaskStart, logTaskEnd } from "../logger.js";

interface RunningTask {
  id: string;
  prompt: string;
  startedAt: Date;
  process: ReturnType<typeof spawn>;
}

export class TaskRunner {
  private sender: Sender;
  private running: Map<string, RunningTask> = new Map();
  private cancelled: Set<string> = new Set();
  private recordHistory: (text: string) => void;

  constructor(sender: Sender, recordHistory: (text: string) => void) {
    this.sender = sender;
    this.recordHistory = recordHistory;
  }

  /**
   * Check tasks/ for new task files, spawn Claude Code for each.
   * Called every poll cycle.
   */
  async checkForTasks(): Promise<void> {
    if (!existsSync(TASKS_DIR)) return;

    const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return;

    console.log(`[task] found ${files.length} pending task file(s): ${files.join(", ")}`);

    for (const file of files) {
      const id = file.replace(/\.md$/, "");
      if (this.running.has(id)) continue;

      const filePath = join(TASKS_DIR, file);
      const prompt = readFileSync(filePath, "utf-8").trim();
      if (!prompt) continue;

      await this.startTask(id, prompt, filePath);
    }
  }

  private async startTask(id: string, prompt: string, filePath: string): Promise<void> {
    let codeDir: string;
    try {
      codeDir = getEggCodeDir();
    } catch (err) {
      console.error("Cannot run task:", err);
      await this.sender.send(`❌ can't run task — EGG_CODE_DIR not set in .env`);
      // Move to done with error
      this.moveToDown(id, prompt, 1, "EGG_CODE_DIR not configured");
      return;
    }

    const preview = prompt.slice(0, 200);
    console.log(`[task] spawning cc for task ${id}`);
    console.log(`Starting task ${id}: ${preview}`);
    logTaskStart(`${id}.md`);

    // Ack to user
    const ack = `🔧 on it. task ${id}\n${preview}`;
    await this.sender.send(ack);
    this.recordHistory(ack);

    // Build the full prompt with build/test instructions
    const fullPrompt = [
      prompt,
      "",
      "After making changes:",
      "1. Run `npm run build` to compile",
      "2. Verify with `npx tsc --noEmit`",
      "3. If either fails, fix the errors before finishing",
    ].join("\n");

    const args = ["-p", fullPrompt, "--dangerously-skip-permissions", "--output-format", "text", "--model", EGG_MODEL];

    const child = spawn(EGG_BRAIN, args, {
      cwd: codeDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    });

    const task: RunningTask = { id, prompt, startedAt: new Date(), process: child };
    this.running.set(id, task);

    // Remove the pending task file now that we've started
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(filePath);
    } catch {}

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (d: Buffer) => stdout.push(d));
    child.stderr!.on("data", (d: Buffer) => stderr.push(d));

    child.on("close", async (code) => {
      this.running.delete(id);
      const duration = Math.round((Date.now() - task.startedAt.getTime()) / 1000);
      const output = Buffer.concat(stdout).toString("utf-8").trim();
      const errors = Buffer.concat(stderr).toString("utf-8").trim();

      logTaskEnd(`${id}.md`, code, duration);

      if (this.cancelled.has(id)) {
        this.cancelled.delete(id);
        console.log(`[task] ${id} cancelled after ${duration}s`);
        this.moveToDown(id, prompt, -1, "cancelled by user", duration);
        return;
      }

      const summary = this.summarize(output || errors);
      this.moveToDown(id, prompt, code ?? 1, summary, duration);

      if (code === 0) {
        console.log(`[task] ${id} completed in ${duration}s`);
        let msg = `✅ task ${id} done (${duration}s)\n${summary}`;

        // Append commit link if we can detect the repo and latest commit
        try {
          const hash = execSync("git rev-parse HEAD", {
            cwd: getEggCodeDir(),
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
          }).toString().trim();
          const repoUrl = getGitHubRepoUrl();
          if (repoUrl && hash) {
            msg += `\n🔗 ${repoUrl}/commit/${hash}`;
          }
        } catch {}

        msg += "\nrestarting...";
        await this.sender.send(msg);
        this.recordHistory(msg);
        // Give message time to send, then restart
        setTimeout(() => this.restart(), 1000);
      } else {
        console.error(`[task] ${id} FAILED (exit ${code}) after ${duration}s`);
        const msg = `❌ task ${id} failed (exit ${code}, ${duration}s)\n${summary}`;
        await this.sender.send(msg);
        this.recordHistory(msg);
      }
    });
  }

  private summarize(output: string): string {
    if (output.length <= 500) return output;
    // Take last 400 chars — most relevant part of output
    return "..." + output.slice(-400);
  }

  private moveToDown(
    id: string,
    prompt: string,
    exitCode: number,
    result: string,
    durationSec?: number,
  ): void {
    mkdirSync(TASKS_DONE_DIR, { recursive: true });
    const now = new Date().toISOString();
    const content = [
      `# Task ${id}`,
      "",
      `**status:** ${exitCode === 0 ? "completed" : "failed"}`,
      `**completed:** ${now}`,
      durationSec != null ? `**duration:** ${durationSec}s` : "",
      `**exit_code:** ${exitCode}`,
      "",
      "## Prompt",
      "",
      prompt,
      "",
      "## Result",
      "",
      result,
    ]
      .filter(Boolean)
      .join("\n");

    writeFileSync(join(TASKS_DONE_DIR, `${id}.md`), content);
  }

  private restart(): void {
    console.log("Restarting egg serve...");
    const state = loadState();
    state.restarting = true;
    saveState(state);

    // Kill any other egg serve processes to prevent duplicates
    try {
      execSync(`pkill -f 'egg serve' || true`, { stdio: "ignore" });
    } catch {}

    const child = spawn(process.argv[0], process.argv.slice(1), {
      stdio: "inherit",
      detached: true,
    });
    child.unref();
    process.exit(0);
  }

  /**
   * Cancel all running tasks. Sends SIGTERM, then SIGKILL after 3s if still alive.
   * Sends a cancellation ack message to the user.
   */
  async cancelAll(): Promise<void> {
    if (this.running.size === 0) return;

    const ids = [...this.running.keys()];
    for (const id of ids) {
      const task = this.running.get(id)!;
      console.log(`[task] cancelling task ${id} (pid ${task.process.pid})`);
      this.cancelled.add(id);
      task.process.kill("SIGTERM");
      // Escalate to SIGKILL if still alive after 3s
      const pid = task.process.pid;
      if (pid !== undefined) {
        setTimeout(() => {
          if (this.running.has(id)) {
            console.log(`[task] SIGKILL task ${id} (pid ${pid})`);
            try { process.kill(pid, "SIGKILL"); } catch {}
          }
        }, 3000);
      }
    }

    const label = ids.length === 1 ? `task ${ids[0]}` : `tasks ${ids.join(", ")}`;
    const msg = `🛑 cancelled ${label}`;
    await this.sender.send(msg);
    this.recordHistory(msg);
  }

  get hasRunningTasks(): boolean {
    return this.running.size > 0;
  }

  get runningTaskSummaries(): { id: string; prompt: string; startedAt: Date }[] {
    return [...this.running.values()].map((t) => ({
      id: t.id,
      prompt: t.prompt,
      startedAt: t.startedAt,
    }));
  }
}
