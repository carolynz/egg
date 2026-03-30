/**
 * Twitter/X thread reader using the FxTwitter API with ThreadReaderApp fallback.
 *
 * FxTwitter (api.fxtwitter.com) is a free, open service that returns tweet
 * data as JSON without authentication. It supports individual tweets,
 * threads, and quote tweets.
 *
 * Thread reading strategy:
 *  1. Fetch the linked tweet via FxTwitter (includes self-reply thread data)
 *  2. If FxTwitter doesn't return thread data and the tweet looks like part of
 *     a thread (self-reply or root with replies), fall back to ThreadReaderApp
 *  3. ThreadReaderApp (threadreaderapp.com) specialises in unrolling threads —
 *     we fetch the HTML and parse out tweet texts as a reliable fallback
 *  4. If both fail, return the single tweet (never worse than before)
 */

/** Matches twitter.com and x.com status URLs, capturing username and tweet ID. */
const TWITTER_URL_RE =
  /https?:\/\/(?:(?:www\.)?(?:twitter\.com|x\.com)|(?:fixupx|fxtwitter)\.com)\/(\w+)\/status\/(\d+)/;

/** Request timeout in ms. */
const FETCH_TIMEOUT = 15_000;

/** ThreadReaderApp fallback timeout in ms. */
const THREADREADER_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MediaItem {
  type: "photo" | "video" | "gif";
  url: string;
  altText?: string;
}

export interface TweetData {
  id: string;
  url: string;
  author: {
    name: string;
    handle: string;
  };
  text: string;
  createdAt: string;
  stats: {
    likes: number;
    retweets: number;
    replies: number;
    views: number | null;
  };
  media: MediaItem[];
  quotedTweet: TweetData | null;
  /** Username this tweet is replying to, if any. */
  replyingTo: string | null;
  isThread: boolean;
  threadPosts: TweetData[];
}

// ---------------------------------------------------------------------------
// FxTwitter API response types
// ---------------------------------------------------------------------------

interface FxTweet {
  id: string;
  url: string;
  text: string;
  created_at: string;
  author: {
    name: string;
    screen_name: string;
  };
  likes: number;
  retweets: number;
  replies: number;
  views: number | null;
  media?: {
    all?: Array<{
      type: string;
      url: string;
      thumbnail_url?: string;
      altText?: string;
    }>;
  };
  quote?: FxTweet;
  thread?: {
    tweets?: FxTweet[];
  };
  replying_to?: string | null;
}

