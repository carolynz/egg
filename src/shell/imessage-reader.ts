import Database from "better-sqlite3";
import { existsSync } from "fs";
import { homedir } from "os";
import { CHAT_DB, getEggAppleId } from "../config.js";

const LOOKBACK_ROWS = 10;

const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g;
const EMAIL_RE = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
// Matches Objective-C class names (NS*) and NSArchiver/NSKeyedArchiver binary
// serialization headers: "streamtyped" (NSArchiver), "typedstream" (NSTypedStream),
// "bplist" (binary plist used by NSKeyedArchiver).
// No \b word boundary — bplist type-byte markers (X, W, T, Z) are ASCII letters and
// immediately precede NS class names (e.g. "XNSObject"), so a word boundary never fires.
const NS_CLASS_RE = /NS[A-Z]\w*|streamtyped|typedstream|bplist\S*/g;

// Magic bytes for NSKeyedArchiver binary plist: ASCII "bplist00"
const BPLIST_MAGIC = Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]);

// NSKeyedArchiver structural keys — present in every NSKeyedArchiver serialization.
// These strings never appear in legitimate user messages.
const NSKEYEDARCHIVER_KEY_RE = /\$classname|\$classes|\$archiver|\$objects|\$version/;

// bplist binary indicators: type-byte-prefixed NS class names and structural keys that
// appear as ASCII substrings in NSDate/NSValue blobs.
// Pattern: bplist integer/string type byte ('Z', 'X', 'W', 'T') immediately before a
// well-known NSKeyedArchiver key or Apple class name.
// These never appear in legitimate user messages.
const BPLIST_BINARY_RE = /Z\$classname|XNSObject|XNSDate|XNSValue|WNSValue|WNSDate/;

// Apple Data Detector metadata strings embedded in attributedBody blobs when iMessage
// applies smart formatting (weights, dates, addresses, flight numbers, etc.).
// These are DDScannerResult/PhysicalAmount/etc. class names from the embedded bplist
// inside __kIMDataDetectedAttributeName attributes.  They never appear in user text.
const DATA_DETECTOR_RE = /DDScanner|PhysicalAmount|FractionalValue|IntegralValue|dd-result|NS\.rangeval|NS\.special/;

function hasNSClassArtifacts(text: string): boolean {
  // No \b — bplist type bytes are letters and directly precede NS class names
  return /NS[A-Z]\w*|streamtyped|typedstream|bplist\S*/.test(text);
}

/**
 * Try to extract human-readable text from a string that contains
 * NSKeyedArchiver/bplist binary data decoded as UTF-8.
 * The actual user message text is stored as a string object inside the plist
 * and appears as the longest printable segment after filtering out structural keys.
 * Returns the extracted text, or null if no readable content found.
 */
function extractTextFromBplist(raw: string): string | null {
  // Find all printable segments (min 4 chars to skip type bytes and short structural keys)
  const segments = raw.match(/[\x20-\x7e\u00a0-\uffff]{4,}/g);
  if (!segments) return null;

  // Filter out NSKeyedArchiver structural keys and class names
  const clean = segments.filter(
    (s) =>
      !NSKEYEDARCHIVER_KEY_RE.test(s) &&
      !BPLIST_BINARY_RE.test(s) &&
      !hasNSClassArtifacts(s) &&
      !DATA_DETECTOR_RE.test(s) &&
      !s.includes("__kIM") &&
      !/^bplist\d+/.test(s) &&
      !/^\$\w+$/.test(s),
  );

  if (clean.length === 0) return null;

  // Return the longest clean segment — most likely the actual message text
  const best = clean.reduce((a, b) => (a.length >= b.length ? a : b)).trim();
  return best.length > 0 ? best : null;
}

/**
 * Detect and handle NSKeyedArchiver binary plist blobs in a text string.
 * iOS sometimes encodes date-like strings (e.g. "@ 12:30", "tomorrow") as NSDate
 * objects serialized as binary plists, which arrive as binary garbage in chat.db text.
 * The actual human-readable text IS embedded in the blob as a string object.
 *
 * Detection paths (any one is sufficient):
 *  1. Text starts with "bplist00" — the binary plist magic header decoded intact.
 *  2. Text contains NSKeyedArchiver structural keys ($classname, $classes, etc.)
 *     even without the magic prefix — this happens when the leading bytes of the
 *     bplist are invalid UTF-8 and get replaced with U+FFFD by SQLite/better-sqlite3.
 *  3. Text contains bplist type-byte-prefixed class names (XNSObject, XNSDate, etc.)
 *     or the Z$classname structural key — these never appear in normal user text.
 *
 * When any indicator is detected, first attempt to extract the readable text from
 * the blob. Return empty string if no readable text can be recovered, so
 * attributedBody can take over.
 */
