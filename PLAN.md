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

### Phase 0: Project Bootstrap
- Initialize Electron + TypeScript + React project (electron-forge or electron-vite)
- Set up build tooling (Vite for renderer, tsc for main)
- Dark theme CSS foundation
- Basic window with sidebar + main area layout

### Phase 1: Project Scanner + Tree
- Configurable scan directories (default: `~/dev`), stored in `config.json`
- Scan for git repos, detect setup state (`unsetup` vs `ready`)
- Display project tree in sidebar with setup state indicators
- Setup flow: install hooks into `.claude/settings.local.json`, add to `.gitignore`
- Context menu: "Setup for cc-pewpew" (unsetup repos), "New session..." (ready repos)
- Support creating new repos (`git init`)
- List existing git worktrees under each project

### Phase 2: Session Launcher
- Git worktree creation (`git worktree add`)
- Spawn Ghostty with correct flags
- Track child processes (PID, exit detection)
- Session state management (in-memory + persisted to `sessions.json`)
- Basic session cards in main area (no thumbnails yet, just status text)

### Phase 3: Hook System
- Unix domain socket JSON-RPC server
- Hook script (`notify.sh`)
- Hook installer (writes to `.claude/settings.json` or global settings)
- Event handling: SessionStart, Stop, PostToolUse, SessionEnd, Notification
- Wire events to session state → UI updates reactively

### Phase 4: Window Thumbnails
- `desktopCapturer` integration for periodic screenshots
- Match Ghostty windows by title/class
- Display thumbnails in session cards
- Fallback handling for Wayland compositors where `desktopCapturer` fails
- Click-to-focus: raise the Ghostty window

### Phase 5: Canvas Polish
- Zoom/pan with mouse wheel + drag
- Cluster-based session grouping: dashed boundary per project, label, accent color
- Auto-layout for clusters (force-directed or grid-pack), draggable to reposition
- Smooth animations for state transitions
- Edge indicators for off-screen sessions/clusters
- Keyboard shortcuts (Ctrl+N new session, Ctrl+0 reset zoom, etc.)

### Phase 6: Quality of Life
- Worktree cleanup dialog on session end (Delete / Keep / Keep+open)
- Session logs viewer (parse CC transcript from `transcript_path`)
- System tray icon with notification badge when sessions need input
- Desktop notifications for "needs input" events
- Remember window position/size, canvas zoom/pan across restarts

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
