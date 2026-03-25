import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { type BrowserWindow, dialog, shell } from 'electron'
import { CONFIG_DIR } from './config'
import { updateTray } from './tray'
import { notifyNeedsInput } from './notifications'
import { createPty, destroyPty, discoverTmuxSessions, reattachPty } from './pty-manager'
import type { Session, SessionStatus } from '../shared/types'

const execFileAsync = promisify(execFile)
const SESSIONS_PATH = join(CONFIG_DIR, 'sessions.json')

interface SessionEntry {
  session: Session
}

const sessions = new Map<string, SessionEntry>()
let mainWindowRef: BrowserWindow | null = null

function persistSessions(): void {
  const data = Array.from(sessions.values()).map((e) => e.session)
  writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2))
}

function notifyRenderer(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    const data = Array.from(sessions.values()).map((e) => e.session)
    mainWindowRef.webContents.send('sessions:updated', data)
  }
}

function onSessionsChanged(): void {
  persistSessions()
  notifyRenderer()
  updateTray(getSessions())
}

function updateSession(id: string, status: SessionStatus): void {
  const entry = sessions.get(id)
  if (!entry) return
  entry.session.status = status
  entry.session.lastActivity = Date.now()
  onSessionsChanged()
}

export function initSessionManager(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
}

export async function createSession(projectPath: string, name?: string): Promise<Session> {
  const id = randomUUID().slice(0, 8)
  const worktreeName = name || `session-${id}`
  const projectName = basename(projectPath)
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)
  const tmuxSession = `cc-pewpew-${id}`

  // Create worktree
  try {
    await execFileAsync('git', [
      '-C',
      projectPath,
      'worktree',
      'add',
      worktreePath,
      '-b',
      `cc-pewpew/${worktreeName}`,
    ])
  } catch {
    // Branch may already exist — try without -b
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', worktreePath])
  }

  // Create embedded terminal via PTY manager (tmux + node-pty)
  createPty(id, worktreePath)

  const session: Session = {
    id,
    projectPath,
    projectName,
    worktreeName,
    worktreePath,
    pid: 0,
    tmuxSession,
    status: 'running',
    lastActivity: Date.now(),
    hookEvents: [],
  }

  sessions.set(id, { session })

  onSessionsChanged()

  return session
}

export function handleHookEvent(method: string, params: Record<string, unknown>): void {
  // Match hook event to our session. CC's session_id differs from our internal id,
  // so match by cwd (worktree path) which is unique per session.
  const cwd = params.cwd as string | undefined
  const ccSessionId = params.session_id as string | undefined

  let entry: SessionEntry | undefined
  for (const e of sessions.values()) {
    // Primary match: cwd matches our worktreePath
    if (cwd && e.session.worktreePath && cwd.startsWith(e.session.worktreePath)) {
      entry = e
      break
    }
    // Fallback: exact id match (in case we somehow share IDs)
    if (ccSessionId && e.session.id === ccSessionId) {
      entry = e
      break
    }
  }
  if (!entry) return

  switch (method) {
    case 'session.start':
      entry.session.status = 'running'
      break
    case 'session.stop':
      entry.session.status = 'needs_input'
      notifyNeedsInput(entry.session)
      break
    case 'session.activity':
      entry.session.status = 'running'
      break
    case 'session.end':
      promptCleanup(entry.session.id)
      return
    case 'session.notification':
      entry.session.hookEvents.push({
        method,
        sessionId: ccSessionId || entry.session.id,
        timestamp: Date.now(),
        data: params,
      })
      break
    default:
      return
  }

  entry.session.lastActivity = Date.now()
  onSessionsChanged()
}

export function killSession(id: string): void {
  destroyPty(id)
  updateSession(id, 'dead')
}

export async function removeWorktree(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) return

  try {
    await execFileAsync('git', [
      '-C',
      entry.session.projectPath,
      'worktree',
      'remove',
      entry.session.worktreePath,
      '--force',
    ])
  } catch {
    // Worktree may already be removed or path invalid
  }
}

export async function removeSession(id: string): Promise<void> {
  destroyPty(id)
  await removeWorktree(id)
  sessions.delete(id)
  onSessionsChanged()
}

const cleanupInProgress = new Set<string>()

async function promptCleanup(id: string): Promise<void> {
  if (cleanupInProgress.has(id)) return
  cleanupInProgress.add(id)

  const entry = sessions.get(id)
  if (!entry) {
    cleanupInProgress.delete(id)
    return
  }

  const session = entry.session
  const parentWindow = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null

  const options = {
    type: 'question' as const,
    title: 'Session ended',
    message: `Session "${session.projectName}/${session.worktreeName}" ended.\nClean up worktree?`,
    buttons: ['Delete worktree', 'Keep worktree', 'Keep and open in file manager'],
    defaultId: 1,
    cancelId: 1,
  }

  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options)

  if (response === 0) {
    destroyPty(id)
    await removeWorktree(id)
    removeSession(id)
  } else if (response === 1) {
    updateSession(id, 'completed')
  } else if (response === 2) {
    updateSession(id, 'completed')
    shell.openPath(session.worktreePath)
  }

  cleanupInProgress.delete(id)
}

export function getSessions(): Session[] {
  return Array.from(sessions.values()).map((e) => e.session)
}

export function restoreSessions(): void {
  if (!existsSync(SESSIONS_PATH)) return

  try {
    const data: Session[] = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'))
    const liveTmuxIds = new Set(discoverTmuxSessions())

    for (const session of data) {
      if (session.status === 'running' || session.status === 'idle') {
        if (liveTmuxIds.has(session.id)) {
          session.status = 'idle'
        } else {
          session.status = 'dead'
        }
      }
      session.lastActivity = Date.now()
      sessions.set(session.id, { session })
    }

    // Reattach ptys after all sessions are in the map
    for (const session of data) {
      if (session.status === 'idle' && liveTmuxIds.has(session.id)) {
        try {
          reattachPty(session.id)
        } catch (err) {
          console.error(`Failed to reattach pty for ${session.id}:`, err)
        }
      }
    }

    onSessionsChanged()
  } catch {
    // Corrupted sessions file — start fresh
  }
}
