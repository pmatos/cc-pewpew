import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { join, basename, sep } from 'path'
import { randomUUID } from 'crypto'
import { dialog, shell } from 'electron'
import { broadcastToAll, getMainWindow } from './window-registry'
import { CONFIG_DIR, getConfig, saveConfig } from './config'
import { updateTray } from './tray'
import { notifyNeedsInput } from './notifications'
import {
  createPty,
  detachPty,
  destroyPty,
  hasPty,
  hasTmuxSession,
  isTmuxAvailable,
  discoverTmuxSessions,
  reattachPty,
} from './pty-manager'
import { getRepoFingerprint, gitWorktrees } from './project-scanner'
import { installHooks } from './hook-installer'
import type { Session, SessionStatus } from '../shared/types'

const execFileAsync = promisify(execFile)
const SESSIONS_PATH = join(CONFIG_DIR, 'sessions.json')

interface SessionEntry {
  session: Session
}

const sessions = new Map<string, SessionEntry>()

function persistSessions(): void {
  const data = Array.from(sessions.values()).map((e) => e.session)
  writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2))
}

function notifyRenderer(): void {
  const data = Array.from(sessions.values()).map((e) => e.session)
  broadcastToAll('sessions:updated', data)
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

export function initSessionManager(): void {
  // No-op — session manager now uses the window registry for IPC
}

async function deriveLabel(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 }
    )
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    // fall through to basename
  }
  return basename(worktreePath)
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

async function isGitWorktree(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree'],
      { timeout: 5000 }
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function createSessionForWorktree(
  projectPath: string,
  worktreePath: string,
  label?: string
): Promise<Session> {
  const target = canonicalPath(worktreePath)
  for (const e of sessions.values()) {
    if (canonicalPath(e.session.worktreePath) === target) return e.session
  }

  if (!(await isGitWorktree(worktreePath))) {
    throw new Error(`${worktreePath} is not a valid git worktree`)
  }

  const id = randomUUID().slice(0, 8)
  const projectName = basename(projectPath)
  const worktreeName = label || (await deriveLabel(worktreePath))
  const tmuxSession = `cc-pewpew-${id}`

  await installHooks(worktreePath, { skipGitignore: true })
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

  getRepoFingerprint(projectPath).then((fp) => {
    if (fp) {
      session.repoFingerprint = fp
      onSessionsChanged()
    }
  })

  onSessionsChanged()

  return session
}

export interface MirrorAllResult {
  mirrored: Session[]
  failed: { path: string; error: string }[]
}

export async function mirrorAllWorktrees(projectPath: string): Promise<MirrorAllResult> {
  const worktrees = await gitWorktrees(projectPath)
  const existingPaths = new Set<string>()
  for (const e of sessions.values()) existingPaths.add(canonicalPath(e.session.worktreePath))

  const targets = worktrees.filter((wt) => !wt.isMain && !existingPaths.has(canonicalPath(wt.path)))

  const results = await Promise.allSettled(
    targets.map((wt) => createSessionForWorktree(projectPath, wt.path))
  )

  const mirrored: Session[] = []
  const failed: { path: string; error: string }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') mirrored.push(r.value)
    else failed.push({ path: targets[i].path, error: String(r.reason) })
  })

  return { mirrored, failed }
}

export async function createSession(projectPath: string, name?: string): Promise<Session> {
  const worktreeName = name || `session-${randomUUID().slice(0, 8)}`
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)

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

  return createSessionForWorktree(projectPath, worktreePath, worktreeName)
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
  detachPty(id)
  updateSession(id, 'dead')
}

export function reviveSession(id: string): void {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Session ${id} not found`)

  const session = entry.session
  if (session.status !== 'dead')
    throw new Error(`Session ${id} is not dead (status: ${session.status})`)

  if (hasTmuxSession(id)) {
    reattachPty(id)
  } else {
    createPty(id, session.worktreePath, { continueSession: true })
  }
  updateSession(id, 'idle')
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
  const parentWindow = getMainWindow()

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

export async function createPrSession(
  projectPath: string,
  prNumber: number
): Promise<Session | string> {
  // Look up PR via gh CLI
  let prInfo: { headRefName: string; state: string; title: string }
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'headRefName,state,title'],
      { cwd: projectPath }
    )
    prInfo = JSON.parse(stdout)
  } catch {
    return `PR #${prNumber} not found in this repository.`
  }

  if (prInfo.state !== 'OPEN') {
    return `PR #${prNumber} is ${prInfo.state.toLowerCase()}, not open.`
  }

  const branch = prInfo.headRefName
  const id = randomUUID().slice(0, 8)
  const worktreeName = `pr-${prNumber}`
  const projectName = basename(projectPath)
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)
  const tmuxSession = `cc-pewpew-${id}`

  // Fetch the PR branch
  try {
    await execFileAsync('git', ['-C', projectPath, 'fetch', 'origin', branch])
  } catch {
    // May already be available locally
  }

  // Create worktree from the PR branch
  try {
    await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, branch])
  } catch {
    // Branch may already be checked out — try tracking remote
    try {
      await execFileAsync('git', [
        '-C',
        projectPath,
        'worktree',
        'add',
        worktreePath,
        '-b',
        branch,
        `origin/${branch}`,
      ])
    } catch (err) {
      return `Failed to create worktree for branch "${branch}": ${(err as Error).message}`
    }
  }

  // Install hooks in the worktree so Claude Code fires events back to cc-pewpew
  await installHooks(worktreePath, { skipGitignore: true })

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

  getRepoFingerprint(projectPath).then((fp) => {
    if (fp) {
      session.repoFingerprint = fp
      onSessionsChanged()
    }
  })

  onSessionsChanged()
  return session
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)?.session
}

