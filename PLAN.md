# cc-pewpew — Project Plan

A desktop GUI for launching, monitoring, and visualizing Claude Code sessions
running in Ghostty terminals across your git projects.

## Vision

A single window where you see all your `~/dev` projects, right-click to spawn
Claude Code sessions (each in its own git worktree + Ghostty window), and watch
a live dashboard of thumbnails grouped by project — with clear indicators when a
session needs your attention.

```
┌─────────────────────────────────────────────────────────────────────┐
│  cc-pewpew                                                    ─ □ x │
├────────────┬────────────────────────────────────────────────────────┤
│ Projects   │  Session Canvas (zoomable / pannable)                 │
│            │                                                       │
│ ▼ cc-pewpew│  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐              │
│   session-1│  ╎ cc-pewpew cluster          [blue]  ╎              │
│   session-2│  ╎ ┌─────────┐ ┌─────────┐           ╎              │
│ ▼ webengine│  ╎ │ thumb-1 │ │ thumb-2 │           ╎              │
│   session-3│  ╎ │ ● run   │ │ ⚠ input │           ╎              │
│ ▶ dotfiles │  ╎ └─────────┘ └─────────┘           ╎              │
│            │  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘              │
│  [Setup]   │                                                       │
│ + New repo │  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐              │
│            │  ╎ webengine cluster        [green]   ╎              │
│            │  ╎ ┌─────────┐ ┌─────────┐            ╎              │
│            │  ╎ │ thumb-3 │ │ thumb-4 │            ╎              │
│            │  ╎ │ ✓ done  │ │ ● run   │            ╎              │
│            │  ╎ └─────────┘ └─────────┘            ╎              │
│            │  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘              │
├────────────┴────────────────────────────────────────────────────────┤
│ 5 sessions │ 3 running │ 1 needs input │ 1 completed               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Technology Choice: Electron + TypeScript + React

**Why Electron?**

- The reference project (Collaborator) proves this exact UI pattern works well in
  Electron.
- Web tech (HTML/CSS/Canvas) makes the zoomable thumbnail canvas, dark theme,
  and animations straightforward.
- Electron's `desktopCapturer` API captures window thumbnails on **both X11 and
  Wayland** without external tools — it returns `NativeImage` objects directly.
- `child_process` handles Ghostty spawning; Node.js `net` module handles the
  Unix socket server for hooks.
- Mature ecosystem: React for UI, Zustand for state, CSS for the dark aesthetic.

**Alternatives considered:**

| Option | Verdict |
|--------|---------|
| Python + Qt (PySide6) | Viable but harder to achieve the polished dark canvas UI. Window capture requires manual compositor detection. |
| Tauri v2 | Lighter than Electron but less mature for complex window management. |
| Pure web (localhost) | Loses native window management, `desktopCapturer`, and tray integration. |

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │     Electron Main Process     │
                        │                              │
                        │  ┌────────────────────────┐  │
                        │  │   Session Manager      │  │
                        │  │   (spawn ghostty,      │  │
                        │  │    track PIDs,          │  │
                        │  │    manage worktrees)    │  │
                        │  └────────────────────────┘  │
                        │                              │
                        │  ┌────────────────────────┐  │
    CC hooks ──────────►│  │   Hook Server           │  │
    (Unix socket)       │  │   (JSON-RPC over        │  │
                        │  │    Unix domain socket)  │  │
                        │  └────────────────────────┘  │
                        │                              │
                        │  ┌────────────────────────┐  │
                        │  │   Project Scanner       │  │
                        │  │   (find git repos in    │  │
                        │  │    configured dirs)     │  │
                        │  └────────────────────────┘  │
                        │                              │
                        │  ┌────────────────────────┐  │
                        │  │   Window Capture        │  │
                        │  │   (desktopCapturer for  │  │
                        │  │    Ghostty thumbnails)  │  │
                        │  └────────────────────────┘  │
                        └──────────────┬───────────────┘
                                       │ IPC
                        ┌──────────────▼───────────────┐
                        │     Renderer Process          │
                        │                              │
                        │  ┌──────┐ ┌───────────────┐  │
                        │  │Sidebar│ │ Session Canvas │  │
                        │  │(tree) │ │ (zoom/pan,    │  │
                        │  │      │ │  thumbnails,   │  │
                        │  │      │ │  status cards) │  │
                        │  └──────┘ └───────────────┘  │
                        │  ┌────────────────────────┐  │
                        │  │ Status Bar              │  │
                        │  └────────────────────────┘  │
                        └──────────────────────────────┘

    Ghostty windows (separate OS windows, one per CC session):
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ ghostty  │ │ ghostty  │ │ ghostty  │
    │ claude   │ │ claude   │ │ claude   │
    │ -w feat  │ │ -w fix   │ │ -w test  │
    └──────────┘ └──────────┘ └──────────┘
```

