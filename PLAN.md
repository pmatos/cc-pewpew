# cc-pewpew — Project Plan (v2)

A desktop GUI for launching, monitoring, and visualizing Claude Code sessions
with embedded terminals across your git projects.

## Vision

A single window where you see all your `~/dev` projects, right-click to spawn
Claude Code sessions (each in its own git worktree + tmux session), and watch
a live dashboard of terminal thumbnails grouped by project — with clear
indicators when a session needs your attention. Click any thumbnail to open
the full interactive terminal inline.

```
┌─────────────────────────────────────────────────────────────────────┐
│  cc-pewpew                                                    ─ □ x │
├────────────┬────────────────────────────────────────────────────────┤
│ Projects   │  Session Canvas (zoomable / pannable)                 │
│            │                                                       │
│ ▼ cc-pewpew│  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐              │
│   session-1│  ╎ cc-pewpew cluster          [blue]  ╎              │
│   session-2│  ╎ ┌─────────┐ ┌─────────┐           ╎              │
│ ▼ webengine│  ╎ │ ████████│ │ ████████│           ╎              │
│   session-3│  ╎ │ ● run   │ │ ⚠ input │           ╎              │
│ ▶ dotfiles │  ╎ └─────────┘ └─────────┘           ╎              │
│            │  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘              │
│  [Setup]   │                                                       │
│ + New repo │  Click a card → full terminal opens:                  │
│            │  ┌─────────────────────────────────────┐              │
│            │  │ $ claude --dangerously-skip-perms   │              │
│            │  │ > Working on task...                │              │
│            │  │ █                                   │              │
│            │  └─────────────────────────────────────┘              │
├────────────┴────────────────────────────────────────────────────────┤
│ 5 sessions │ 3 running │ 1 needs input │ 1 completed               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Change: Embedded Terminals

### Why the change?

The v1 architecture spawned Ghostty as external OS windows and used Electron's
`desktopCapturer` to screenshot them. This broke on Wayland:

1. Ghostty opens as a separate window — users expect terminals inside the app
2. `desktopCapturer` triggers a "Share Screen" portal dialog on Wayland
3. Window focus required compositor-specific hacks (D-Bus, niri IPC, xdotool)

### New architecture: xterm.js + node-pty + tmux

```
┌──────────────────────────────────────┐
│     Electron Main Process             │
│                                      │
│  ┌──────────────────────────────┐    │
│  │   PTY Manager                │    │
│  │   (node-pty → tmux sessions) │    │
│  │   One tmux session per CC    │    │
│  │   session, managed by us     │    │
│  └──────────────────────────────┘    │
│                                      │
│  ┌──────────────────────────────┐    │
│  │   Session Manager            │    │
│  │   (worktrees, state, hooks)  │    │
│  └──────────────────────────────┘    │
│                                      │
│  ┌──────────────────────────────┐    │
│  │   Hook Server (unchanged)    │    │
│  └──────────────────────────────┘    │
└──────────────┬───────────────────────┘
               │ IPC (pty:data, pty:write, pty:resize)
┌──────────────▼───────────────────────┐
│     Renderer Process                  │
│                                      │
│  ┌──────┐ ┌───────────────────────┐  │
│  │Sidebar│ │ Canvas (overview)     │  │
│  │(tree) │ │  - xterm.js snapshots │  │
│  │      │ │  - status badges      │  │
│  │      │ │  - click → detail     │  │
│  │      │ ├───────────────────────┤  │
│  │      │ │ Detail Pane (overlay) │  │
│  │      │ │  - full xterm.js      │  │
│  │      │ │  - interactive I/O    │  │
│  └──────┘ └───────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │ Status Bar                     │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### Data flow

1. **User right-clicks project → "New session..."**
   - Session Manager creates a git worktree
   - PTY Manager creates a tmux session: `tmux new-session -d -s cc-pewpew-<id>`
   - Sends `claude --dangerously-skip-permissions` into the tmux session
   - Creates a node-pty process that attaches to tmux: `tmux attach-session -t cc-pewpew-<id>`
   - PTY data flows to renderer via IPC → xterm.js renders it

2. **Canvas shows thumbnails**
   - Each session has an xterm.js instance (hidden when not in detail view)
   - Periodically: snapshot the xterm.js `<canvas>` via `canvas.toDataURL()`
   - Thumbnails displayed in session cards — no `desktopCapturer`, no permissions

