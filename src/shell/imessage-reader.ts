import Database from "better-sqlite3";
import { existsSync } from "fs";
import { CHAT_DB, EGG_APPLE_ID } from "../config.js";

const LOOKBACK_ROWS = 10;

const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g;
const EMAIL_RE = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;

export interface Message {
  text: string;
  isFromMe: boolean;
  time: string;
  rowid: number;
  guid: string;
  sender: string;
  reactionType: number | null;
  reactionTarget: string | null;
}

function scrubText(text: string): string {
  return text.replace(PHONE_RE, "[PHONE]").replace(EMAIL_RE, "[EMAIL]");
}

function decodeAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;
  try {
    const markers = [Buffer.from([0x2b, 0x00]), Buffer.from([0x2a, 0x00])];
    for (const marker of markers) {
      const idx = blob.indexOf(marker);
      if (idx === -1) continue;
      const start = idx + marker.length;
      const candidate = blob.subarray(start);
      const endMarkers = [Buffer.from([0x86, 0x84]), Buffer.from([0x00, 0x00, 0x00])];
      let textBytes = candidate;
      for (const em of endMarkers) {
        const endIdx = candidate.indexOf(em);
        if (endIdx > 0) {
          textBytes = candidate.subarray(0, endIdx);
          break;
        }
      }
      const decoded = textBytes.toString("utf-8").trim();
      if (decoded.length > 0) return decoded;
    }
    // Fallback: find longest printable segment
    const decoded = blob.toString("utf-8");
    const segments = decoded.match(/[\x20-\x7e\u00a0-\uffff]{10,}/g);
    if (segments) {
      return segments.reduce((a, b) => (a.length >= b.length ? a : b)).trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function getEggMessages(
  sinceRowid: number,
  seenRowids: Set<number>,
): { messages: Message[]; maxRowid: number } {
  if (!EGG_APPLE_ID) return { messages: [], maxRowid: sinceRowid };
  if (!existsSync(CHAT_DB)) return { messages: [], maxRowid: sinceRowid };

  const querySince = Math.max(0, sinceRowid - LOOKBACK_ROWS);

  try {
    const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");

    const rows = db
      .prepare(
        `SELECT
          m.ROWID,
          m.text,
          m.attributedBody,
          m.is_from_me,
          m.date / 1000000000 + 978307200 as unix_timestamp,
          m.guid,
          h.id as sender_handle,
          m.associated_message_type,
          m.associated_message_guid
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > ?
          AND m.account LIKE ?
        ORDER BY m.date ASC
        LIMIT 100`,
      )
      .all(querySince, `%${EGG_APPLE_ID}%`) as Array<{
      ROWID: number;
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      unix_timestamp: number;
      guid: string | null;
      sender_handle: string | null;
      associated_message_type: number | null;
      associated_message_guid: string | null;
    }>;

    const messages: Message[] = [];
    let maxRowid = sinceRowid;

    for (const row of rows) {
      maxRowid = Math.max(maxRowid, row.ROWID);

      if (seenRowids.has(row.ROWID)) continue;

      let text = row.text;
      if (!text && row.attributedBody) {
        text = decodeAttributedBody(row.attributedBody);
      }
      if (!text) continue;

      text = scrubText(text);
      if (text.startsWith("__kIM")) continue;

      const ts = row.unix_timestamp;
      const time = ts
        ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")
        : "unknown";

      const assocType = row.associated_message_type ?? 0;
      const assocGuid = row.associated_message_guid ?? "";
      let reactionType: number | null = null;
      let reactionTarget: string | null = null;
      if (assocType !== 0) {
        reactionType = assocType;
        reactionTarget = assocGuid.includes("/")
          ? assocGuid.split("/", 2)[1]
          : assocGuid;
      }

      messages.push({
        text,
        isFromMe: Boolean(row.is_from_me),
        time,
        rowid: row.ROWID,
        guid: row.guid ?? "",
        sender: row.sender_handle ?? "",
        reactionType,
        reactionTarget,
      });
    }

    db.close();
    return { messages, maxRowid };
  } catch (err) {
    console.error("Failed to read Egg conversation from chat.db:", err);
    return { messages: [], maxRowid: sinceRowid };
  }
}
