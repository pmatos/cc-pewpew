# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

pewpew is a desktop GUI (Electron + TypeScript + React) for launching, monitoring, and visualizing Claude Code sessions with embedded terminals across git projects. See @PLAN.md for full architecture and implementation phases.

## Stack

- **Runtime:** Electron (main + renderer + preload)
- **Language:** TypeScript (strict)
- **Frontend:** React + Zustand for state management
- **Build:** electron-vite (Vite for renderer, tsc for main/preload)
- **Test:** Vitest
- **Lint:** ESLint
- **Format:** Prettier

## Commands

- `npm run dev` — start in development mode (hot-reload)
- `npm run dev:debug` — build + launch with CDP on port 9229 (for MCP testing)
- `npm run build` — production build
- `npx tsc --noEmit` — type-check without emitting
- `npx eslint .` — lint
- `npx prettier --write .` — format all files
- `npx vitest run` — run tests
- `npx vitest run <path>` — run a single test file

## Testing with Chrome DevTools Protocol

`npm run dev:debug` builds and launches with `--remote-debugging-port=9229`. This enables CDP-based testing:

To take a screenshot and view it:

```bash
node -e "
const ws = require('ws');
const fs = require('fs');
const pageId = JSON.parse(require('child_process').execSync('curl -s http://127.0.0.1:9229/json/list'))[0].id;
const socket = new ws('ws://127.0.0.1:9229/devtools/page/' + pageId);
socket.on('open', () => socket.send(JSON.stringify({id:1, method:'Page.captureScreenshot', params:{format:'png'}})));
socket.on('message', (d) => { const m = JSON.parse(d.toString()); if(m.result?.data) { fs.writeFileSync('/tmp/pewpew-screenshot.png', Buffer.from(m.result.data,'base64')); socket.close(); }});
"
```

Then `Read /tmp/pewpew-screenshot.png` to view the UI visually.

### Automated UI debugging workflow

Port 9229 may conflict with pewpew's own tmux server. If so, use a different port:

```bash
npx electron-vite build && npx electron --remote-debugging-port=9333 .
```

To interact with the app via CDP (click elements, take timed screenshots):

```js
const WebSocket = require('ws')
const fs = require('fs')
const WS_URL = 'ws://127.0.0.1:9333/devtools/page/<PAGE_ID>'
const socket = new WebSocket(WS_URL)
let id = 0
const pending = {}
function send(method, params) {
  const i = ++id
  return new Promise((resolve) => {
    pending[i] = resolve
    socket.send(JSON.stringify({ id: i, method, params }))
  })
}
socket.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (pending[m.id]) {
    pending[m.id](m)
    delete pending[m.id]
  }
})
```

Useful CDP methods:

- `Runtime.evaluate` — run JS in the page (query DOM, check state)
- `Page.captureScreenshot` — take PNG screenshot
- `Input.dispatchMouseEvent` — click at coordinates (send mousePressed + mouseReleased)

When debugging visual issues, **always use this approach first** rather than asking the user to test manually. Build, launch with CDP, take screenshots at key moments, and verify the fix yourself. Use `Runtime.evaluate` to query DOM element positions, then `Input.dispatchMouseEvent` to click them.

## Code Style

- Comments sparingly — only on complex logic
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Prefer editing existing files over creating new ones

## Supported agents

- **Claude Code** (`claude`) — default. Uses `--continue` to resume. Hooks installed at `<worktree>/.claude/settings.local.json`.
- **OpenAI Codex** (`codex`) — opt-in per session. Resume uses `codex resume <session_id>` (the `agentSessionId` is captured from the `SessionStart` hook payload). Hooks installed at `<worktree>/.codex/hooks.json` and gated behind `[features].codex_hooks = true` in `~/.codex/config.toml`, which pewpew enables idempotently on first codex session install.

The default tool is configurable via `defaultTool` in `~/.config/pewpew/config.json`. Per-session selection is exposed in the "New session" dialog. Both `claude` and `codex` must be in `PATH` (locally and on every remote host where the corresponding tool is selected).

## Implementation

The project follows PLAN.md (v2). Terminals are embedded via xterm.js + node-pty + tmux (no external windows). Sessions persist across app restarts.

## Architecture (summary)

Three-process Electron structure:

- `src/main/` — Electron main process (pty-manager, session manager, hook server, project scanner)
- `src/preload/` — secure IPC bridge (contextBridge)
- `src/renderer/` — React frontend (sidebar, canvas with xterm.js thumbnails, detail pane, status bar)
- `src/shared/` — shared TypeScript types

Terminal stack: xterm.js (renderer) + node-pty (main) + tmux (persistence).

User data stored in `~/.config/pewpew/` (config, sessions, IPC socket, hooks).
