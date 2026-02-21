import { execSync } from "child_process";
import { EGG_APPLE_ID, EGG_USER_PHONE } from "../config.js";

function escapeAppleScript(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function sendAsEgg(body: string): boolean {
  if (!EGG_APPLE_ID) {
    console.error("EGG_APPLE_ID not set — cannot send as Egg");
    return false;
  }

  const script = `
    tell application "Messages"
      set eggAccount to 1st account whose service type = iMessage and description contains ${escapeAppleScript(EGG_APPLE_ID)}
      set targetBuddy to participant ${escapeAppleScript(EGG_USER_PHONE)} of eggAccount
      send ${escapeAppleScript(body)} to targetBuddy
    end tell
  `;

  try {
    execSync("osascript -e " + JSON.stringify(script), {
      timeout: 30_000,
      stdio: "pipe",
    });
    return true;
  } catch (err) {
    console.error("AppleScript send failed:", err);
    return false;
  }
}