3. **User clicks a card → detail pane opens**
   - Canvas is replaced by a full-screen xterm.js terminal overlay
   - The xterm.js instance is moved from hidden to visible and gets focus
   - User interacts directly — typing, scrolling, selecting text
   - Press Escape or a back button → returns to canvas overview

4. **CC hook fires → status updates**
   - Same hook server as v1 (Unix socket, notify.sh)
   - `Stop` hook → card gets pulsing yellow border highlight
   - `SessionEnd` → cleanup dialog

5. **App closes and reopens**
   - tmux sessions persist — Claude Code keeps running
   - On restart: discover existing tmux sessions via `tmux list-sessions`
   - Reattach node-pty to each, replay scrollback via `tmux capture-pane`

### What stays the same from v1

- Project scanner, config, hook server, hook installer — unchanged
- Sidebar project tree, context menus — unchanged
- Zustand stores, status bar, edge indicators — unchanged
- Cluster layout, zoom/pan canvas — unchanged (cards still group by project)
- Worktree cleanup dialog — unchanged
- Tray icon — updated to show app instead of focus external window
- Notifications — updated to open detail pane instead of focus external window

### What gets replaced

| v1 (Ghostty)                           | v2 (Embedded)                        |
| -------------------------------------- | ------------------------------------ |
| `spawn('ghostty', ...)`                | `node-pty` → `tmux attach-session`   |
| `desktopCapturer.getSources()`         | `xterm.js canvas.toDataURL()`        |
| `window-focus.ts` (D-Bus/niri/xdotool) | **deleted** — terminal is inline     |
| `window-capture.ts`                    | **replaced** — canvas snapshots      |
| `ghosttyClass` in Session type         | **replaced** with `tmuxSession` name |
| Click card → focus OS window           | Click card → open detail pane        |

---

## Technology Stack

- **Runtime:** Electron (main + renderer + preload)
- **Language:** TypeScript (strict)
- **Frontend:** React + Zustand
- **Build:** electron-vite
- **Terminal:** xterm.js (renderer) + node-pty (main) + tmux (persistence)
- **Test:** Vitest
- **Lint/Format:** ESLint + Prettier

### Key dependencies to add

- `node-pty` — pseudo-terminal for main process
- `@xterm/xterm` — terminal renderer (v5, scoped package)
- `@xterm/addon-fit` — auto-resize terminal to container
- `electron-rebuild` — rebuild native modules for Electron

---

## Implementation Phases

Each phase is a single Claude Code session with verification steps.

### Phase R1: Install xterm.js + node-pty, create PTY manager

**Input:** Current v1 codebase.
**Do:**

- Install `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`
- Add `electron-rebuild` postinstall script or use `electron-vite` native module support
- Create `src/main/pty-manager.ts`:
  - `createPty(sessionId, cwd)` — spawns `tmux new-session -d -s cc-pewpew-<id> -c <cwd>` then `node-pty` attaches via `tmux attach-session -t cc-pewpew-<id>`
  - Sends `claude --dangerously-skip-permissions\n` into the tmux session after creation
  - `writePty(sessionId, data)` — writes to the pty
  - `resizePty(sessionId, cols, rows)` — resizes the pty
  - `destroyPty(sessionId)` — kills tmux session + pty
  - `discoverSessions()` — runs `tmux list-sessions` to find existing `cc-pewpew-*` sessions
  - `reattachPty(sessionId)` — reconnects to an existing tmux session
  - Data from pty → emitted via IPC `pty:data` to renderer
- Add IPC handlers in `src/main/index.ts`: `pty:write`, `pty:resize`, `pty:create`, `pty:destroy`
- Update preload with pty API methods
- Update `env.d.ts` types

**Verify:**

```bash
npx tsc --noEmit
npx electron-vite build
# Manual: launch app, create a session, check main process console for pty data
```

---

### Phase R2: Create Terminal component and detail pane

**Input:** PTY manager from Phase R1.
**Do:**

- Create `src/renderer/components/Terminal.tsx`:
  - Props: `sessionId`, `visible`
  - Creates `@xterm/xterm` Terminal instance, attaches to a div
  - Uses `@xterm/addon-fit` for auto-resize
  - Subscribes to `pty:data` IPC events for this session → `terminal.write(data)`
  - On user input: `terminal.onData(data => window.api.ptyWrite(sessionId, data))`
  - On resize: `fitAddon.fit()` → `window.api.ptyResize(sessionId, cols, rows)`
- Create `src/renderer/components/DetailPane.tsx`:
  - Full-screen overlay that replaces the canvas area
  - Shows header with session name + back button
  - Renders `<Terminal sessionId={id} visible={true} />`
  - Escape key or back button → closes detail pane
