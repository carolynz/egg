/**
 * Twitter/X post fetcher using the FxTwitter API.
 *
 * FxTwitter (api.fxtwitter.com) is a free, open service that returns tweet
 * data as JSON without authentication. It supports individual tweets,
 * threads, and quote tweets.
 */

/** Matches twitter.com and x.com status URLs, capturing the tweet ID. */
const TWITTER_URL_RE =
  /https?:\/\/(?:(?:www\.)?(?:twitter\.com|x\.com)|(?:fixupx|fxtwitter)\.com)\/(\w+)\/status\/(\d+)/;

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
  media: string[];
  quotedTweet: TweetData | null;
  isThread: boolean;
  threadPosts: TweetData[];
}

interface FxTweetResponse {
  code: number;
  message: string;
  tweet?: {
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
      }>;
    };
    quote?: FxTweetResponse["tweet"];
    thread?: {
      tweets?: FxTweetResponse["tweet"][];
    };
  };
}

/**
 * Parse a Twitter/X URL and return the username and tweet ID, or null.
 */
export function parseTwitterUrl(url: string): { username: string; tweetId: string } | null {
  const match = url.match(TWITTER_URL_RE);
  if (!match) return null;
  return { username: match[1], tweetId: match[2] };
}

/**
 * Fetch tweet data from the FxTwitter API.
 */
export async function fetchTweet(username: string, tweetId: string): Promise<TweetData | null> {
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;
  console.log(`[twitter] fetching: ${apiUrl}`);

  try {
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "egg-bot/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[twitter] API returned ${res.status}: ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as FxTweetResponse;

    if (data.code !== 200 || !data.tweet) {
      console.error(`[twitter] API error: ${data.message}`);
      return null;
    }

    return parseFxTweet(data.tweet);
  } catch (err) {
    console.error(`[twitter] fetch failed:`, err);
    return null;
  }
}

function parseFxTweet(tweet: NonNullable<FxTweetResponse["tweet"]>): TweetData {
  const media: string[] = [];
  if (tweet.media?.all) {
    for (const m of tweet.media.all) {
      if (m.type === "photo") media.push(m.url);
      else if (m.type === "video" || m.type === "gif") media.push(m.thumbnail_url ?? m.url);
    }
  }

  let quotedTweet: TweetData | null = null;
  if (tweet.quote) {
    quotedTweet = parseFxTweet(tweet.quote);
  }

  const threadPosts: TweetData[] = [];
  if (tweet.thread?.tweets) {
    for (const t of tweet.thread.tweets) {
      // Skip the main tweet itself (it's already the top-level)
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
    isThread: threadPosts.length > 0,
    threadPosts,
  };
}

/**
 * Format a TweetData into a readable text block for the brain prompt.
 */
export function formatTweet(tweet: TweetData): string {
  const lines: string[] = [];

  lines.push(`--- tweet by @${tweet.author.handle} (${tweet.author.name}) ---`);
  lines.push(tweet.text);
  lines.push("");

  const stats: string[] = [];
  if (tweet.stats.likes > 0) stats.push(`${formatCount(tweet.stats.likes)} likes`);
  if (tweet.stats.retweets > 0) stats.push(`${formatCount(tweet.stats.retweets)} retweets`);
  if (tweet.stats.replies > 0) stats.push(`${formatCount(tweet.stats.replies)} replies`);
  if (tweet.stats.views != null && tweet.stats.views > 0) stats.push(`${formatCount(tweet.stats.views)} views`);
  if (stats.length > 0) lines.push(`[${stats.join(" · ")}]`);

  if (tweet.media.length > 0) {
    lines.push(`[${tweet.media.length} media attachment(s)]`);
  }

  if (tweet.quotedTweet) {
    lines.push("");
    lines.push(`> Quoting @${tweet.quotedTweet.author.handle}:`);
    lines.push(`> ${tweet.quotedTweet.text.split("\n").join("\n> ")}`);
  }

  if (tweet.isThread && tweet.threadPosts.length > 0) {
    lines.push("");
    lines.push(`[Thread continues with ${tweet.threadPosts.length} more post(s):]`);
    for (const post of tweet.threadPosts) {
      lines.push("");
      lines.push(post.text);
    }
  }

  lines.push(`--- end tweet ---`);

  return lines.join("\n");
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