interface FxTweetResponse {
  code: number;
  message: string;
  tweet?: FxTweet;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Twitter/X URL and return the username and tweet ID, or null.
 */
export function parseTwitterUrl(
  url: string,
): { username: string; tweetId: string } | null {
  const match = url.match(TWITTER_URL_RE);
  if (!match) return null;
  return { username: match[1], tweetId: match[2] };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch a single tweet from the FxTwitter API. Returns the raw API tweet or
 * null on failure. Retries once on transient errors.
 */
async function fetchFxTweet(
  username: string,
  tweetId: string,
): Promise<FxTweet | null> {
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(apiUrl, {
        headers: {
          "User-Agent": "egg-bot/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      if (!res.ok) {
        console.error(
          `[twitter] API returned ${res.status} for ${tweetId} (attempt ${attempt + 1})`,
        );
        if (attempt === 0 && res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        return null;
      }

      const data = (await res.json()) as FxTweetResponse;
      if (data.code !== 200 || !data.tweet) {
        console.error(`[twitter] API error: ${data.message}`);
        return null;
      }

      return data.tweet;
    } catch (err) {
      console.error(`[twitter] fetch failed (attempt ${attempt + 1}):`, err);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Fetch a tweet and its full thread.
 *
 * - If FxTwitter returns thread data, it is used directly.
 * - If the tweet is a self-reply (author replying to themselves) without
 *   thread data, we walk up the reply chain by fetching each parent tweet
 *   until we find the root, then assemble the thread in order.
 * - Reply context to other users is noted.
 */
export async function fetchTweet(
  username: string,
  tweetId: string,
): Promise<TweetData | null> {
  console.log(`[twitter] fetching @${username}/status/${tweetId}`);

  const rawTweet = await fetchFxTweet(username, tweetId);
  if (!rawTweet) return null;

  // FxTwitter returned thread data — use it directly
  if (rawTweet.thread?.tweets && rawTweet.thread.tweets.length > 0) {
    const tweet = parseFxTweet(rawTweet);
    console.log(
      `[twitter] FxTwitter returned thread with ${tweet.threadPosts.length} additional posts`,
    );
    return tweet;
  }

  // If this tweet is a self-reply, try to assemble the full thread.
  if (isSelfReply(rawTweet)) {
    console.log(`[twitter] tweet is a self-reply, attempting thread assembly`);
    const thread = await assembleThread(rawTweet, username);
    if (thread) return thread;
  }

  // If this is a thread root (no replying_to) with replies, the thread
  // content lives in the replies — try ThreadReaderApp as fallback.
  if (!rawTweet.replying_to && rawTweet.replies > 0) {
    console.log(
      `[twitter] root tweet has ${rawTweet.replies} replies, trying ThreadReaderApp`,
    );
    const thread = await fetchThreadFromReaderApp(rawTweet);
    if (thread) return thread;
  }

  return parseFxTweet(rawTweet);
}

/**
 * Check if a tweet is a reply to the same author (part of a self-thread).
 */
function isSelfReply(tweet: FxTweet): boolean {
  return (
    tweet.replying_to != null &&
    tweet.replying_to.toLowerCase() === tweet.author.screen_name.toLowerCase()
  );
}

/**
 * Assemble a full thread when the user linked a mid-thread tweet.
 *
 * FxTwitter doesn't expose parent tweet IDs in the `replying_to` field (it
 * only returns the username), so we can't walk up the reply chain directly.
 * Instead we fall back to ThreadReaderApp which specialises in unrolling
 * threads from any tweet in the chain.
 */
async function assembleThread(
  startTweet: FxTweet,
  _username: string,
): Promise<TweetData | null> {
  return fetchThreadFromReaderApp(startTweet);
}

// ---------------------------------------------------------------------------
// ThreadReaderApp fallback
// ---------------------------------------------------------------------------

/**
 * Fetch a thread from ThreadReaderApp by tweet ID. ThreadReaderApp unrolls
 * threads from any tweet in the chain, making it a reliable fallback when
 * FxTwitter doesn't return thread data.
 *
 * Returns a TweetData with threadPosts populated, or null on failure.
 * Preserves metadata (stats, media) from the original FxTwitter tweet.
 */
async function fetchThreadFromReaderApp(
  originalTweet: FxTweet,
): Promise<TweetData | null> {
  const url = `https://threadreaderapp.com/thread/${originalTweet.id}.html`;
  console.log(`[twitter] fetching ThreadReaderApp: ${url}`);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "egg-bot/1.0",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(THREADREADER_TIMEOUT),
    });

    if (!res.ok) {
      console.error(
        `[twitter] ThreadReaderApp returned ${res.status} for tweet ${originalTweet.id}`,
      );
      return null;
    }

    const html = await res.text();
    return parseThreadReaderHtml(html, originalTweet);
  } catch (err) {
    console.error("[twitter] ThreadReaderApp fetch failed:", err);
    return null;
  }
}

/**
 * Parse ThreadReaderApp HTML into a TweetData with thread posts.
 * ThreadReaderApp renders tweet texts in elements with class "tweet-text"
 * (sometimes <p>, sometimes <div>). We try several patterns.
 */
function parseThreadReaderHtml(
  html: string,
  originalTweet: FxTweet,
): TweetData | null {
  const tweetTexts = extractTweetTexts(html);

  // Need at least 2 tweets to call it a thread
  if (tweetTexts.length < 2) {
    console.log(
      `[twitter] ThreadReaderApp returned ${tweetTexts.length} tweets — not enough for a thread`,
    );
    return null;
  }

  console.log(
    `[twitter] ThreadReaderApp returned ${tweetTexts.length} tweets`,
  );

  // Build root from the original FxTwitter data (preserves stats, media, etc.)
  const root = parseFxTweet(originalTweet);
  const author = root.author;

  root.isThread = true;
  root.threadPosts = tweetTexts.slice(1).map(
    (text, i): TweetData => ({
      id: `${originalTweet.id}-tr-${i + 1}`,
      url: `https://x.com/${author.handle}/status/${originalTweet.id}`,
      author,
      text,
      createdAt: originalTweet.created_at,
      stats: { likes: 0, retweets: 0, replies: 0, views: null },
      media: [],
      quotedTweet: null,
      replyingTo: null,
      isThread: false,
      threadPosts: [],
    }),
  );

  return root;
}

/**
 * Extract tweet text blocks from ThreadReaderApp HTML.
 * Tries several CSS class patterns used across ThreadReaderApp versions.
 */
function extractTweetTexts(html: string): string[] {
  let match: RegExpExecArray | null;

  // Pattern 1: <p> or <div> elements with "tweet-text" in their class
  const tweetTextRegex =
    /<(?:p|div)[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/gi;
  const texts: string[] = [];
  while ((match = tweetTextRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]);
    if (text) texts.push(text);
  }
  if (texts.length > 1) return texts;

  // Pattern 2: <div class="content-tweet"> containers with <p> inside
  texts.length = 0;
  const contentTweetRegex =
    /<div[^>]*class="[^"]*content-tweet[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = contentTweetRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]);
    if (text) texts.push(text);
  }
  if (texts.length > 1) return texts;