### Data Flow

1. **User right-clicks project → "New session..."**
   - Session Manager creates a git worktree (`git worktree add`)
   - Spawns `ghostty --class=cc-pewpew-<id> --title="<project>/<worktree>" -e claude -w <name>`
   - Installs CC hooks pointing at our Unix socket (if not already installed)
   - Registers session in state (PID, worktree path, project, status=running)

2. **CC hook fires (e.g., Stop → session needs input)**
   - Hook bash script reads event JSON from stdin
   - Sends JSON-RPC message to `~/.cc-pewpew/ipc.sock` via `nc -U` or `socat`
   - Hook Server receives it, updates session state
   - Emits IPC event to renderer → UI updates status indicator

3. **Periodic thumbnail capture (every 2-5 seconds)**
   - Main process calls `desktopCapturer.getSources({ types: ['window'] })`
   - Matches Ghostty windows by title or class
   - Sends thumbnail `NativeImage` to renderer via IPC
   - Session cards update their preview image

4. **User clicks thumbnail → Ghostty window is focused**
   - On X11: `xdotool windowactivate <wid>`
   - On Wayland: compositor-specific (e.g., Hyprland `hyprctl dispatch focuswindow pid:<pid>`)
   - Fallback: Ghostty D-Bus `present-surface`

---

## Component Breakdown

### 1. Project Scanner (`src/main/project-scanner.ts`)

- Scans configured root directories (configurable, default: `~/dev`) for git repositories
- Detects repos by presence of `.git` directory
- Returns list of `{ name, path, branches, worktrees, setupState }` objects
- Watches for filesystem changes (new/removed repos) via `chokidar` or `fs.watch`
- Supports creating new repos: `git init <path>`

**Setup state** — each repo is in one of two states:

| State | Meaning | Sidebar display |
|-------|---------|-----------------|
| `unsetup` | Git repo found, but no cc-pewpew hooks installed | Greyed out, shows `[Setup]` button |
| `ready` | Hooks installed, repo is launchable | Normal display, right-click → "New session..." |

**Setup flow** (when user clicks `[Setup]` or right-clicks → "Setup for cc-pewpew"):
1. Create `.claude/settings.local.json` with cc-pewpew hook configuration (or
   merge hooks into an existing `settings.local.json` without clobbering other
   settings)
