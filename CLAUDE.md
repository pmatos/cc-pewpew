# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

cc-pewpew is a desktop GUI (Electron + TypeScript + React) for launching, monitoring, and visualizing Claude Code sessions with embedded terminals across git projects. See @PLAN.md for full architecture and implementation phases.

## Stack

- **Runtime:** Electron (main + renderer + preload)
- **Language:** TypeScript (strict)
- **Frontend:** React + Zustand for state management
- **Build:** electron-vite (Vite for renderer, tsc for main/preload)
- **Test:** Vitest
- **Lint:** ESLint
- **Format:** Prettier

## Commands

- `npm run dev` — start in development mode
- `npm run build` — production build
- `npx tsc --noEmit` — type-check without emitting
- `npx eslint .` — lint
- `npx prettier --write .` — format all files
- `npx vitest run` — run tests
- `npx vitest run <path>` — run a single test file

## Code Style

- Comments sparingly — only on complex logic
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Prefer editing existing files over creating new ones

## Implementation

The project follows a phased plan in PLAN.md (v2). Phases R1-R6 refactor from external Ghostty windows to embedded xterm.js terminals with tmux persistence. Read the relevant phase before starting work.

## Architecture (summary)

Three-process Electron structure:

- `src/main/` — Electron main process (pty-manager, session manager, hook server, project scanner)
- `src/preload/` — secure IPC bridge (contextBridge)
- `src/renderer/` — React frontend (sidebar, canvas with xterm.js thumbnails, detail pane, status bar)
- `src/shared/` — shared TypeScript types

Terminal stack: xterm.js (renderer) + node-pty (main) + tmux (persistence).

User data stored in `~/.cc-pewpew/` (config, sessions, IPC socket, hooks).
