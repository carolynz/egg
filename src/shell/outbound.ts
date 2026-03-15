import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { EGG_MEMORY_DIR } from "../config.js";
import { BlueBubblesClient } from "./bluebubbles.js";
import { sendToPhone } from "./applescript.js";
import { logOutbound } from "../logger.js";

const CONTACTS_FILE = join(EGG_MEMORY_DIR, "outbound-contacts.json");
const MAX_PER_CONTACT_PER_DAY = 3;

interface OutboundContact {
  name: string;
  phone: string;
}

// In-memory rate limit tracker: contactName → list of send timestamps (epoch ms)
const sendHistory = new Map<string, number[]>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getSendsToday(contactName: string): number {
  const history = sendHistory.get(contactName) ?? [];
  const todayStart = new Date(todayKey()).getTime();
  return history.filter((t) => t >= todayStart).length;
}

function recordSend(contactName: string): void {
  const history = sendHistory.get(contactName) ?? [];
  history.push(Date.now());
  sendHistory.set(contactName, history);
}

function loadContacts(): OutboundContact[] {
  if (!existsSync(CONTACTS_FILE)) {
    console.warn(`[outbound] No contacts file at ${CONTACTS_FILE}`);
    return [];
  }
  try {
    const raw = readFileSync(CONTACTS_FILE, "utf-8");
    const data = JSON.parse(raw) as { contacts?: OutboundContact[] };
    return data.contacts ?? [];
  } catch (err) {
    console.error("[outbound] Failed to load contacts:", err);
    return [];
  }
}

function findContact(nameOrPhone: string): OutboundContact | null {
  const contacts = loadContacts();
  const lower = nameOrPhone.toLowerCase();
  return (
    contacts.find(
      (c) => c.name.toLowerCase() === lower || c.phone === nameOrPhone,
    ) ?? null
  );
}

/**
 * Send an iMessage to an approved contact.
 * Returns true if the message was sent successfully.
 */
export async function sendOutboundMessage(
  contactName: string,
  message: string,
  bb: BlueBubblesClient,
  bbOnly: boolean,
): Promise<boolean> {
  // 1. Resolve contact from whitelist
  const contact = findContact(contactName);
  if (!contact) {
    console.error(
      `[outbound] Contact "${contactName}" not found in approved whitelist`,
    );
    logOutbound(contactName, message, false);
    return false;
  }

  // 2. Rate limit check
  const sendsToday = getSendsToday(contact.name);
  if (sendsToday >= MAX_PER_CONTACT_PER_DAY) {
    console.warn(
      `[outbound] Rate limit reached for ${contact.name}: ${sendsToday}/${MAX_PER_CONTACT_PER_DAY} today`,
    );
    logOutbound(contact.name, `RATE_LIMITED: ${message}`, false);
    return false;
  }

  // 3. Send via BlueBubbles first, fall back to AppleScript
  let sent = await bb.sendTextTo(contact.phone, message);
  if (!sent && !bbOnly && !bb.available) {
    sent = sendToPhone(contact.phone, message);
  }

  // 4. Log and track
  logOutbound(contact.name, message, sent);
  if (sent) {
    recordSend(contact.name);
    console.log(`[outbound] Sent message to ${contact.name}`);
  } else {
    console.error(`[outbound] Failed to send message to ${contact.name}`);
  }

  return sent;
}