export function getSessions(): Session[] {
  return Array.from(sessions.values()).map((e) => e.session)
}

export async function relocateProject(
  oldProjectPath: string,
  newProjectPath: string
): Promise<{ migratedCount: number }> {
  if (!existsSync(join(newProjectPath, '.git'))) {
    throw new Error(`${newProjectPath} is not a git repository`)
  }

  const toMigrate: SessionEntry[] = []
  for (const entry of sessions.values()) {
    if (entry.session.projectPath === oldProjectPath) {
      toMigrate.push(entry)
    }
  }

  const fingerprint = await getRepoFingerprint(newProjectPath)

  const oldManagedRoot = join(oldProjectPath, '.claude', 'worktrees') + sep
  for (const entry of toMigrate) {
    const s = entry.session
    s.projectPath = newProjectPath
    s.projectName = basename(newProjectPath)
    // Only rewrite worktreePath for managed worktrees under the old project's
    // .claude/worktrees tree, preserving the exact subpath (worktreeName may be
    // a branch label like "cc-pewpew/feat-x" that doesn't match the dirname).
    // External mirrored paths are kept verbatim.
    if (s.worktreePath.startsWith(oldManagedRoot)) {
      const suffix = s.worktreePath.slice(oldManagedRoot.length)
      s.worktreePath = join(newProjectPath, '.claude', 'worktrees', suffix)
    }
    if (fingerprint) s.repoFingerprint = fingerprint

    // Recreate PTY so tmux gets the new worktree cwd
    if (hasPty(s.id)) {
      destroyPty(s.id)
      if (existsSync(s.worktreePath)) {
        createPty(s.id, s.worktreePath)
        s.status = 'idle'
      } else {
        s.status = 'dead'
      }
    }
  }

  const config = getConfig()
  if (config.clusterPositions[oldProjectPath]) {
    config.clusterPositions[newProjectPath] = config.clusterPositions[oldProjectPath]
    delete config.clusterPositions[oldProjectPath]
  }

  if (!config.pinnedPaths.includes(newProjectPath)) {
    config.pinnedPaths.push(newProjectPath)
  }
  saveConfig(config)

  await installHooks(newProjectPath)
  onSessionsChanged()

  return { migratedCount: toMigrate.length }
}

export function restoreSessions(): void {
  if (!existsSync(SESSIONS_PATH)) return

  try {
    const data: Session[] = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'))
    const liveTmuxIds = new Set(discoverTmuxSessions())
    // One-time tmux precheck so we don't fire a blocking error modal per
    // session on startup when tmux is missing from PATH.
    const tmuxAvailable = isTmuxAvailable()
    let recoveredCount = 0
    let skippedForNoTmux = 0

    for (const session of data) {
      if (
        session.status === 'running' ||
        session.status === 'idle' ||
        session.status === 'needs_input'
      ) {
        // Preserve `needs_input` so the tray/status-bar attention signals
        // (tray.ts, StatusBar.tsx) survive a restart — claude --continue
        // resumes mid-wait, so the user still needs to answer.
        const resumedStatus: SessionStatus =
          session.status === 'needs_input' ? 'needs_input' : 'idle'
        if (liveTmuxIds.has(session.id)) {
          session.status = resumedStatus
        } else if (!existsSync(session.worktreePath)) {
          session.status = 'dead'
        } else if (!tmuxAvailable) {
          session.status = 'dead'
          skippedForNoTmux++
        } else {
          // tmux server lost the session (e.g., PC reboot) but the worktree
          // survives — auto-recreate and resume the claude conversation.
          try {
            createPty(session.id, session.worktreePath, { continueSession: true })
            session.status = resumedStatus
            recoveredCount++
          } catch (err) {
            console.error(`Failed to auto-recover session ${session.id}:`, err)
            session.status = 'dead'
          }
        }
      }
      session.lastActivity = Date.now()
      sessions.set(session.id, { session })
    }

    if (skippedForNoTmux > 0) {
      console.warn(
        `tmux not found — ${skippedForNoTmux} session(s) left as 'dead'. Install tmux to enable auto-recovery.`
      )
    }

    // Reattach ptys after all sessions are in the map. Sessions we just
    // recovered already have a node-pty spawned by createPty, so the
    // liveTmuxIds filter here correctly skips them.
    for (const session of data) {
      if (
        (session.status === 'idle' || session.status === 'needs_input') &&
        liveTmuxIds.has(session.id)
      ) {
        try {
          reattachPty(session.id)
        } catch (err) {
          console.error(`Failed to reattach pty for ${session.id}:`, err)
        }
      }
    }

    if (recoveredCount > 0) {
      console.log(`Auto-recovered ${recoveredCount} session(s) after reboot`)
    }

    onSessionsChanged()
  } catch {
    // Corrupted sessions file — start fresh
  }
}
