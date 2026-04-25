import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dialog } from 'electron'
import { broadcastToAll } from './window-registry'
import {
  exec as execRemote,
  retainHostConnection,
  releaseHostConnection,
  spawnAttach,
} from './host-connection'
import { classifySshExit } from './ssh-exit-parser'
import { captureRemotePaneTexts, type RemoteSessionEntry } from './remote-thumbnail'
import type { Host } from '../shared/types'

interface PtyEntry {
  pty: IPty
  tmuxSession: string
  buffer: string
  // Trailing window of PTY output. Populated on every flush so issue #12's
  // `lastKnownState` survives restart with the last-seen pane text. Capped to
  // LAST_SNAPSHOT_MAX bytes so a 100-session `sessions.json` stays small.
  lastSnapshot: string
  host?: Host
  released?: boolean
}

const LAST_SNAPSHOT_MAX = 3 * 1024

const ptys = new Map<string, PtyEntry>()
let flushInterval: ReturnType<typeof setInterval> | null = null

function flushBuffers(): void {
  for (const [sessionId, entry] of ptys) {
    if (entry.buffer.length > 0) {
      broadcastToAll('pty:data', { sessionId, data: entry.buffer })
      const appended = entry.lastSnapshot + entry.buffer
      entry.lastSnapshot =
        appended.length > LAST_SNAPSHOT_MAX ? appended.slice(-LAST_SNAPSHOT_MAX) : appended
      entry.buffer = ''
    }
  }
}

export function getLastSnapshot(sessionId: string): string | undefined {
  const entry = ptys.get(sessionId)
  return entry?.lastSnapshot || undefined
}

