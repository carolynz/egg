import { config } from "dotenv";
import { join } from "path";
import { homedir } from "os";

// Load .env from EGG_MEMORY_DIR if set, otherwise cwd
const memDir = process.env.EGG_MEMORY_DIR;
if (memDir) config({ path: join(memDir, ".env") });
else config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const EGG_APPLE_ID = required("EGG_APPLE_ID");
export const EGG_USER_PHONE = required("EGG_USER_PHONE");
export const BLUEBUBBLES_URL = process.env.BLUEBUBBLES_URL?.replace(/\/+$/, "") ?? "";
export const BLUEBUBBLES_PASSWORD = process.env.BLUEBUBBLES_PASSWORD ?? "";
export const EGG_MEMORY_DIR = required("EGG_MEMORY_DIR");
export const EGG_BRAIN = process.env.EGG_BRAIN ?? "claude";
export const CHAT_DB = process.env.CHAT_DB ?? join(homedir(), "Library", "Messages", "chat.db");

// Derived paths (all relative to EGG_MEMORY_DIR)
export const SOUL_PATH = join(EGG_MEMORY_DIR, "SOUL.md");
export const MEMORY_PATH = join(EGG_MEMORY_DIR, "MEMORY.md");
export const STATE_FILE = join(EGG_MEMORY_DIR, ".egg-state.json");
export const NUDGES_DIR = join(EGG_MEMORY_DIR, "nudges");
export const NUDGES_SENT_DIR = join(EGG_MEMORY_DIR, "nudges", "sent");

// Quiet hours for nudges
export const QUIET_START = 23;
export const QUIET_END = 8;
