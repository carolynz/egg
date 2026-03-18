/**
 * Motivation video selector — picks a rotating video for the morning nudge.
 *
 * Reads from data/motivation-videos.json, rotates through categories,
 * and tracks which videos have been sent to avoid repeats until the
 * full list cycles.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const VIDEOS_PATH = join(__dirname, "../../data/motivation-videos.json");

export interface MotivationVideo {
  url: string;
  title: string;
  category: string;
  duration_min: number;
  times_sent: number;
}

interface VideoConfig {
  categories: string[];
  preference_notes: string;
  videos: MotivationVideo[];
}

function loadConfig(): VideoConfig {
  const raw = readFileSync(VIDEOS_PATH, "utf-8");
  return JSON.parse(raw) as VideoConfig;
}

function saveConfig(config: VideoConfig): void {
  writeFileSync(VIDEOS_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Pick the next motivation video, rotating through categories.
 *
 * Strategy:
 * 1. Determine which category is "next" by round-robin (least-recently-sent category).
 * 2. Within that category, pick the video with the lowest times_sent.
 * 3. Increment times_sent and persist.
 *
 * NOTE: Check preference_notes in the video config for user feedback on
 * category mix. If the user requests more/less of a category, the caller
 * should respect that when building the nudge prompt.
 */
export function pickMotivationVideo(): MotivationVideo | null {
  if (!existsSync(VIDEOS_PATH)) {
    console.warn("[motivation] data/motivation-videos.json not found");
    return null;
  }

  const config = loadConfig();
  if (config.videos.length === 0) return null;

  const { categories, videos } = config;

  // Find the category with the lowest total times_sent (round-robin effect)
  const categoryTotals = new Map<string, number>();
  for (const cat of categories) {
    categoryTotals.set(cat, 0);
  }
  for (const v of videos) {
    const cur = categoryTotals.get(v.category) ?? 0;
    categoryTotals.set(v.category, cur + v.times_sent);
  }

  // Sort categories by total sends (ascending) to rotate evenly
  const sortedCategories = [...categoryTotals.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([cat]) => cat);

  // Try each category in order until we find a video
  for (const category of sortedCategories) {
    const candidates = videos
      .filter((v) => v.category === category)
      .sort((a, b) => a.times_sent - b.times_sent);

    if (candidates.length > 0) {
      const picked = candidates[0];

      // Update times_sent in the config
      const idx = videos.findIndex((v) => v.url === picked.url);
      if (idx !== -1) {
        config.videos[idx].times_sent += 1;
        saveConfig(config);
      }

      return picked;
    }
  }

  return null;
}

/** Format a video pick as a nudge-friendly string */
export function formatVideoForNudge(video: MotivationVideo): string {
  return `${video.title} (${video.duration_min} min) ${video.url}`;
}
