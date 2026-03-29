/**
 * URL enrichment: detects URLs in messages and fetches their content
 * to include in the brain prompt. Currently supports Twitter/X URLs.
 */

import { parseTwitterUrl, fetchTweet, formatTweet } from "../integrations/twitter.js";

/** Matches any http/https URL in text. */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

interface EnrichmentResult {
  /** The original message text with URL content appended. */
  enrichedText: string;
  /** Number of URLs that were successfully enriched. */
  enrichedCount: number;
}

/**
 * Scan a message for URLs, fetch supported content, and append it to the message.
 * Currently supports:
 *   - Twitter/X post URLs (twitter.com, x.com)
 */
export async function enrichUrls(text: string): Promise<EnrichmentResult> {
  const urls = text.match(URL_RE);
  if (!urls) return { enrichedText: text, enrichedCount: 0 };

  // Deduplicate URLs
  const unique = [...new Set(urls)];
  const enrichments: string[] = [];

  for (const url of unique) {
    const twitterParsed = parseTwitterUrl(url);
    if (twitterParsed) {
      try {
        const tweet = await fetchTweet(twitterParsed.username, twitterParsed.tweetId);
        if (tweet) {
          console.log(`[url-enrich] fetched tweet ${tweet.id} by @${tweet.author.handle}`);
          enrichments.push(formatTweet(tweet));
        } else {
          console.warn(`[url-enrich] failed to fetch tweet from: ${url}`);
        }
      } catch (err) {
        console.error(`[url-enrich] error fetching ${url}:`, err);
      }
    }
    // Future: add more URL handlers here (articles, YouTube, etc.)
  }

  if (enrichments.length === 0) {
    return { enrichedText: text, enrichedCount: 0 };
  }

  const enrichedText = text + "\n\n" + enrichments.join("\n\n");
  return { enrichedText, enrichedCount: enrichments.length };
}