function stripBplistBlob(text: string): string {
  if (
    text.startsWith("bplist00") ||
    NSKEYEDARCHIVER_KEY_RE.test(text) ||
    BPLIST_BINARY_RE.test(text)
  ) {
    const extracted = extractTextFromBplist(text);
    if (extracted) {
      console.warn("[parse] extracted text from bplist blob:", extracted.slice(0, 80));
      return extracted;
    }
    console.warn("[parse] text field is NSKeyedArchiver/bplist blob — clearing so attributedBody takes over");
    return "";
  }
  return text;
}

export interface Attachment {
  filename: string;
  mimeType: string;
}

export interface Message {
  text: string;
  isFromMe: boolean;
  time: string;
  rowid: number;
  guid: string;
  sender: string;
  reactionType: number | null;
  reactionTarget: string | null;
  attachments?: Attachment[];
}

export interface ThreadMessage {
  text: string;
  isFromMe: boolean;
  time: string;
  rowid: number;
  sender: string;
  chatIdentifier: string;
  displayName: string;
}

function scrubText(text: string): string {
  return text.replace(PHONE_RE, "[PHONE]").replace(EMAIL_RE, "[EMAIL]");
}

function decodeAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;
  try {
    // If the blob is an NSKeyedArchiver binary plist (starts with "bplist00"),
    // try to extract readable text from the binary structure before giving up.
    // iOS encodes messages with data-detected content (e.g. "@ 12:30") as
    // attributed strings serialized via NSKeyedArchiver — the text IS in there.
    if (blob.length >= 8 && blob.subarray(0, 8).equals(BPLIST_MAGIC)) {
      const bplistText = extractTextFromBplist(blob.toString("utf-8"));
      if (bplistText) {
        console.warn("[parse] extracted text from bplist attributedBody:", bplistText.slice(0, 80));
        return bplistText;
      }
      console.warn("[parse] attributedBody is a bplist blob (NSDate?) — skipping");
      return null;
    }

    // Primary: length-prefixed extraction from NSArchiver typedstream.
    // The NSAttributedString's text is stored as a length-prefixed C string
    // after a 0x2b or 0x2a marker byte.  The byte(s) following the marker
    // encode the text length using Apple's compact-int format:
    //   < 0x80        → single-byte length
    //   0x81 NN       → 1-byte extended length
    //   0x82 HH LL    → 2-byte big-endian length
    // Reading exactly `length` bytes extracts the clean text regardless of
    // any data-detector attribute metadata that follows in the blob.
    const CONTENT_MARKERS = [0x2b, 0x2a];
    let bestLengthText = "";

    for (const markerByte of CONTENT_MARKERS) {
      // If 0x2B already found valid text, skip 0x2A — no need to scan further
      if (bestLengthText && markerByte === 0x2a) break;
      let searchFrom = 0;
      while (searchFrom < blob.length - 2) {
        const idx = blob.indexOf(markerByte, searchFrom);
        if (idx === -1 || idx + 2 >= blob.length) break;
        searchFrom = idx + 1;

        // Parse compact int length after marker
        const firstByte = blob[idx + 1];
        let textStart: number;
        let byteLen: number;

        if (firstByte < 0x80) {
          byteLen = firstByte;
          textStart = idx + 2;
        } else if (firstByte === 0x81 && idx + 3 <= blob.length) {
          byteLen = blob[idx + 2];
          textStart = idx + 3;
        } else if (firstByte === 0x82 && idx + 4 <= blob.length) {
          byteLen = (blob[idx + 2] << 8) | blob[idx + 3];
          textStart = idx + 4;
        } else {
          continue;
        }

        if (byteLen < 1 || textStart + byteLen > blob.length) continue;

        // Safety: cap at 0x86 0x84 end-of-object marker to prevent over-read
        // if we matched the wrong 0x2b byte.
        const END_MARKER = Buffer.from([0x86, 0x84]);
        const endIdx = blob.indexOf(END_MARKER, textStart);
        const end = endIdx > textStart
          ? Math.min(textStart + byteLen, endIdx)
          : textStart + byteLen;

        const text = blob.subarray(textStart, end).toString("utf-8")
          .replace(/[\x00-\x08\x0e-\x1f]/g, "").trim();

        if (text && text.length > bestLengthText.length
            && !text.includes("__kIM") && !hasNSClassArtifacts(text)
            && !DATA_DETECTOR_RE.test(text)) {
          bestLengthText = text;
          // For 0x2B: take the first valid match and stop — the real text
          // is always the first string object in the typedstream.  Scanning
          // further risks hitting 0x2B bytes inside embedded bplists
          // (data detector metadata).
          if (markerByte === 0x2b) break;
        }
      }
    }

    if (bestLengthText) return bestLengthText;

    // Fallback: end-marker approach for blobs where length parsing fails.
    const END_MARKERS = [Buffer.from([0x86, 0x84]), Buffer.from([0x00, 0x00, 0x00])];
    const STREAM_MARKERS = [Buffer.from([0x2b, 0x00]), Buffer.from([0x2a, 0x00])];
    let bestMarkerText = "";

    for (const marker of STREAM_MARKERS) {
      const idx = blob.indexOf(marker);
      if (idx === -1) continue;

      const start = idx + marker.length;
      const candidate = blob.subarray(start);

      for (const em of END_MARKERS) {
        const endIdx = candidate.indexOf(em);
        if (endIdx > 0) {
          const textBytes = candidate.subarray(0, endIdx);
          const text = textBytes.toString("utf-8").replace(/[\x00-\x08\x0e-\x1f]/g, "").trim();
          if (text && text.length > bestMarkerText.length && !text.includes("__kIM") && !hasNSClassArtifacts(text) && !DATA_DETECTOR_RE.test(text)) {
            bestMarkerText = text;
          }
        }
      }
    }

    if (bestMarkerText) return bestMarkerText;

    // Fallback: decode entire blob as UTF-8, find longest printable segment.
    // Filter out iMessage internal metadata strings.
    const decoded = blob.toString("utf-8");
    const segments = decoded.match(/[\x20-\x7e\u00a0-\uffff]{10,}/g);
    if (segments) {
      const clean = segments.filter((s) => !s.includes("__kIM") && !hasNSClassArtifacts(s));
      if (clean.length > 0) {
        return clean.reduce((a, b) => (a.length >= b.length ? a : b)).trim();
      }
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
  const eggAppleId = getEggAppleId();
  if (!eggAppleId) return { messages: [], maxRowid: sinceRowid };
  if (!existsSync(CHAT_DB)) return { messages: [], maxRowid: sinceRowid };

  const querySince = Math.max(0, sinceRowid - LOOKBACK_ROWS);

  try {
    const db = new Database(CHAT_DB, { fileMustExist: true });
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
          m.associated_message_guid,
          m.cache_has_attachments,
          m.thread_originator_guid
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > ?
          AND m.account LIKE ?
        ORDER BY m.date ASC
        LIMIT 100`,
      )
      .all(querySince, `%${eggAppleId}%`) as Array<{
      ROWID: number;
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      unix_timestamp: number;
      guid: string | null;
      sender_handle: string | null;
      associated_message_type: number | null;
      associated_message_guid: string | null;
      cache_has_attachments: number;
      thread_originator_guid: string | null;
    }>;

    const attachmentStmt = db.prepare(
      `SELECT a.filename, a.mime_type, a.transfer_state
       FROM attachment a
       JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
       WHERE maj.message_id = ?`,
    );

    const replyLookupStmt = db.prepare(
      `SELECT text, attributedBody FROM message WHERE guid = ? LIMIT 1`,
    );

    const messages: Message[] = [];
    let maxRowid = sinceRowid;

    for (const row of rows) {
      maxRowid = Math.max(maxRowid, row.ROWID);

      if (seenRowids.has(row.ROWID)) continue;

      // Query attachments if present
      let attachments: Attachment[] | undefined;
      if (row.cache_has_attachments) {
        const attRows = attachmentStmt.all(row.ROWID) as Array<{
          filename: string | null;
          mime_type: string | null;
          transfer_state: number | null;
        }>;
        const valid = attRows
          .filter((a) => a.filename && a.transfer_state === 5)
          .map((a) => ({
            filename: a.filename!.replace(/^~/, homedir()),
            mimeType: a.mime_type ?? "application/octet-stream",
          }));
        if (valid.length > 0) attachments = valid;
      }

      // Strip NSKeyedArchiver binary plist blobs early, before any other processing.
      // iOS encodes date-like strings (e.g. "tomorrow") as NSDate bplist blobs.
      let text = row.text ? stripBplistBlob(row.text) : row.text;
      const attrText = row.attributedBody
        ? decodeAttributedBody(row.attributedBody)
        : null;

      // Prefer whichever source gives the longer text — row.text can be
      // truncated or null on newer macOS, and attributedBody has the full content.
      // But reject attrText that looks like iMessage internal metadata.
      if (
        attrText &&
        !attrText.includes("__kIM") &&
        !hasNSClassArtifacts(attrText) &&
        !DATA_DETECTOR_RE.test(attrText) &&
        (!text || attrText.length > text.length)
      ) {
        text = attrText;
      }

      // For attachment-only messages, text may be null or just \ufffc
      const hasAttachments = attachments && attachments.length > 0;
      if (!text && !hasAttachments) continue;

      const isPlaceholderOnly = text ? /^\s*\ufffc\s*$/.test(text) : false;
      if (isPlaceholderOnly && !hasAttachments) continue;

      // If text is binary metadata from an attachment-only message, discard it
      if (text && text.includes("__kIM")) {
        if (hasAttachments) {
          text = "";
        } else {
          continue;
        }
      }

      // Strip non-printable chars and \ufffc placeholders
      if (text) {
        // Remove everything outside printable ASCII + common unicode, but preserve newlines/tabs
        text = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
        text = text.replace(/\ufffc/g, "");
        text = text.replace(NS_CLASS_RE, "");
        // Strip invisible Unicode formatting characters
        const stripped = text.replace(
          /[\u200B-\u200D\uFEFF\u00AD\u2060\u200C\u200F\u202A-\u202E\u2066-\u206F]/g,
          "",
        );
        if (stripped !== text) {
          console.warn("[parse] stripped invisible unicode chars from message");
          text = stripped;
        }
        text = text.trim();
      }

      // If text is empty after stripping, set to empty string (attachments carry the content)
      if (!text) text = "";

      if (text) {
        text = scrubText(text);
        // Skip messages that are only whitespace or control characters
        if (!/[\x20-\x7e\u00a0-\ufffa]/.test(text) && !hasAttachments) continue;
      }

      // Final safety net: if text still contains NSKeyedArchiver/bplist binary markers
      // after all processing, try to extract readable text one more time before
      // clearing.  This catches any path that bypassed stripBplistBlob
      // (e.g. content sourced from attributedBody or indirect decoding).
      if (text && (NSKEYEDARCHIVER_KEY_RE.test(text) || BPLIST_BINARY_RE.test(text) || hasNSClassArtifacts(text) || DATA_DETECTOR_RE.test(text))) {
        const extracted = extractTextFromBplist(text);
        if (extracted) {
          console.warn("[parse] final safety: extracted text from residual bplist artifacts:", extracted.slice(0, 80));
          text = extracted;
        } else {
          console.warn("[parse] final safety: text still contains NS/bplist artifacts — clearing");
          text = "";
        }
      }

      // Reply-to context: if this message is a reply, prepend the original text
      if (row.thread_originator_guid && text) {
        try {
          const orig = replyLookupStmt.get(row.thread_originator_guid) as {
            text: string | null;
            attributedBody: Buffer | null;
          } | undefined;
          if (orig) {
            let origText = orig.text ? stripBplistBlob(orig.text) : orig.text;
            const origAttr = orig.attributedBody
              ? decodeAttributedBody(orig.attributedBody)
              : null;
            if (origAttr && !hasNSClassArtifacts(origAttr) && (!origText || origAttr.length > origText.length)) {
              origText = origAttr;
            }
            if (origText) {
              const truncated =
                origText.length > 100
                  ? origText.slice(0, 100) + "…"
                  : origText;
              text = `[replying to: "${truncated}"] ${text}`;
            }
          }
        } catch {
          // Original message not found or lookup failed — skip annotation
        }
      }

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
        attachments,
      });
    }

    db.close();
    return { messages, maxRowid };
  } catch (err) {
    console.error("Failed to read Egg conversation from chat.db:", err);
    return { messages: [], maxRowid: sinceRowid };
  }
}

/**
 * Clean raw message text: extract from bplist, strip binary artifacts,
 * remove invisible chars, scrub PII. Returns cleaned text or empty string.
 */
function cleanMessageText(
  rawText: string | null,
  rawAttrBody: Buffer | null,
): string {
  let text = rawText ? stripBplistBlob(rawText) : rawText;
  const attrText = rawAttrBody ? decodeAttributedBody(rawAttrBody) : null;

  if (
    attrText &&
    !attrText.includes("__kIM") &&
    !hasNSClassArtifacts(attrText) &&
    !DATA_DETECTOR_RE.test(attrText) &&
    (!text || attrText.length > text.length)
  ) {
    text = attrText;
  }

  if (!text) return "";
  if (/^\s*\ufffc\s*$/.test(text)) return "";
  if (text.includes("__kIM")) return "";

  text = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
  text = text.replace(/\ufffc/g, "");
  text = text.replace(NS_CLASS_RE, "");
  text = text.replace(
    /[\u200B-\u200D\uFEFF\u00AD\u2060\u200C\u200F\u202A-\u202E\u2066-\u206F]/g,
    "",
  );
  text = text.trim();

  if (!text) return "";
  text = scrubText(text);
  if (!/[\x20-\x7e\u00a0-\ufffa]/.test(text)) return "";

  // Final bplist safety net
  if (NSKEYEDARCHIVER_KEY_RE.test(text) || BPLIST_BINARY_RE.test(text) || hasNSClassArtifacts(text) || DATA_DETECTOR_RE.test(text)) {
    const extracted = extractTextFromBplist(text);
    return extracted ?? "";
  }

  return text;
}

/**
 * Fetch the most recent N messages from the Egg iMessage conversation.
 * Returns messages in chronological order with role and text.
 * Used to provide conversation context to brain prompts.
 */
export function getRecentEggMessages(count = 20): { role: "user" | "assistant"; text: string; time: string }[] {
  const eggAppleId = getEggAppleId();
  if (!eggAppleId) return [];
  if (!existsSync(CHAT_DB)) return [];

  try {
    const db = new Database(CHAT_DB, { fileMustExist: true });
    db.pragma("query_only = ON");

    const rows = db
      .prepare(
        `SELECT
          m.text,
          m.attributedBody,
          m.is_from_me,
          m.date / 1000000000 + 978307200 as unix_timestamp,
          m.associated_message_type
        FROM message m
        WHERE m.account LIKE ?
        ORDER BY m.date DESC
        LIMIT ?`,
      )
      .all(`%${eggAppleId}%`, count * 2) as Array<{
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      unix_timestamp: number;
      associated_message_type: number | null;
    }>;

    db.close();

    const results: { role: "user" | "assistant"; text: string; time: string }[] = [];

    for (const row of rows) {
      // Skip reactions
      if ((row.associated_message_type ?? 0) !== 0) continue;

      const text = cleanMessageText(row.text, row.attributedBody);
      if (!text) continue;

      const ts = row.unix_timestamp;
      const time = ts
        ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")
        : "unknown";

      results.push({
        role: row.is_from_me ? "assistant" : "user",
        text,
        time,
      });

      if (results.length >= count) break;
    }

    // Reverse to chronological order
    return results.reverse();
  } catch (err) {
    console.error("Failed to read recent Egg messages from chat.db:", err);
    return [];
  }
}

/**
 * Read ALL messages from chat.db (all threads, all accounts) since a given ROWID.
 * Used by iMessage ingestion to track the user's full social landscape.
 */
export function getAllMessages(sinceRowid: number): { messages: ThreadMessage[]; maxRowid: number } {
  if (!existsSync(CHAT_DB)) return { messages: [], maxRowid: sinceRowid };

  try {
    const db = new Database(CHAT_DB, { fileMustExist: true });
    db.pragma("query_only = ON");

    const rows = db
      .prepare(
        `SELECT
          m.ROWID,
          m.text,
          m.attributedBody,
          m.is_from_me,
          m.date / 1000000000 + 978307200 as unix_timestamp,
          h.id as sender_handle,
          m.associated_message_type,
          c.chat_identifier,
          c.display_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE m.ROWID > ?
        ORDER BY m.date ASC
        LIMIT 500`,
      )
      .all(sinceRowid) as Array<{
      ROWID: number;
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      unix_timestamp: number;
      sender_handle: string | null;
      associated_message_type: number | null;
      chat_identifier: string | null;
      display_name: string | null;
    }>;

    const messages: ThreadMessage[] = [];
    let maxRowid = sinceRowid;

    for (const row of rows) {
      maxRowid = Math.max(maxRowid, row.ROWID);

      // Skip reactions
      if ((row.associated_message_type ?? 0) !== 0) continue;

      const text = cleanMessageText(row.text, row.attributedBody);
      if (!text) continue;

      const ts = row.unix_timestamp;
      const time = ts
        ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")
        : "unknown";

      messages.push({
        text,
        isFromMe: Boolean(row.is_from_me),
        time,
        rowid: row.ROWID,
        sender: row.sender_handle ?? "",
        chatIdentifier: row.chat_identifier ?? "",
        displayName: row.display_name ?? "",
      });
    }

    db.close();
    return { messages, maxRowid };
  } catch (err) {
    console.error("Failed to read messages from chat.db:", err);
    return { messages: [], maxRowid: sinceRowid };
  }
}
