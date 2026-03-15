import { execSync } from "child_process";
import { getEggAppleId, getEggUserPhone } from "../config.js";

function escapeAppleScript(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function sendFileAsEgg(filepath: string): boolean {
  const appleId = getEggAppleId();
  const userPhone = getEggUserPhone();
  if (!appleId) {
    console.error("EGG_APPLE_ID not set — cannot send file as Egg");
    return false;
  }

  const script = `
    tell application "Messages"
      set eggAccount to 1st account whose service type = iMessage and description contains ${escapeAppleScript(appleId)}
      set targetBuddy to participant ${escapeAppleScript(userPhone)} of eggAccount
      send POSIX file ${escapeAppleScript(filepath)} to targetBuddy
    end tell
  `;

  try {
    execSync("osascript -e " + JSON.stringify(script), {
      timeout: 30_000,
      stdio: "pipe",
    });
    return true;
  } catch (err) {
    console.error("AppleScript sendFile failed:", err);
    return false;
  }
}

export function sendToPhone(phone: string, body: string): boolean {
  const appleId = getEggAppleId();
  if (!appleId) {
    console.error("EGG_APPLE_ID not set — cannot send to phone");
    return false;
  }

  const script = `
    tell application "Messages"
      set eggAccount to 1st account whose service type = iMessage and description contains ${escapeAppleScript(appleId)}
      set targetBuddy to participant ${escapeAppleScript(phone)} of eggAccount
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
    console.error("AppleScript sendToPhone failed:", err);
    return false;
  }
}

export function sendAsEgg(body: string): boolean {
  const appleId = getEggAppleId();
  const userPhone = getEggUserPhone();
  if (!appleId) {
    console.error("EGG_APPLE_ID not set — cannot send as Egg");
    return false;
  }

  const script = `
    tell application "Messages"
      set eggAccount to 1st account whose service type = iMessage and description contains ${escapeAppleScript(appleId)}
      set targetBuddy to participant ${escapeAppleScript(userPhone)} of eggAccount
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
