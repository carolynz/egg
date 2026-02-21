import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { EGG_PID_FILE } from "./config.js";

export function acquireLock(): void {
  mkdirSync(dirname(EGG_PID_FILE), { recursive: true });

  if (existsSync(EGG_PID_FILE)) {
    const pidStr = readFileSync(EGG_PID_FILE, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // throws ESRCH if process doesn't exist
        console.error(`egg is already running (pid ${pid}). Run 'pkill -f "egg serve"' to stop it.`);
        process.exit(1);
      } catch {
        // Stale lockfile — process is dead
        console.warn(`Removing stale lockfile (pid ${pid} is not running)`);
        unlinkSync(EGG_PID_FILE);
      }
    } else {
      console.warn(`Removing invalid lockfile`);
      unlinkSync(EGG_PID_FILE);
    }
  }

  writeFileSync(EGG_PID_FILE, String(process.pid), "utf-8");

  // Remove the lockfile on exit. Registering on 'exit' covers all code paths
  // because the SIGINT/SIGTERM handlers in ShellLoop call process.exit(0).
  process.on("exit", () => {
    try {
      if (existsSync(EGG_PID_FILE)) {
        const pidStr = readFileSync(EGG_PID_FILE, "utf-8").trim();
        if (pidStr === String(process.pid)) unlinkSync(EGG_PID_FILE);
      }
    } catch {
      // best-effort
    }
  });
}
