import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dialog } from 'electron'
import { broadcastToAll } from './window-registry'

interface PtyEntry {
  pty: IPty
  tmuxSession: string
  buffer: string
}

const ptys = new Map<string, PtyEntry>()
let flushInterval: ReturnType<typeof setInterval> | null = null

function flushBuffers(): void {
  for (const [sessionId, entry] of ptys) {
    if (entry.buffer.length > 0) {
      broadcastToAll('pty:data', { sessionId, data: entry.buffer })
      entry.buffer = ''
    }
  }
}

function checkTmux(): boolean {
  try {
    execFileSync('which', ['tmux'])
    return true
  } catch {
    return false
  }
}

export function initPtyManager(): void {
  flushInterval = setInterval(flushBuffers, 16)
}

export function stopPtyManager(): void {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = null
  }
}

export function createPty(sessionId: string, cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`)
  }

  if (!checkTmux()) {
    dialog.showErrorBox(
      'tmux not found',
      'tmux is required for embedded terminals.\nPlease install tmux and restart cc-pewpew.'
    )
    throw new Error('tmux not found')
  }

  const tmuxSession = `cc-pewpew-${sessionId}`

  // Create a detached tmux session that directly runs claude
  // Using tmux's shell command avoids issues with interactive shell init (omz, etc.)
  execFileSync('tmux', [
    'new-session',
    '-d',
    '-s',
    tmuxSession,
    '-c',
    cwd,
    '-x',
    '120',
    '-y',
    '30',
    'claude',
    '--dangerously-skip-permissions',
  ])

  // Attach to it via node-pty
  const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: process.env as Record<string, string>,
  })

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
  }

  ptyProcess.onData((data) => {
    entry.buffer += data
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
  })

  ptys.set(sessionId, entry)
}

export function writePty(sessionId: string, data: string): void {
  const entry = ptys.get(sessionId)
  if (entry) {
    entry.pty.write(data)
  }
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  const entry = ptys.get(sessionId)
  if (entry) {
    entry.pty.resize(cols, rows)
  }
}

export function destroyPty(sessionId: string): void {
  const entry = ptys.get(sessionId)
  if (!entry) return

  ptys.delete(sessionId)

  // Kill tmux session first — this causes the attached pty to exit naturally
  try {
    execFileSync('tmux', ['kill-session', '-t', entry.tmuxSession])
  } catch {
    // Session may already be dead
  }

  try {
    entry.pty.kill()
  } catch {
    // Pty may already be dead from tmux exit
  }
}

export function getPtyIds(): string[] {
  return Array.from(ptys.keys())
}

export function hasPty(sessionId: string): boolean {
  return ptys.has(sessionId)
}

export function captureThumbnails(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [sessionId, entry] of ptys) {
    try {
      const text = execFileSync('tmux', ['capture-pane', '-t', entry.tmuxSession, '-p'], {
        encoding: 'utf-8',
        timeout: 3000,
      })
      result[sessionId] = text
    } catch {
      // Session may be dead
    }
  }
  return result
}

export function getScrollback(sessionId: string): string {
  const tmuxSession = `cc-pewpew-${sessionId}`
  try {
    return execFileSync('tmux', ['capture-pane', '-t', tmuxSession, '-p', '-e', '-S', '-5000'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
  } catch {
    return ''
  }
}

export function discoverTmuxSessions(): string[] {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    return output
      .split('\n')
      .filter((name) => name.startsWith('cc-pewpew-'))
      .map((name) => name.replace('cc-pewpew-', ''))
  } catch {
    return []
  }
}

export function reattachPty(sessionId: string): void {
  const tmuxSession = `cc-pewpew-${sessionId}`

  // Attach to existing tmux session via node-pty
  const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: process.env as Record<string, string>,
  })

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
  }

  ptyProcess.onData((data) => {
    entry.buffer += data
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
  })

  ptys.set(sessionId, entry)

  // Replay scrollback history
  try {
    const scrollback = execFileSync(
      'tmux',
      ['capture-pane', '-t', tmuxSession, '-p', '-e', '-S', '-5000'],
      { encoding: 'utf-8', timeout: 5000 }
    )
    if (scrollback) {
      entry.buffer += scrollback
    }
  } catch {
    // Scrollback capture may fail — not critical
  }
}
