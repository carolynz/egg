/**
 * PII stripping module — regex-based redaction applied to all text
 * before sending to Claude Code during onboarding.
 */

// ── Patterns ──────────────────────────────────────────────────────────────────

// Phone numbers: international and domestic formats
// From egg-archive/src/imessage/reader.py _PHONE_RE
const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g;

// Email addresses
// From egg-archive/src/imessage/reader.py _EMAIL_RE
const EMAIL_RE = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;

// SSN: XXX-XX-XXXX
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// EIN: XX-XXXXXXX
const EIN_RE = /\b\d{2}-\d{7}\b/g;

// Credit card numbers: 13-19 digits (with optional spaces/dashes)
const CC_RE = /\b(?:\d[\s-]*){13,19}\b/g;

// Physical addresses: number + street name + street type (+ optional unit)
const ADDRESS_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}\b(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Place|Pl|Way|Circle|Cir|Terrace|Ter|Trail|Trl|Parkway|Pkwy|Highway|Hwy)\b[.,]?\s*(?:(?:Apt|Suite|Ste|Unit|#)\s*[\w-]+)?[.,]?\s*(?:[A-Z][a-z]+[.,]?\s*)?(?:[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/gi;

// Emails to preserve (Kelin's own addresses)
const PRESERVED_EMAIL_RE = /[a-zA-Z0-9_.+-]+@poetrycamera\.com/gi;

// ── Strip function ────────────────────────────────────────────────────────────

export function stripPII(text: string): string {
  if (!text) return text;

  // 1. Extract preserved emails and replace with temporary placeholders
  const preserved: string[] = [];
  let result = text.replace(PRESERVED_EMAIL_RE, (match) => {
    preserved.push(match);
    return `__PRESERVED_EMAIL_${preserved.length - 1}__`;
  });

  // 2. Apply redactions (order matters: SSN before phone to avoid partial matches)
  result = result.replace(SSN_RE, "[SSN_REDACTED]");
  result = result.replace(EIN_RE, "[EIN_REDACTED]");
  result = result.replace(CC_RE, "[CC_REDACTED]");
  result = result.replace(ADDRESS_RE, "[ADDRESS_REDACTED]");
  result = result.replace(PHONE_RE, "[PHONE_REDACTED]");
  result = result.replace(EMAIL_RE, "[EMAIL_REDACTED]");

  // 3. Restore preserved emails
  for (let i = 0; i < preserved.length; i++) {
    result = result.replace(`__PRESERVED_EMAIL_${i}__`, preserved[i]);
  }

  return result;
}