  // Pattern 3: data-tweet-id elements (more recent ThreadReaderApp versions)
  texts.length = 0;
  const dataTweetRegex =
    /<div[^>]*data-tweet-id="[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = dataTweetRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]);
    if (text) texts.push(text);
  }

  return texts;
}

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .trim();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseFxTweet(tweet: FxTweet): TweetData {
  const media: MediaItem[] = [];
  if (tweet.media?.all) {
    for (const m of tweet.media.all) {
      const type: MediaItem["type"] =
        m.type === "photo" ? "photo" : m.type === "gif" ? "gif" : "video";
      media.push({
        type,
        url: m.type === "photo" ? m.url : (m.thumbnail_url ?? m.url),
        altText: m.altText || undefined,
      });
    }
  }

  let quotedTweet: TweetData | null = null;
  if (tweet.quote) {
    quotedTweet = parseFxTweet(tweet.quote);
  }

  const threadPosts: TweetData[] = [];
  if (tweet.thread?.tweets) {
    for (const t of tweet.thread.tweets) {
      if (t && t.id !== tweet.id) {
        threadPosts.push(parseFxTweet(t));
      }
    }
  }

  return {
    id: tweet.id,
    url: tweet.url,
    author: {
      name: tweet.author.name,
      handle: tweet.author.screen_name,
    },
    text: tweet.text,
    createdAt: tweet.created_at,
    stats: {
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      views: tweet.views ?? null,
    },
    media,
    quotedTweet,
    replyingTo: tweet.replying_to ?? null,
    isThread: threadPosts.length > 0,
    threadPosts,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a TweetData into a readable text block for the brain prompt.
 * Shows full thread with metadata per tweet.
 */
export function formatTweet(tweet: TweetData): string {
  const lines: string[] = [];
  const totalPosts = tweet.isThread ? tweet.threadPosts.length + 1 : 1;
  const label = tweet.isThread ? "thread" : "tweet";

  lines.push(
    `--- ${label} by @${tweet.author.handle} (${tweet.author.name}) ---`,
  );

  // Reply context (only shown when replying to a different user)
  if (
    tweet.replyingTo &&
    tweet.replyingTo.toLowerCase() !== tweet.author.handle.toLowerCase()
  ) {
    lines.push(`[replying to @${tweet.replyingTo}]`);
  }

  // For threads, number the first post
  if (tweet.isThread) {
    lines.push(`[1/${totalPosts}]`);
  }

  lines.push(tweet.text);

  // Stats for the main tweet
  const stats = formatStats(tweet.stats);
  if (stats) lines.push(stats);

  // Media for the main tweet
  formatMediaBlock(tweet.media, lines);

  // Quote tweet on the main tweet
  formatQuoteBlock(tweet.quotedTweet, lines);

  // Thread posts
  if (tweet.isThread && tweet.threadPosts.length > 0) {
    for (let i = 0; i < tweet.threadPosts.length; i++) {
      const post = tweet.threadPosts[i];
      lines.push("");
      lines.push(`[${i + 2}/${totalPosts}]`);
      lines.push(post.text);

      formatMediaBlock(post.media, lines);
      formatQuoteBlock(post.quotedTweet, lines);
    }
  }

  lines.push(`--- end ${label} ---`);

  return lines.join("\n");
}

function formatMediaBlock(media: MediaItem[], lines: string[]): void {
  if (media.length === 0) return;

  const descs = media.map((m) => {
    if (m.altText) return `${m.type}: "${m.altText}"`;
    return m.type;
  });
  lines.push(`[media: ${descs.join(", ")}]`);
}

function formatQuoteBlock(qt: TweetData | null, lines: string[]): void {
  if (!qt) return;

  lines.push("");
  lines.push(`> Quoting @${qt.author.handle} (${qt.author.name}):`);
  for (const ql of qt.text.split("\n")) {
    lines.push(`> ${ql}`);
  }
  if (qt.media.length > 0) {
    const descs = qt.media.map((m) =>
      m.altText ? `${m.type}: "${m.altText}"` : m.type,
    );
    lines.push(`> [media: ${descs.join(", ")}]`);
  }
}

function formatStats(stats: TweetData["stats"]): string {
  const parts: string[] = [];
  if (stats.likes > 0) parts.push(`${fmtCount(stats.likes)} likes`);
  if (stats.retweets > 0) parts.push(`${fmtCount(stats.retweets)} retweets`);
  if (stats.replies > 0) parts.push(`${fmtCount(stats.replies)} replies`);
  if (stats.views != null && stats.views > 0)
    parts.push(`${fmtCount(stats.views)} views`);
  return parts.length > 0 ? `[${parts.join(" · ")}]` : "";
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