- Update `src/renderer/App.tsx`:
  - Add `activeSession: string | null` state
  - When set: show `<DetailPane>` instead of `<SessionCanvas>`
  - Pass `onOpenSession` callback to SessionCanvas → SessionCard click
- Style the detail pane and terminal container

**Verify:**

```bash
npm run dev
# Create a session → click the card → full terminal appears
# Type in the terminal → Claude Code responds
# Press Escape → returns to canvas
npx tsc --noEmit
```

---

### Phase R3: Replace session spawning with PTY manager

**Input:** Terminal component from Phase R2.
**Do:**

- Update `src/main/session-manager.ts`:
  - Replace `spawn('ghostty', ...)` with `ptyManager.createPty(id, worktreePath)`
  - Remove Ghostty check (`which ghostty`)
  - Remove `ghosttyClass` from session creation
  - Update `killSession` to use `ptyManager.destroyPty(id)`
- Update `src/shared/types.ts`:
  - Replace `ghosttyClass: string` with `tmuxSession: string` in Session interface
- Remove `src/main/window-focus.ts` — no longer needed
- Update `src/main/tray.ts` — "needs input" items: show app + open detail pane instead of focusing window
- Update `src/main/notifications.ts` — click notification: show app + open detail pane
- Update preload: remove `focusSession`, add `openDetailPane(sessionId)` or handle in renderer
- Update SessionCard: click → opens detail pane (not external window focus)
- Remove `ghosttyClass` references from all files

**Verify:**

```bash
npm run dev
# Create session → terminal starts in embedded pane
# No Ghostty window appears
# No "Share Screen" dialog
# Kill session → tmux session destroyed
npx tsc --noEmit
```

---

### Phase R4: Replace desktopCapturer with xterm.js canvas snapshots

**Input:** Embedded terminals from Phase R3.
**Do:**

- Rewrite `src/main/window-capture.ts` → `src/renderer/thumbnail-capture.ts` (moves to renderer):
  - Each session has a hidden xterm.js instance that receives pty data
  - Periodically (every 3s): call `canvas.toDataURL()` on each xterm.js canvas
  - Store snapshots in sessions store `thumbnails` (same as before)
- Or simpler approach: use a single visible xterm.js per session, snapshot it when rendering the card
- Update SessionCard to display the xterm.js canvas snapshot as thumbnail
- Delete `src/main/window-capture.ts`
- Remove `desktopCapturer` import from anywhere
- Cards with `needs_input` status get a pulsing yellow border highlight (already exists from Phase 12)

**Verify:**

```bash
npm run dev
# Create session → card shows live terminal thumbnail
# No "Share Screen" dialog ever appears
# Thumbnail updates as Claude Code runs
# needs_input cards have pulsing highlight
npx tsc --noEmit
```

---

### Phase R5: Session persistence with tmux

**Input:** Working embedded terminals from Phase R4.
**Do:**

- Update `src/main/pty-manager.ts`:
  - On app startup: `tmux list-sessions` to find `cc-pewpew-*` sessions
  - For each found: create a node-pty that attaches to it
  - Replay scrollback: `tmux capture-pane -t <session> -p -S -5000` → feed into xterm.js
- Update `src/main/session-manager.ts`:
  - `restoreSessions()`: match persisted sessions with live tmux sessions
  - Sessions with a live tmux session → status `idle`
  - Sessions without a tmux session → status `dead`
- Update cleanup dialog:
  - "Delete worktree" also kills the tmux session
  - "Keep worktree" keeps the tmux session alive

**Verify:**

```bash
npm run dev
# Create a session, close the app
# Verify tmux session still exists: tmux list-sessions | grep cc-pewpew
npm run dev
# Session should reappear with status "idle", terminal content restored
# Click card → full terminal with scrollback history
npx tsc --noEmit
```

---

### Phase R6: Cleanup and polish

**Input:** Full persistence from Phase R5.
**Do:**

- Delete `src/main/window-focus.ts`
- Delete old `src/main/window-capture.ts` if not already gone
- Remove all `ghosttyClass` references
- Remove `desktopCapturer` from CSP in `index.html` if present
- Update CLAUDE.md to reflect new architecture
- Ensure `electron-rebuild` runs correctly in CI/build
- Test edge cases: tmux not installed (show error), multiple sessions on same project, rapid session creation

**Verify:**

```bash
npx tsc --noEmit
npx eslint .
npm run dev
# Full workflow: setup project, create sessions, view thumbnails, open terminal,
# close app, reopen, sessions restored, cleanup worktrees
```