2. Ensure `.claude/settings.local.json` is listed in the project's `.gitignore`
   (append if missing, create `.gitignore` if it doesn't exist)
3. Mark project as `ready` in the UI

We use `settings.local.json` (not `settings.json`) because:
- It's project-local and user-specific — not committed to the repo
- It won't interfere with team/shared CC settings in `settings.json`
- CC merges `settings.local.json` on top of `settings.json` at runtime

### 2. Session Manager (`src/main/session-manager.ts`)

- **Creates sessions:**
  - `git -C <repo> worktree add .claude/worktrees/<name> -b cc-pewpew/<name>`
  - Spawns Ghostty: `ghostty --class=cc-pewpew-<session-id> --title="<project>/<name>" --gtk-single-instance=false -e claude --dangerously-skip-permissions -w <name>`
  - Tracks the child process PID
- **Monitors sessions:**
  - Detects when Ghostty process exits (child process `exit` event)
  - On session end: prompts user with a dialog — "Session ended. Clean up
    worktree `<name>`?" with options: **Delete worktree**, **Keep worktree**,
    **Keep and open in file manager**
- **Session state:** `{ id, projectPath, worktreeName, worktreePath, pid, ghosttyClass, status, lastActivity, hookEvents[] }`

### 3. Hook Server (`src/main/hook-server.ts`)

- Unix domain socket server at `~/.cc-pewpew/ipc.sock`
- Newline-delimited JSON-RPC 2.0 protocol (same as Collaborator)
- Breadcrumb file at `~/.cc-pewpew/socket-path` for hook scripts to discover
- Methods:
  - `session.start` — CC session started (from `SessionStart` hook)
  - `session.stop` — CC stopped, waiting for input (from `Stop` hook)
  - `session.activity` — file touched (from `PostToolUse` hook)
  - `session.end` — CC session ended (from `SessionEnd` hook)
  - `session.notification` — CC notification (from `Notification` hook)
  - `ping` — health check

### 4. Hook Installer (`src/main/hook-installer.ts`)

Installs Claude Code hooks per-project in `.claude/settings.local.json`. This
file is user-local (not committed) and CC merges it on top of `settings.json`.
The installer also ensures `settings.local.json` is in `.gitignore`.

The hook script:

```bash
#!/usr/bin/env bash
# ~/.cc-pewpew/hooks/notify.sh
# Called by Claude Code hooks — reads event JSON from stdin,
# forwards to cc-pewpew orchestrator via Unix socket.

set -euo pipefail

INPUT=$(cat)
SOCKET=$(cat ~/.cc-pewpew/socket-path 2>/dev/null || echo "")
if [ -z "$SOCKET" ] || [ ! -S "$SOCKET" ]; then
  exit 0  # cc-pewpew not running, silently ignore
fi

EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Map CC hook events to our RPC methods
case "$EVENT_NAME" in
  SessionStart)   METHOD="session.start" ;;
  Stop)           METHOD="session.stop" ;;
  PostToolUse)    METHOD="session.activity" ;;
  SessionEnd)     METHOD="session.end" ;;
  Notification)   METHOD="session.notification" ;;
  *)              exit 0 ;;
esac

PAYLOAD=$(jq -n \
  --arg method "$METHOD" \
  --argjson params "$INPUT" \
  '{"jsonrpc":"2.0","method":$method,"params":$params,"id":null}')

echo "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" 2>/dev/null || true
```

Hooks configuration installed in `.claude/settings.local.json` (merged with any
existing content — only the `hooks` key is touched, other keys are preserved):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.cc-pewpew/hooks/notify.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.cc-pewpew/hooks/notify.sh" }] }],
    "PostToolUse": [{
      "matcher": "Read|Write|Edit|Bash",
      "hooks": [{ "type": "command", "command": "~/.cc-pewpew/hooks/notify.sh" }]
    }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.cc-pewpew/hooks/notify.sh" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "~/.cc-pewpew/hooks/notify.sh" }] }]
  }
}
```

The installer also appends `.claude/settings.local.json` to `.gitignore` if not
already present. This ensures hooks stay local and don't pollute the repo.

### 5. Window Capture (`src/main/window-capture.ts`)

- Uses Electron's `desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 400, height: 300 } })`
- Matches sources by window title (which we control via `--title` flag)
- Runs on a configurable interval (default: 3 seconds)
- Sends `NativeImage` thumbnails to renderer via IPC
- Gracefully handles windows that are minimized or on other workspaces

**Fallback for when `desktopCapturer` doesn't work (some Wayland compositors):**
- X11: `maim --window $(xdotool search --class cc-pewpew-<id>) /tmp/thumb.png`
- Hyprland: `grimblast` or toplevel-export protocol
- Sway: `swaymsg -t get_tree` + `grim -g <geometry>`
- If all else fails: show a styled placeholder card with status text instead of a screenshot

### 6. Renderer UI (`src/renderer/`)

#### Sidebar — Project Tree (`ProjectTree.tsx`)
- Tree view of `~/dev` repos, expandable to show active sessions per project
- Right-click context menu: "New session...", "Open in file manager", "Create new repo"
- Sessions listed under their project with status icons
- Click session → focus its Ghostty window

#### Main Area — Session Canvas (`SessionCanvas.tsx`)
- Zoomable, pannable canvas (CSS transform based, like Collaborator)
- **Cluster-based grouping**: sessions from the same project are visually
  clustered together inside a dashed/subtle boundary with the project name as a
  label. Each cluster gets a unique accent color. Clusters auto-arrange using a
  simple force-directed or grid-pack layout, with manual drag-to-reposition.
- Zoom range: ~30% (overview of all clusters) to 100% (full-size thumbnails)
- Mouse wheel to zoom, click-drag to pan (on empty canvas), drag cluster to reposition
- Keyboard: Ctrl+0 to reset zoom, Ctrl+= / Ctrl+- to zoom

#### Session Card (`SessionCard.tsx`)
- Thumbnail image (from `desktopCapturer`)
- Header: project name / worktree name
- Status badge:
  - 🟢 **Running** — CC is actively working (between `SessionStart`/`PostToolUse` and `Stop`)
  - 🟡 **Needs input** — CC stopped, waiting for user (after `Stop` hook)
  - ⚫ **Idle** — Ghostty window exists but CC is not active
  - ✅ **Completed** — CC session ended (after `SessionEnd` hook)
  - 🔴 **Error** — Ghostty process crashed
- Last activity timestamp
- Click → focus Ghostty window
- Right-click → context menu (kill session, cleanup worktree, show logs)

#### Status Bar (`StatusBar.tsx`)
- Total sessions, running, needs input, completed counts
- Quick-jump buttons for sessions that need input

### 7. Persistence (`~/.cc-pewpew/`)

```
~/.cc-pewpew/
├── config.json              # User preferences (scan dirs, theme, zoom, etc.)
├── sessions.json            # Active session state (survives app restart)
├── ipc.sock                 # Unix domain socket for hook communication
├── socket-path              # Breadcrumb: absolute path to ipc.sock
└── hooks/
    └── notify.sh            # The hook script installed into CC settings
