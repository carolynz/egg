import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { STATE_FILE } from "../config.js";

export interface ShellState {
  lastRowid: number;
  seenRowids: number[];
  history: { role: string; content: string }[];
  pendingMessage: string | null;
}

const DEFAULTS: ShellState = {
  lastRowid: 0,
  seenRowids: [],
  history: [],
  pendingMessage: null,
};

export function loadState(): ShellState {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveState(state: ShellState): void {
  // Prune history to last 40
  state.history = state.history.slice(-40);
  // Prune seenRowids to last 50
  if (state.seenRowids.length > 50) {
    state.seenRowids = state.seenRowids.slice(-50);
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
