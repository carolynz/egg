# Egg (TypeScript)

Two-repo architecture: this repo is the **code** (shell, brain wrapper, senses). The **data** lives in `egg-memory/` (SOUL.md, MEMORY.md, people/, goals.yaml, daily/).

## Architecture

- **Shell** (`src/shell/`) — polls iMessage chat.db, sends replies via BlueBubbles or AppleScript
- **Brain** (`src/brain/`) — spawns `claude -p` (or `codex -p`) as subprocess, running in EGG_MEMORY_DIR so it reads CLAUDE.md automatically
- **Senses** (`src/senses/`) — intake pipelines that update egg-memory files
- **CLI** (`src/index.ts`) — `egg serve`, `egg nudge`, `egg sense`, `egg status`

## Commands

```bash
npm run build          # tsc → dist/
npm run dev -- serve   # run via tsx (no build needed)
egg serve --bb-only    # poll loop, BlueBubbles only
egg nudge --dry-run    # preview nudge decision
egg sense daily        # generate daily digest
egg status             # show config + pending nudges
```

## Key Design Decisions

- No Anthropic SDK — brain is just a subprocess call to claude/codex CLI
- Synchronous SQLite reads (better-sqlite3) — perfect for poll loop
- State persisted as JSON in egg-memory/.egg-state.json
- Early save pattern: persist ROWIDs before brain call to prevent duplicate replies
- Multi-message: each `\n` in brain reply becomes a separate iMessage

## Workflow

- **Run `npm run build` after code changes** to verify TypeScript compiles cleanly.
- **Always commit at the end of every session.** After making any changes, run `npm run build`, stage all modified files, and commit with a descriptive message. Never leave uncommitted work.
