# cc-pewpew

A desktop GUI for launching, monitoring, and visualizing Claude Code sessions with embedded terminals across your git projects.

## What it does

- Scans your `~/dev` directory (configurable) for git repositories
- Right-click a project to set up Claude Code hooks, then launch sessions
- Each session runs Claude Code in its own git worktree + tmux session
- Embedded terminals via xterm.js — no external windows, no screen-sharing dialogs
- Zoomable canvas with session cards grouped by project in color-coded clusters
- Live terminal thumbnails, pulsing indicators for sessions needing input
- Sessions persist across app restarts (tmux keeps them alive)
- System tray icon with desktop notifications

## Requirements

- [Node.js](https://nodejs.org/) (v20+)
- [tmux](https://github.com/tmux/tmux)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
- Linux (X11 or Wayland)

## Getting started

```bash
git clone https://github.com/pmatos/cc-pewpew.git
cd cc-pewpew
npm install
npm run rebuild-pty   # rebuild node-pty for Electron
npm run dev           # start in development mode
```

## Usage

1. Projects from `~/dev` appear in the sidebar
2. Right-click a project → **Setup for cc-pewpew** (installs Claude Code hooks)
3. Right-click again → **New session...** (optionally name it)
4. A session card appears on the canvas with a live terminal preview
5. Click the card to open the full interactive terminal
6. Press **Escape** to return to the canvas overview
7. Sessions survive closing and reopening the app

## Configuration

Edit `~/.config/cc-pewpew/config.json`:

```json
{
  "scanDirs": ["~/dev"],
  "uiScale": 1.0,
  "sidebarWidth": 250
}
```

- `scanDirs` — directories to scan for git repos
- `uiScale` — UI zoom factor (try `1.3` for HiDPI displays)
- `sidebarWidth` — sidebar width in pixels

## Keyboard shortcuts

| Key             | Action                  |
| --------------- | ----------------------- |
| Ctrl+N          | New project dialog      |
| Ctrl+R          | Rescan projects         |
| Ctrl+0          | Reset canvas zoom       |
| Ctrl+= / Ctrl+- | Zoom in / out           |
| Escape          | Close terminal / dialog |

## Stack

- **Electron** + **TypeScript** + **React** + **Zustand**
- **xterm.js** + **node-pty** + **tmux** for embedded persistent terminals
- **electron-vite** for build tooling

## License

MIT
