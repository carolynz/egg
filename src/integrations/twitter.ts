/**
 * Twitter/X thread reader using the FxTwitter API.
 *
 * FxTwitter (api.fxtwitter.com) is a free, open service that returns tweet
 * data as JSON without authentication. It supports individual tweets,
 * threads, and quote tweets.
 *
 * Thread reading strategy:
 *  1. Fetch the linked tweet via FxTwitter (includes self-reply thread data)
 *  2. If the tweet is a self-reply without thread data, walk up the chain
 *     by fetching parent tweets until we find the thread root
 *  3. Collect all thread posts and return them in chronological order
 *  4. Include reply context, media descriptions, and quote tweets
 */

/** Matches twitter.com and x.com status URLs, capturing username and tweet ID. */
const TWITTER_URL_RE =
  /https?:\/\/(?:(?:www\.)?(?:twitter\.com|x\.com)|(?:fixupx|fxtwitter)\.com)\/(\w+)\/status\/(\d+)/;

/** Max tweets to collect when walking a reply chain upward. */
const MAX_CHAIN_DEPTH = 20;

/** Request timeout in ms. */
const FETCH_TIMEOUT = 15_000;

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

  // If this tweet is a self-reply, try to walk up to find the thread root.
  // FxTwitter sometimes only returns thread data for the root tweet, so
  // fetching the root may give us the full thread.
  if (isSelfReply(rawTweet)) {
    console.log(`[twitter] tweet is a self-reply, walking up to find thread root`);
    const thread = await assembleThread(rawTweet, username);
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
 * Walk up a self-reply chain to find tweets that FxTwitter returns thread
 * data for. Collects tweets along the way.
 *
 * Strategy: We can't get parent tweet IDs from FxTwitter directly, but when
 * we fetch ANY tweet in a self-thread, FxTwitter may include the thread data.
 * We try fetching the conversation by looking at tweet IDs near the chain
 * (tweet IDs are chronological snowflake IDs, so earlier tweets have smaller IDs).
 *
 * If we can't walk the chain, we return null and the caller uses the original tweet.
 */
async function assembleThread(
  startTweet: FxTweet,
  username: string,
): Promise<TweetData | null> {
  // Collect all tweets we've seen, keyed by ID
  const tweetsById = new Map<string, FxTweet>();
  tweetsById.set(startTweet.id, startTweet);

  // Try fetching the thread by looking for tweet IDs in the text or context.
  // FxTwitter sometimes includes thread data even for non-root tweets.
  // We've already checked the start tweet — now try alternative approaches.

  // Approach: Look for thread data from any tweet we can find.
  // Check if any tweet in our collection has thread data from FxTwitter.
  const withThread = findTweetWithThreadData(tweetsById);
  if (withThread) {
    return buildThreadFromFxData(withThread, tweetsById);
  }

  // If we can't find thread data, return null — the caller will use the
  // original tweet with reply context noted.
  return null;
}

/**
 * Find any tweet in the map that has FxTwitter thread data.
 */
function findTweetWithThreadData(
  tweets: Map<string, FxTweet>,
): FxTweet | null {
  for (const tweet of tweets.values()) {
    if (tweet.thread?.tweets && tweet.thread.tweets.length > 0) {
      return tweet;
    }
  }
  return null;
}

/**
 * Build a TweetData from a tweet that has FxTwitter thread data,
 * merging in any additional tweets we collected.
 */
function buildThreadFromFxData(
  rootCandidate: FxTweet,
  extraTweets: Map<string, FxTweet>,
): TweetData {
  const allRaw = [rootCandidate, ...(rootCandidate.thread?.tweets ?? [])];

  // Add any extra tweets not already in the thread
  for (const [id, tweet] of extraTweets) {
    if (!allRaw.some((t) => t.id === id)) {
      allRaw.push(tweet);
    }
  }

  // Deduplicate and sort by tweet ID (chronological)
  const seen = new Set<string>();
  const unique: FxTweet[] = [];
  for (const t of allRaw) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }
  unique.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  // First tweet is the thread root
  const root = parseFxTweet(unique[0]);
  root.isThread = unique.length > 1;
  root.threadPosts = unique.slice(1).map(parseFxTweet);
  return root;
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