---

## Key Design Decisions

### Why manage tmux ourselves instead of using `claude --tmux`?

Claude Code's `--tmux` flag has a known race condition bug (GitHub #27562) and
uses opaque session naming we can't control. By managing tmux directly:

- We control session names (`cc-pewpew-<id>`)
- We can reliably attach/detach/list sessions
- We avoid the `--tmux` race condition
- We run `claude` inside our tmux session as a regular command

### Why xterm.js canvas snapshots for thumbnails?

xterm.js renders to a `<canvas>` element. `canvas.toDataURL()` gives us a PNG
screenshot of exactly what the terminal looks like — no OS permissions, no
portal dialogs, works identically on X11 and Wayland. The result is visually
identical to a window screenshot.

### Why a detail pane overlay instead of inline terminal in canvas?

The canvas uses CSS `transform: scale(zoom)` with mouse wheel zoom and
click-drag pan. An interactive terminal inside the transformed canvas would
fight with:

- Mouse wheel (zoom vs terminal scroll)
- Click-drag (pan vs text selection)
- Keyboard input (shortcuts vs terminal input)

The detail pane is a separate layer that replaces the canvas when active,
giving the terminal clean, uncontested input handling.

### Why tmux for persistence?

Without tmux, closing cc-pewpew kills all Claude Code sessions. With tmux:

- Sessions survive app restarts
- Scrollback history is preserved
- Multiple cc-pewpew instances could share sessions (future)
- Claude Code continues working even when the app is closed

---

## Directory Structure (updated)

```
cc-pewpew/
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── LICENSE
├── PLAN.md                          # This file
├── CLAUDE.md
├── src/
│   ├── main/
│   │   ├── index.ts                 # Entry: create window, start services
│   │   ├── pty-manager.ts           # NEW: node-pty + tmux session management
│   │   ├── project-scanner.ts       # Find git repos (unchanged)
│   │   ├── session-manager.ts       # Session lifecycle (updated: no Ghostty)
│   │   ├── hook-server.ts           # Unix socket JSON-RPC (unchanged)
│   │   ├── hook-installer.ts        # Install CC hooks (unchanged)
│   │   ├── config.ts                # User preferences (unchanged)
│   │   ├── tray.ts                  # System tray (updated: no window focus)
│   │   └── notifications.ts         # Desktop notifications (updated)
│   ├── preload/
│   │   └── index.ts                 # IPC bridge (updated: pty API)
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx                  # Root layout (updated: detail pane state)
│   │   ├── components/
│   │   │   ├── ProjectTree.tsx      # Sidebar (unchanged)
│   │   │   ├── SessionCanvas.tsx    # Zoomable canvas (unchanged)
│   │   │   ├── SessionCard.tsx      # Card (updated: click → detail pane)
│   │   │   ├── SessionCluster.tsx   # Cluster grouping (unchanged)
│   │   │   ├── Terminal.tsx         # NEW: xterm.js terminal component
│   │   │   ├── DetailPane.tsx       # NEW: full terminal overlay
│   │   │   ├── StatusBar.tsx        # Status bar (unchanged)
│   │   │   ├── EdgeIndicators.tsx   # Edge dots (unchanged)
│   │   │   └── ContextMenu.tsx      # Menus (unchanged)
│   │   ├── stores/
│   │   │   ├── projects.ts          # (unchanged)
│   │   │   ├── sessions.ts          # (updated: thumbnail from canvas)
│   │   │   └── canvas.ts            # (unchanged)
│   │   └── styles/
│   │       └── global.css           # (updated: terminal + detail pane styles)
│   └── shared/
│       └── types.ts                 # (updated: tmuxSession replaces ghosttyClass)
├── hooks/
│   └── notify.sh                    # CC hook script (unchanged)
└── resources/
    └── icons/
```

---

## Files deleted in v2

- `src/main/window-capture.ts` — replaced by xterm.js canvas snapshots
- `src/main/window-focus.ts` — no external windows to focus

---

## Open Questions / Future Work

- **Orchestration mode**: Send prompts to CC sessions programmatically (not in v2)
- **Session templates**: Pre-defined prompts for common tasks
- **Multi-monitor**: Canvas spans across monitors?
- **Log streaming**: Parse CC transcript alongside terminal view?
- **Cluster physics**: Force-directed auto-layout vs manual placement?
- **Shared tmux sessions**: Multiple cc-pewpew instances viewing the same sessions?
