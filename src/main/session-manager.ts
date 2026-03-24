import { spawn, type ChildProcess } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { type BrowserWindow } from 'electron'
import { CONFIG_DIR } from './config'
import type { Session, SessionStatus } from '../shared/types'

const execFileAsync = promisify(execFile)
const SESSIONS_PATH = join(CONFIG_DIR, 'sessions.json')

interface SessionEntry {
  session: Session
  child: ChildProcess | null
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

function updateSession(id: string, status: SessionStatus): void {
  const entry = sessions.get(id)
  if (!entry) return
  entry.session.status = status
  entry.session.lastActivity = Date.now()
  persistSessions()
  notifyRenderer()
}

export function initSessionManager(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
}

export async function createSession(projectPath: string, name?: string): Promise<Session> {
  const id = randomUUID().slice(0, 8)
  const worktreeName = name || `session-${id}`
  const projectName = basename(projectPath)
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)
  const ghosttyClass = `com.ccpewpew.s.${id}`

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

  // Spawn Ghostty
  const child = spawn(
    'ghostty',
    [
      `--class=${ghosttyClass}`,
      `--title=${projectName}/${worktreeName}`,
      '--gtk-single-instance=false',
      `--working-directory=${worktreePath}`,
      '-e',
      'claude',
      '--dangerously-skip-permissions',
    ],
    {
      detached: false,
      stdio: 'ignore',
    }
  )

  const session: Session = {
    id,
    projectPath,
    projectName,
    worktreeName,
    worktreePath,
    pid: child.pid ?? 0,
    ghosttyClass,
    status: 'running',
    lastActivity: Date.now(),
    hookEvents: [],
  }

  sessions.set(id, { session, child })

  child.on('exit', () => {
    updateSession(id, 'dead')
    const entry = sessions.get(id)
    if (entry) entry.child = null
  })

  child.on('error', () => {
    updateSession(id, 'error')
    const entry = sessions.get(id)
    if (entry) entry.child = null
  })

  persistSessions()
  notifyRenderer()

  return session
}

export function getSessions(): Session[] {
  return Array.from(sessions.values()).map((e) => e.session)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function restoreSessions(): void {
  if (!existsSync(SESSIONS_PATH)) return

  try {
    const data: Session[] = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'))
    for (const session of data) {
      if (session.status === 'running' || session.status === 'idle') {
        session.status = isPidAlive(session.pid) ? 'idle' : 'dead'
      }
      session.lastActivity = Date.now()
      sessions.set(session.id, { session, child: null })
    }
    persistSessions()
  } catch {
    // Corrupted sessions file — start fresh
  }
}