```

---

## Ghostty Integration Details

### Launching a Session

```bash
ghostty \
  --class=cc-pewpew-<session-id> \
  --title="<project-name>/<worktree-name>" \
  --gtk-single-instance=false \
  --working-directory=<worktree-path> \
  -e claude --dangerously-skip-permissions
```

Key flags:
- `--class`: Unique per-session, used for window identification and capture matching
- `--title`: Human-readable, shown in the session card header
- `--gtk-single-instance=false`: Each session gets its own Ghostty process (no reuse)
- `-e`: Run `claude` directly; Ghostty closes when `claude` exits

### Ghostty D-Bus Integration

Ghostty exposes `com.mitchellh.ghostty` on the session D-Bus (or custom name via
`--class`). Useful actions:

- `new-window` — could be used for multi-window scenarios
- Focus: D-Bus `present-surface` action to bring a window to front

Since each session uses a unique `--class`, their D-Bus names will differ, making
it possible to target specific sessions:

```bash
# Focus a specific session's Ghostty window via D-Bus
gdbus call --session \
  --dest=cc-pewpew-<session-id> \
  /cc-pewpew-<session-id> \
  org.gtk.Actions.Activate \
  string:"present-surface" "[]" "{}"
```

Note: The `--class` value must be a valid GApplication ID (reverse DNS with dots).
So actual IDs will be like `com.ccpewpew.session.<id>`.

---

## Claude Code Hook Events We Use

| Hook Event | Purpose | Key stdin fields |
|------------|---------|-----------------|
| `SessionStart` | Mark session as running | `session_id`, `cwd`, `source`, `model` |
| `Stop` | Mark session as "needs input" | `session_id`, `last_assistant_message` |
| `PostToolUse` | Track activity, update "last active" | `session_id`, `tool_name`, `tool_input` |
| `SessionEnd` | Mark session as completed | `session_id`, `reason` |
| `Notification` | Surface CC notifications in our UI | `session_id`, `message`, `notification_type` |

The `Stop` hook is the critical one — it fires whenever CC finishes a response
and is waiting for user input. This is how we know a session "needs attention."

The `Notification` hook with `notification_type: "permission_prompt"` tells us
when CC is asking for permission (relevant if not using `--dangerously-skip-permissions`).

---

## Implementation Phases

Each phase is designed to be completable in a single Claude Code session. Every
phase has a clear starting state, deliverables, and a way to verify it worked.

---

### Phase 1: Electron scaffold

**Input:** Empty repo with PLAN.md and LICENSE.
**Do:**
- Initialize Electron + TypeScript + React project using electron-vite
- Configure build tooling (Vite for renderer, tsc for main/preload)
- Set up the three-process structure: `src/main/index.ts`, `src/preload/index.ts`,
  `src/renderer/main.tsx` + `App.tsx` + `index.html`
- Add shared types file: `src/shared/types.ts` with `Project`, `Session`,
  `SessionStatus`, `HookEvent` type definitions
- Verify `npm run dev` opens an Electron window

**Verify:** `npm run dev` launches a window showing "cc-pewpew" in the title bar.

---

### Phase 2: App shell layout + dark theme

**Input:** Working Electron scaffold from Phase 1.
**Do:**
- Create the three-panel layout: left sidebar (250px), main canvas area, bottom
  status bar
- Dark theme CSS (dark background, subtle borders, monospace accents)
- Sidebar has a header ("Projects") and an empty list area
- Main area shows centered placeholder text ("No sessions")
- Status bar shows "0 sessions"
- Install Zustand, create empty stores: `stores/projects.ts`, `stores/sessions.ts`

**Verify:** App launches with the three-panel dark layout. Resizing the window
works. No functionality yet, just the visual shell.

---

### Phase 3: Project scanner backend

**Input:** App shell from Phase 2.
**Do:**
- Create `src/main/project-scanner.ts`: scans a list of directories for git repos
  (detects `.git`), returns `{ name, path, branches, worktrees, setupState }[]`
- Create `src/main/config.ts`: reads/writes `~/.cc-pewpew/config.json` (stores
  `scanDirs: string[]`, default `["~/dev"]`)
- `setupState` detection: check if `.claude/settings.local.json` exists and
  contains cc-pewpew hooks → `ready`, otherwise → `unsetup`
- List existing git worktrees via `git worktree list --porcelain`
- Wire to IPC: `projects:scan` handler returns project list to renderer
- Expose via preload: `window.api.scanProjects()`

**Verify:** Add a temporary `console.log` in the renderer that calls
`window.api.scanProjects()` on mount and logs the result. It should list git
repos from `~/dev` with correct setup states.

---

### Phase 4: Project tree UI

**Input:** Scanner backend from Phase 3.
**Do:**
- Create `ProjectTree.tsx`: tree view that calls `window.api.scanProjects()` and
  displays projects as expandable nodes
- Each project shows: name, setup state badge (`[Setup]` button or green dot)
- Expandable: shows worktrees underneath each project
- Wire the projects Zustand store to hold scan results
- Add a refresh button in the sidebar header
- Style: dark theme, hover highlights, indented tree levels

**Verify:** Sidebar shows actual git repos from `~/dev`. Projects with
`.claude/settings.local.json` containing hooks show as ready. Others show `[Setup]`.

---

### Phase 5: Project setup flow + context menus

**Input:** Project tree from Phase 4.
**Do:**
- Create `src/main/hook-installer.ts`:
  - Writes/merges cc-pewpew hooks into `.claude/settings.local.json` (preserves
    existing keys, only touches `hooks`)
  - Ensures `.claude/settings.local.json` is in `.gitignore` (append if missing,
    create `.gitignore` if needed)
- Create `ContextMenu.tsx`: right-click context menus on project nodes
  - Unsetup projects: "Setup for cc-pewpew"
  - Ready projects: "New session..." (disabled for now — wired in Phase 7)
  - All projects: "Open in file manager", "Rescan"
- Wire setup action: calls `window.api.setupProject(path)` → runs hook installer
  → rescans → UI updates to show project as `ready`
- Create new repo support: "Create new project..." in sidebar footer, prompts for
  name, runs `git init` in scan dir

**Verify:** Right-click an unsetup project → "Setup for cc-pewpew" → project
turns green/ready. Check that `.claude/settings.local.json` was created with
hooks and is in `.gitignore`.

---

### Phase 6: Hook server (Unix socket)

**Input:** Working app from Phase 5.
**Do:**
- Create `src/main/hook-server.ts`: Unix domain socket server at
  `~/.cc-pewpew/ipc.sock`
- Write socket path to `~/.cc-pewpew/socket-path` breadcrumb file
- Newline-delimited JSON-RPC 2.0 protocol
- Implement methods: `ping`, `session.start`, `session.stop`, `session.activity`,
  `session.end`, `session.notification`
- On incoming events: emit IPC to renderer (`hook:event` channel)
- Clean up socket on app exit
- Create `hooks/notify.sh` — the bash script that CC hooks will call
- Copy `notify.sh` to `~/.cc-pewpew/hooks/` on app startup

**Verify:** Start the app. In a separate terminal, send a test JSON-RPC message:
`echo '{"jsonrpc":"2.0","method":"ping","id":1}' | socat - UNIX-CONNECT:$(cat ~/.cc-pewpew/socket-path)`
— should get a response. Send a `session.start` event and verify it appears in
the renderer console via IPC.

---

### Phase 7: Session launcher (Ghostty + worktrees)

**Input:** Hook server from Phase 6.
**Do:**
- Create `src/main/session-manager.ts`:
  - `createSession(projectPath, name?)`: creates git worktree
    (`git -C <repo> worktree add .claude/worktrees/<name>`), spawns
    `ghostty --class=com.ccpewpew.s.<id> --title="<project>/<name>" --gtk-single-instance=false --working-directory=<worktree-path> -e claude --dangerously-skip-permissions`
  - Tracks child process PID, registers session in state
  - Detects Ghostty exit via `child.on('exit')`
- Persist session state to `~/.cc-pewpew/sessions.json`
- Restore sessions on app restart (mark as `unknown` if Ghostty PID still alive,
  `dead` if not)
- Wire "New session..." context menu action → calls `window.api.createSession()`
- Wire sessions Zustand store

**Verify:** Right-click a ready project → "New session..." → Ghostty window opens
with Claude Code running inside. Session appears in the store. Closing Ghostty →
session state updates.

---

### Phase 8: Session cards UI

**Input:** Session launcher from Phase 7.
**Do:**
- Create `SessionCard.tsx`: displays a single session as a card in the main area
  - Header: `<project>/<worktree>` name
  - Status badge: colored dot + text (Running / Needs input / Completed / Dead)
  - Last activity timestamp
  - Placeholder area for thumbnail (gray box for now)
- Create `SessionCanvas.tsx`: lays out session cards in a simple CSS grid (no
  zoom/pan yet)
- Wire to sessions store: cards appear/disappear/update as sessions change
- Wire hook events to session status: `session.start` → Running,
  `session.stop` → Needs input, `session.activity` → update lastActivity,
  `session.end` → Completed
- Right-click card: "Kill session", "Focus window" (focus is a no-op for now)

**Verify:** Launch a session → card appears as "Running". If CC stops and waits
for input, card should flip to "Needs input" (visible via the Stop hook). When CC
session ends, card shows "Completed".

---

### Phase 9: Window thumbnails + focus

**Input:** Session cards from Phase 8.
**Do:**
- Create `src/main/window-capture.ts`: polls `desktopCapturer.getSources()` every
  3 seconds, matches Ghostty windows by title pattern
- Send thumbnails to renderer via IPC as base64 PNG
- `SessionCard.tsx`: replace gray placeholder with actual thumbnail image
- Create `src/main/window-focus.ts`: focuses a Ghostty window
  - Detect display server (`XDG_SESSION_TYPE`)
  - X11: `xdotool windowactivate $(xdotool search --class <class>)`
  - Wayland: try Ghostty D-Bus `present-surface`, fall back to compositor IPC
- Wire "Focus window" in card context menu and click-on-card action

**Verify:** Running sessions show live Ghostty window thumbnails that update
every few seconds. Clicking a card raises the corresponding Ghostty window.

---

### Phase 10: Canvas zoom and pan

**Input:** Working cards + thumbnails from Phase 9.
**Do:**
- Replace CSS grid in `SessionCanvas.tsx` with a transform-based canvas:
  - CSS `transform: scale(zoom) translate(panX, panY)` on a container div
  - Dot-grid background on a `<canvas>` element (scales with zoom)
- Mouse wheel → zoom (30%–100%), zooms toward cursor position
- Click-drag on empty canvas → pan
- Cards are absolutely positioned within the transformed container
- Ctrl+0 → reset zoom to fit all cards, Ctrl+= / Ctrl+- → zoom in/out
- Persist zoom/pan state across restarts (in `config.json`)

**Verify:** Mouse wheel zooms in/out smoothly. Dragging pans. Cards stay
positioned correctly at all zoom levels. Restart app → same zoom/pan.

---

### Phase 11: Cluster layout

**Input:** Zoomable canvas from Phase 10.
**Do:**
- Group sessions by project into clusters
- Each cluster: dashed border, project name label, unique accent color (from a
  palette of 8-10 colors, assigned by project hash)
- Auto-layout: clusters arranged in a grid-pack layout (no overlap), sessions
  arranged in a mini-grid within each cluster
- New sessions auto-placed in their project's cluster
- Drag a cluster to reposition it (all cards move together)
- Persist cluster positions in `config.json`

**Verify:** Sessions from the same project appear grouped in a labeled, colored
cluster. Adding a new session to a project places it inside the correct cluster.
Dragging a cluster moves all its cards. Restart → positions preserved.

---

### Phase 12: Status bar + edge indicators

**Input:** Clustered canvas from Phase 11.
**Do:**
- `StatusBar.tsx`: live counts — total sessions, running, needs input, completed
- Quick-jump buttons in status bar for sessions that need input (click → pan to
  that card)
- Edge indicators: when a cluster is off-screen, show a colored dot at the
  viewport edge pointing toward it. Click dot → smooth pan to cluster (350ms
  ease-out animation).
- "Needs input" sessions get a pulsing border animation on their card

**Verify:** Status bar shows correct counts that update live. Sessions needing
input pulse visually. Scroll away from a cluster → edge dot appears. Click dot →
smooth pan to cluster.

---

### Phase 13: Worktree cleanup + session lifecycle

**Input:** Full canvas from Phase 12.
**Do:**
- When Ghostty exits or `session.end` hook fires: show a dialog "Session
  `<name>` ended. Clean up worktree?" with buttons: **Delete worktree** /
  **Keep worktree** / **Keep and open in file manager**
- Delete: runs `git -C <repo> worktree remove <path>`, removes session card
- Keep: card stays as "Completed", worktree persists
- Keep+open: same as Keep + `xdg-open <worktree-path>`
- "Kill session" context menu: sends SIGTERM to Ghostty PID, then triggers the
  same cleanup dialog

**Verify:** End a CC session → dialog appears → each button works correctly.
Kill a session → Ghostty closes → dialog appears. Worktree is actually removed
on "Delete".

---

### Phase 14: Notifications + tray icon

**Input:** Full app from Phase 13.
**Do:**
- System tray icon: shows cc-pewpew icon, tooltip with session counts
- Tray icon badge/indicator when any session needs input
- Click tray icon → show/hide main window
- Desktop notifications (via Electron `Notification` API) when a session flips to
  "needs input" — notification body includes project/worktree name, click
  notification → focus that session's Ghostty window
- Tray context menu: "Show cc-pewpew", "Quit", list of sessions needing input

**Verify:** Minimize app → session needs input → desktop notification appears +
tray icon changes. Click notification → Ghostty window focuses. Tray menu works.

---

### Phase 15: Persistence + polish

**Input:** Full app from Phase 14.
**Do:**
- Remember main window position, size, and maximized state across restarts
- Remember sidebar width (resizable via drag handle)
- Smooth animations: card status transitions (fade between status colors),
  cluster appear/disappear
- Keyboard shortcuts: Ctrl+N → "New session..." dialog, Ctrl+R → rescan
  projects, Escape → deselect, Ctrl+Q → quit
- Handle edge cases: Ghostty not installed (show error), no git repos found
  (show helpful empty state), socket already exists on startup (clean stale
  socket)

**Verify:** Close and reopen app → window size/position/sidebar/zoom all
restored. Keyboard shortcuts work. Uninstall Ghostty temporarily → app shows
clear error instead of crashing.

---

## Directory Structure

```
cc-pewpew/
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── LICENSE                          # MIT
├── PLAN.md                          # This file
├── src/
│   ├── main/                        # Electron main process
│   │   ├── index.ts                 # Entry: create window, start services
│   │   ├── project-scanner.ts       # Find git repos in ~/dev
│   │   ├── session-manager.ts       # Spawn Ghostty + CC, track sessions
│   │   ├── hook-server.ts           # Unix socket JSON-RPC server
│   │   ├── hook-installer.ts        # Install CC hooks into settings.local.json
│   │   ├── window-capture.ts        # desktopCapturer thumbnail polling
│   │   ├── window-focus.ts          # Focus Ghostty windows (X11/Wayland)
│   │   └── config.ts                # User preferences persistence
│   ├── preload/
│   │   └── index.ts                 # Secure IPC bridge (contextBridge)
│   ├── renderer/                    # React frontend
│   │   ├── index.html
│   │   ├── main.tsx                 # React entry
│   │   ├── App.tsx                  # Root layout (sidebar + canvas)
│   │   ├── components/
│   │   │   ├── ProjectTree.tsx      # Sidebar project list
│   │   │   ├── SessionCanvas.tsx    # Zoomable/pannable session grid
│   │   │   ├── SessionCard.tsx      # Individual session thumbnail + status
│   │   │   ├── StatusBar.tsx        # Bottom bar with counts
│   │   │   └── ContextMenu.tsx      # Right-click menus
│   │   ├── stores/
│   │   │   ├── projects.ts          # Zustand store for project state
│   │   │   └── sessions.ts          # Zustand store for session state
│   │   └── styles/
│   │       └── global.css           # Dark theme, canvas styles
│   └── shared/
│       └── types.ts                 # Shared types (Session, Project, HookEvent, etc.)
├── hooks/
│   └── notify.sh                    # CC hook script (copied to ~/.cc-pewpew/hooks/)
└── resources/
    └── icons/                       # App icons