export function isTmuxAvailable(): boolean {
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

export function createPty(
  sessionId: string,
  cwd: string,
  options?: { continueSession?: boolean }
): void {
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`)
  }

  if (!isTmuxAvailable()) {
    dialog.showErrorBox(
      'tmux not found',
      'tmux is required for embedded terminals.\nPlease install tmux and restart cc-pewpew.'
    )
    throw new Error('tmux not found')
  }

  const tmuxSession = `cc-pewpew-${sessionId}`

  const claudeArgs = ['claude', '--dangerously-skip-permissions']
  if (options?.continueSession) {
    claudeArgs.push('--continue')
  }

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
    ...claudeArgs,
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
    lastSnapshot: '',
  }

  ptyProcess.onData((data) => {
    entry.buffer += data
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
  })

  ptys.set(sessionId, entry)
}

function releaseRemoteEntry(entry: PtyEntry): void {
  if (!entry.host || entry.released) return
  entry.released = true
  void releaseHostConnection(entry.host.hostId)
}

export async function createRemotePty(
  sessionId: string,
  cwd: string,
  host: Host,
  options?: { continueSession?: boolean }
): Promise<void> {
  const tmuxSession = `cc-pewpew-${sessionId}`

  const claudeArgs = ['claude', '--dangerously-skip-permissions']
  if (options?.continueSession) {
    claudeArgs.push('--continue')
  }

  const create = await execRemote(host, [
    'tmux',
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
    ...claudeArgs,
  ])
  if (create.timedOut || create.code !== 0) {
    const detail = create.stderr.trim() || create.stdout.trim() || `exit ${create.code}`
    throw new Error(`Failed to create remote tmux session: ${detail}`)
  }

  const ptyProcess = spawnAttach(host, ['tmux', 'attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: process.env as Record<string, string>,
  })

  retainHostConnection(host.hostId)

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
    lastSnapshot: '',
    host,
  }

  ptyProcess.onData((data) => {
    entry.buffer += data
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
    releaseRemoteEntry(entry)
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

/** Detach node-pty but keep the tmux session alive (for disconnect/reconnect). */
export function detachPty(sessionId: string): void {
  const entry = ptys.get(sessionId)
  if (!entry) return

  ptys.delete(sessionId)
  releaseRemoteEntry(entry)

  try {
    entry.pty.kill()
  } catch {
    // Pty may already be dead
  }
}

/** Kill both node-pty and the tmux session (full teardown). */
export function destroyPty(sessionId: string): void {
  const entry = ptys.get(sessionId)
  const tmuxSession = entry?.tmuxSession ?? `cc-pewpew-${sessionId}`

  if (entry) {
    ptys.delete(sessionId)
    releaseRemoteEntry(entry)

    try {
      entry.pty.kill()
    } catch {
      // Pty may already be dead from tmux exit
    }
  }

  // Always attempt to kill the tmux session — the pty onExit handler may have
  // already removed the map entry, but the tmux session can still be alive.
  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxSession])
  } catch {
    // Session may already be dead
  }
}

export async function destroyRemotePty(sessionId: string, host: Host): Promise<void> {
  const entry = ptys.get(sessionId)
  const tmuxSession = entry?.tmuxSession ?? `cc-pewpew-${sessionId}`

  const result = await execRemote(host, ['tmux', 'kill-session', '-t', tmuxSession], {
    timeoutMs: 5000,
  })
  // tmux returns nonzero when the session doesn't exist — that's fine, the
  // remote process is already gone. But SSH-level failures (auth, network,
  // timeout) mean the kill never ran on the remote; surface so killSession
  // doesn't dishonestly flip the UI to 'dead' while the remote Claude lives on.
  // Keep `entry` registered in `ptys` until we know the kill succeeded so
  // input/output stay routable if the caller retries.
  if (result.timedOut) {
    throw new Error(`Remote tmux kill-session timed out on host ${host.alias}`)
  }
  if (result.code !== 0) {
    const { reason, message } = classifySshExit({ exitCode: result.code, stderr: result.stderr })
    if (reason === 'auth-failed' || reason === 'network' || reason === 'dep-missing') {
      throw new Error(`Remote tmux kill-session failed on host ${host.alias}: ${message}`)
    }
  }

  if (entry) {
    ptys.delete(sessionId)
    try {
      entry.pty.kill()
    } catch {
      // Pty may already be dead from ssh/tmux exit
    }
    releaseRemoteEntry(entry)
  }
}

export function getPtyIds(): string[] {
  return Array.from(ptys.keys())
}

export function hasPty(sessionId: string): boolean {
  return ptys.has(sessionId)
}

export function hasTmuxSession(sessionId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `cc-pewpew-${sessionId}`], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export async function captureThumbnails(): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const remoteEntries: RemoteSessionEntry[] = []
  for (const [sessionId, entry] of ptys) {
    if (entry.host) {
      remoteEntries.push({ sessionId, host: entry.host, tmuxSession: entry.tmuxSession })
      continue
    }
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
  if (remoteEntries.length > 0) {
    // Multiplexed through the per-host ControlMaster: every exec call shares the
    // existing live SSH connection, so this is N tmux invocations but zero new
    // SSH handshakes. Each per-session call is isolated by Promise.allSettled
    // inside the helper so a single dead/unreachable session can't poison the
    // batch or the underlying control connection.
    const remote = await captureRemotePaneTexts(remoteEntries, { exec: execRemote })
    for (const [sessionId, text] of Object.entries(remote)) {
      result[sessionId] = text
      // Captured pane text is a coherent screen snapshot — overwrite the
      // streaming-buffer lastSnapshot so the lastKnownState cache persisted by
      // session-manager reflects the most recent capture instead of the raw
      // ANSI byte tail.
      const entry = ptys.get(sessionId)
      if (entry) entry.lastSnapshot = text
    }
  }
  return result
}

export async function hasRemoteTmuxSession(sessionId: string, host: Host): Promise<boolean> {
  const result = await execRemote(host, ['tmux', 'has-session', '-t', `cc-pewpew-${sessionId}`], {
    timeoutMs: 3000,
  })
  return result.code === 0 && !result.timedOut
}

// Discriminated probe: distinguishes "tmux session is absent on the remote"
// from "we couldn't reach the remote to ask". The boolean `hasRemoteTmuxSession`
// collapses both into `false`, which reconnect/batch-probe paths would otherwise
// treat as a dead session and incorrectly downgrade a still-running remote
// terminal.
export type RemoteTmuxProbeResult = 'present' | 'absent' | 'unreachable'

export async function probeRemoteTmuxSession(
  sessionId: string,
  host: Host
): Promise<RemoteTmuxProbeResult> {
  const result = await execRemote(host, ['tmux', 'has-session', '-t', `cc-pewpew-${sessionId}`], {
    timeoutMs: 3000,
  })
  if (result.timedOut) return 'unreachable'
  if (result.code === 0) return 'present'
  const { reason } = classifySshExit({ exitCode: result.code, stderr: result.stderr })
  if (reason === 'auth-failed' || reason === 'network' || reason === 'dep-missing') {
    return 'unreachable'
  }
  // Non-zero exit with no SSH-level failure marker is tmux's own "can't find
  // session" exit. The remote is reachable; the session is simply gone.
  return 'absent'
}

export async function getScrollback(sessionId: string): Promise<string> {
  const entry = ptys.get(sessionId)
  if (entry?.host) {
    const result = await execRemote(
      entry.host,
      ['tmux', 'capture-pane', '-t', entry.tmuxSession, '-p', '-e', '-S', '-5000'],
      { timeoutMs: 5000 }
    )
    return result.code === 0 && !result.timedOut ? result.stdout : ''
  }

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
    lastSnapshot: '',
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

export async function reattachRemotePty(sessionId: string, host: Host): Promise<void> {
  const tmuxSession = `cc-pewpew-${sessionId}`

  const ptyProcess = spawnAttach(host, ['tmux', 'attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: process.env as Record<string, string>,
  })

  retainHostConnection(host.hostId)

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
    lastSnapshot: '',
    host,
  }

  ptyProcess.onData((data) => {
    entry.buffer += data
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
    releaseRemoteEntry(entry)
  })

  ptys.set(sessionId, entry)

  const scrollback = await getScrollback(sessionId)
  if (scrollback) {
    entry.buffer += scrollback
  }
}
