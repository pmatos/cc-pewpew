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

- `npm run dev` — start in development mode (CDP enabled on port 9222)
- `npm run build` — production build
- `npx tsc --noEmit` — type-check without emitting
- `npx eslint .` — lint
- `npx prettier --write .` — format all files
- `npx vitest run` — run tests
- `npx vitest run <path>` — run a single test file

## Testing with Chrome DevTools Protocol

`npm run dev` starts with `--remote-debugging-port=9222`. This enables the `chrome-devtools` MCP server to connect and interact with the running app:

- `mcp__chrome-devtools__take_screenshot` — capture the current UI state
- `mcp__chrome-devtools__click` — click elements
- `mcp__chrome-devtools__fill` — fill form inputs
- `mcp__chrome-devtools__take_snapshot` — get the accessibility tree
- `mcp__chrome-devtools__evaluate_script` — run JS in the renderer

Use this for visual verification, automated testing, and UI debugging during development.

## Code Style

- Comments sparingly — only on complex logic
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Prefer editing existing files over creating new ones

## Implementation

The project follows PLAN.md (v2). Terminals are embedded via xterm.js + node-pty + tmux (no external windows). Sessions persist across app restarts.

## Architecture (summary)

Three-process Electron structure:

- `src/main/` — Electron main process (pty-manager, session manager, hook server, project scanner)
- `src/preload/` — secure IPC bridge (contextBridge)
- `src/renderer/` — React frontend (sidebar, canvas with xterm.js thumbnails, detail pane, status bar)
- `src/shared/` — shared TypeScript types

Terminal stack: xterm.js (renderer) + node-pty (main) + tmux (persistence).

User data stored in `~/.config/cc-pewpew/` (config, sessions, IPC socket, hooks).