```

---

## Key Design Decisions

### Why git worktrees (not just directories)?
Multiple CC sessions on the same repo would cause conflicts if they share a
working directory. Git worktrees give each session an isolated copy of the repo
with its own branch, while sharing the git object database. This is exactly what
CC's `-w` flag does internally.

### Why `desktopCapturer` over PTY-based rendering?
The user explicitly wants to use real Ghostty windows (not embedded terminals).
`desktopCapturer` lets us snapshot those real windows without running our own
terminal emulator. The tradeoff is Wayland compositor variability, but Electron
handles the common cases.

### Why Unix socket (not HTTP)?
Lower latency, no port conflicts, natural process-lifetime cleanup (socket file
is removed on exit). Same approach as Collaborator, proven to work well with
shell scripts (`nc -U` / `socat`).

### Why `--dangerously-skip-permissions` by default?
The user specified this. It removes the permission prompts that would otherwise
be the primary "needs input" source. In this mode, the `Stop` hook is the main
signal for "CC finished and is waiting for the next prompt." Future enhancement:
support other permission modes and use the `Notification` hook with
`notification_type: "permission_prompt"` to detect permission requests.

---

## Open Questions / Future Work

- **Orchestration mode**: Send prompts to CC sessions programmatically (not in v1)
- **Session templates**: Pre-defined prompts for common tasks ("fix tests", "review PR")
- **Multi-monitor**: Canvas spans across monitors, or one canvas per monitor?
- **Ghostty tab mode**: Option to use Ghostty tabs instead of separate windows?
- **Log streaming**: Live-stream CC transcript into a panel in cc-pewpew?
- **Cluster physics**: How much force-directed auto-layout vs manual placement?
