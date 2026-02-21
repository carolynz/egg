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

function hasNSClassArtifacts(text: string): boolean {
  // No \b — bplist type bytes are letters and directly precede NS class names
  return /NS[A-Z]\w*|streamtyped|typedstream|bplist\S*/.test(text);
}

/**
 * Detect and replace NSKeyedArchiver binary plist blobs in a text string.
 * iOS sometimes encodes date-like strings (e.g. "tomorrow") as NSDate objects
 * serialized as binary plists, which arrive as binary garbage in chat.db text.
 *
 * Detection paths (any one is sufficient):
 *  1. Text starts with "bplist00" — the binary plist magic header decoded intact.
 *  2. Text contains NSKeyedArchiver structural keys ($classname, $classes, etc.)
 *     even without the magic prefix — this happens when the leading bytes of the
 *     bplist are invalid UTF-8 and get replaced with U+FFFD by SQLite/better-sqlite3.
 *  3. Text contains bplist type-byte-prefixed class names (XNSObject, XNSDate, etc.)
 *     or the Z$classname structural key — these never appear in normal user text.
 *
 * When any indicator is detected the ENTIRE text is replaced with "[date]".
 * No segment-recovery is attempted: bplist blobs contain only binary structure and
 * class metadata — there is no recoverable user text.
 */
function stripBplistBlob(text: string): string {
  if (
    text.startsWith("bplist00") ||
    NSKEYEDARCHIVER_KEY_RE.test(text) ||
    BPLIST_BINARY_RE.test(text)
  ) {
    console.warn("[parse] text field is NSKeyedArchiver/bplist blob — replacing with [date]");
    return "[date]";
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

function scrubText(text: string): string {
  return text.replace(PHONE_RE, "[PHONE]").replace(EMAIL_RE, "[EMAIL]");
}

function decodeAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;
  try {
    // Early exit: if the blob is an NSKeyedArchiver binary plist (starts with
    // "bplist00"), it contains a serialized NSDate or similar object — there is
    // no readable message text to extract.
    if (blob.length >= 8 && blob.subarray(0, 8).equals(BPLIST_MAGIC)) {
      console.warn("[parse] attributedBody is a bplist blob (NSDate?) — skipping");
      return null;
    }

    // Ported from Python egg-me-on: find text between known markers in the
    // NSKeyedArchiver typedstream blob, with a regex fallback.
    const END_MARKERS = [Buffer.from([0x86, 0x84]), Buffer.from([0x00, 0x00, 0x00])];
    const STREAM_MARKERS = [Buffer.from([0x2b, 0x00]), Buffer.from([0x2a, 0x00])];

    for (const marker of STREAM_MARKERS) {
      const idx = blob.indexOf(marker);
      if (idx === -1) continue;

      const start = idx + marker.length;
      const candidate = blob.subarray(start);

      let textBytes = candidate;
      for (const em of END_MARKERS) {
        const endIdx = candidate.indexOf(em);
        if (endIdx > 0) {
          textBytes = candidate.subarray(0, endIdx);
          break;
        }
      }

      const text = textBytes.toString("utf-8").replace(/[\x00-\x08\x0e-\x1f]/g, "").trim();
      // Reject results that are iMessage internal metadata or NSKeyedArchiver binary artifacts
      if (text && !text.includes("__kIM") && !hasNSClassArtifacts(text)) return text;
    }

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
      // after all processing, replace entirely.  This catches any path that bypassed
      // stripBplistBlob (e.g. content sourced from attributedBody or indirect decoding).
      if (text && (NSKEYEDARCHIVER_KEY_RE.test(text) || BPLIST_BINARY_RE.test(text) || hasNSClassArtifacts(text))) {
        console.warn("[parse] final safety: text still contains NS/bplist artifacts — replacing with [date]");
        text = "[date]";
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
