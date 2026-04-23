import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { join, basename, sep } from 'path'
import { posix } from 'path'
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
  destroyRemotePty,
  hasPty,
  hasTmuxSession,
  hasRemoteTmuxSession,
  isTmuxAvailable,
  discoverTmuxSessions,
  reattachPty,
  reattachRemotePty,
  createRemotePty,
} from './pty-manager'
import { getRepoFingerprint, gitWorktrees } from './project-scanner'
import { installHooks, installRemoteHooks } from './hook-installer'
import { getHost } from './host-registry'
import { listRemoteProjects } from './remote-project-registry'
import { listenHookServerForHost } from './hook-server'
import { ensureHostConnection, exec as execRemote } from './host-connection'
import { bootstrapHost } from './host-bootstrap'
import type { Host, RemoteProject, Session, SessionStatus } from '../shared/types'

const execFileAsync = promisify(execFile)
const SESSIONS_PATH = join(CONFIG_DIR, 'sessions.json')

// Matches "issue37", "issue-37", "issue_37", "issue/37", "issue#37", "issue 37"
// anywhere in a string. Case-insensitive. Captures the number.
const ISSUE_REGEX = /issue[-_/#\s]?(\d+)/i

function parseIssueNumber(...sources: (string | undefined)[]): number | undefined {
  for (const src of sources) {
    if (!src) continue
    const m = src.match(ISSUE_REGEX)
    if (m) return parseInt(m[1], 10)
  }
  return undefined
}

// Read the actual branch checked out in a worktree. Falls back to the
// cc-pewpew-conventional name if the worktree is missing or git fails.
function resolveBranchFromWorktree(worktreePath: string, worktreeName: string): string {
  if (existsSync(worktreePath)) {
    try {
      const out = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf-8',
      }).trim()
      if (out && out !== 'HEAD') return out
    } catch {
      // fall through to default
    }
  }
  return `cc-pewpew/${worktreeName}`
}

// Extract the owner segment from a GitHub `origin` remote URL. Used to
// disambiguate `gh pr list --head <branch>` results when a fork has opened a
// PR whose head branch name collides with a local branch.
function getOriginOwner(projectPath: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    const m = url.match(/(?:[:/])([^/:]+)\/[^/]+?(?:\.git)?\/?$/)
    return m?.[1]
  } catch {
    return undefined
  }
}

interface SessionEntry {
  session: Session
}

const sessions = new Map<string, SessionEntry>()

function getRemoteProject(hostId: string, projectPath: string): RemoteProject {
  const project = listRemoteProjects().find((p) => p.hostId === hostId && p.path === projectPath)
  if (!project) throw new Error('Remote project is not registered')
  return project
}

function getRequiredHost(hostId: string): Host {
  const host = getHost(hostId)
  if (!host) throw new Error('Unknown host')
  return host
}

async function prepareRemoteHost(host: Host): Promise<{ notifyScriptPath: string }> {
  const localSocketPath = listenHookServerForHost(host.hostId)
  const { remoteSocketPath } = await ensureHostConnection(host, localSocketPath)
  const bootstrap = await bootstrapHost(
    host.hostId,
    {
      exec: (argv, opts) => execRemote(host, argv, opts),
    },
    remoteSocketPath
  )
  return { notifyScriptPath: bootstrap.notifyScriptPath }
}

async function expectRemoteOk(host: Host, argv: string[], message: string): Promise<string> {
  const result = await execRemote(host, argv)
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`${message}: ${detail}`)
  }
  return result.stdout
}

// Positive hits are cached forever; negative hits (no PR yet / gh transient
// error) are retained only for NEGATIVE_CACHE_TTL_MS so a PR opened after the
// session was created can be picked up without requiring an app restart.
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000
const prLookupCache = new Map<string, { value: number | null; checkedAt: number }>()

async function lookupPrForBranch(projectPath: string, branch: string): Promise<number | undefined> {
  const key = `${projectPath}::${branch}`
  const cached = prLookupCache.get(key)
  if (cached) {
    if (cached.value !== null) return cached.value
    if (Date.now() - cached.checkedAt < NEGATIVE_CACHE_TTL_MS) return undefined
  }
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'number,headRepositoryOwner',
        '--limit',
        '10',
      ],
      { cwd: projectPath }
    )
    const parsed = JSON.parse(stdout) as {
      number: number
      headRepositoryOwner?: { login?: string } | null
    }[]
    // `gh pr list --head <branch>` filters by branch name only (owner:branch
    // isn't supported), so in repos that accept fork PRs a common branch name
    // like `main` or `fix` can return an unrelated PR. Prefer the entry whose
    // head repo owner matches the local origin's owner; fall back to the top
    // result so upstream clones tracking a contributor's branch (where the
    // head owner differs from origin) still get a PR number.
    const owner = getOriginOwner(projectPath)
    const match = (owner && parsed.find((p) => p.headRepositoryOwner?.login === owner)) || parsed[0]
    const num = match?.number
    prLookupCache.set(key, { value: num ?? null, checkedAt: Date.now() })
    return num
  } catch {
    // Don't cache transient gh failures — next call retries immediately.
    return undefined
  }
}

function resolvePrNumberAsync(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || entry.session.prNumber !== undefined) return
  if (entry.session.hostId) return
  const { projectPath, branch } = entry.session
  if (!branch) return
  lookupPrForBranch(projectPath, branch).then((num) => {
    if (num === undefined) return
    const current = sessions.get(sessionId)
    if (!current || current.session.prNumber !== undefined) return
    current.session.prNumber = num
    onSessionsChanged()
  })
}

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

// Re-probe PR numbers for sessions that don't have one yet, so a PR opened
// after session creation shows up without an app restart.
const PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000

export function initSessionManager(): void {
  setInterval(() => {
    for (const entry of sessions.values()) {
      if (entry.session.prNumber === undefined) resolvePrNumberAsync(entry.session.id)
    }
  }, PR_REFRESH_INTERVAL_MS).unref()
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

// In-flight adoption promises keyed by canonical worktree path. Serializes
// concurrent mirror requests for the same path (e.g. double-click on + Mirror,
// racing against mirrorAllWorktrees) so only one session/PTY is created.
const inflightAdoptions = new Map<string, Promise<Session>>()

export async function createSessionForWorktree(
  projectPath: string,
  worktreePath: string,
  label?: string
): Promise<Session> {
  const target = canonicalPath(worktreePath)
  for (const e of sessions.values()) {
    if (canonicalPath(e.session.worktreePath) === target) return e.session
  }

  const inflight = inflightAdoptions.get(target)
  if (inflight) return inflight

  const promise = adoptWorktree(projectPath, worktreePath, label)
  inflightAdoptions.set(target, promise)
  try {
    return await promise
  } finally {
    inflightAdoptions.delete(target)
  }
}

async function adoptWorktree(
  projectPath: string,
  worktreePath: string,
  label: string | undefined
): Promise<Session> {
  if (!(await isGitWorktree(worktreePath))) {
    throw new Error(`${worktreePath} is not a valid git worktree`)
  }

  // Store the canonical path so renderer raw-equality matches against
  // git's canonical porcelain output (the same normalization used for dedupe).
  const canonical = canonicalPath(worktreePath)
  const id = randomUUID().slice(0, 8)
  const projectName = basename(projectPath)
  const worktreeName = label || (await deriveLabel(worktreePath))
  const tmuxSession = `cc-pewpew-${id}`
  const branch = resolveBranchFromWorktree(worktreePath, worktreeName)

  await installHooks(worktreePath, { skipGitignore: true })
  createPty(id, worktreePath)

  const session: Session = {
    id,
    hostId: null,
    projectPath,
    projectName,
    worktreeName,
    worktreePath: canonical,
    branch,
    issueNumber: parseIssueNumber(worktreeName, branch),
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

  resolvePrNumberAsync(id)

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

async function createRemoteSession(
  hostId: string,
  projectPath: string,
  name?: string
): Promise<Session> {
  const host = getRequiredHost(hostId)
  const remoteProject = getRemoteProject(hostId, projectPath)
  const worktreeName = name || `session-${randomUUID().slice(0, 8)}`
  const worktreePath = posix.join(projectPath, '.claude', 'worktrees', worktreeName)
  const id = randomUUID().slice(0, 8)
  const tmuxSession = `cc-pewpew-${id}`
  const branchName = `cc-pewpew/${worktreeName}`

  const { notifyScriptPath } = await prepareRemoteHost(host)

  const addWithBranch = await execRemote(host, [
    'git',
    '-C',
    projectPath,
    'worktree',
    'add',
    worktreePath,
    '-b',
    branchName,
  ])
  if (addWithBranch.timedOut || addWithBranch.code !== 0) {
    await expectRemoteOk(
      host,
      ['git', '-C', projectPath, 'worktree', 'add', worktreePath],
      'Failed to create remote worktree'
    )
  }

  const branch =
    (
      await expectRemoteOk(
        host,
        ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        'Failed to resolve remote branch'
      )
    ).trim() || branchName

  await installRemoteHooks(
    (argv, opts) => execRemote(host, argv, opts),
    worktreePath,
    notifyScriptPath
  )
  await createRemotePty(id, worktreePath, host)

  const session: Session = {
    id,
    hostId,
    projectPath,
    projectName: remoteProject.name,
    worktreeName,
    worktreePath,
    branch,
    issueNumber: parseIssueNumber(worktreeName, branch),
    pid: 0,
    tmuxSession,
    status: 'running',
    connectionState: 'live',
    lastActivity: Date.now(),
    hookEvents: [],
    ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
  }

  sessions.set(id, { session })
  onSessionsChanged()
  return session
}

export async function createSession(
  projectPath: string,
  name?: string,
  hostId: string | null = null
): Promise<Session> {
  if (hostId) return createRemoteSession(hostId, projectPath, name)

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

export function handleHookEvent(
  method: string,
  params: Record<string, unknown>,
  originHostId: string | null = null
): boolean {
  // Match hook event to our session. CC's session_id differs from our internal id,
  // so match by cwd (worktree path) which is unique per session.
  const cwd = params.cwd as string | undefined
  const ccSessionId = (params.session_id ?? params.sessionId) as string | undefined

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
  if (!entry) return false

  const expectedHostId = entry.session.hostId ?? null
  if (expectedHostId !== originHostId) {
    console.warn(
      `Dropping hook event for host mismatch: session=${entry.session.id} expected=${expectedHostId ?? 'local'} origin=${originHostId ?? 'local'}`
    )
    return false
  }

  switch (method) {
    case 'session.start':
      entry.session.status = 'running'
      entry.session.connectionState = originHostId ? 'live' : entry.session.connectionState
      break
    case 'session.stop':
      entry.session.status = 'needs_input'
      entry.session.connectionState = originHostId ? 'live' : entry.session.connectionState
      notifyNeedsInput(entry.session)
      break
    case 'session.activity':
      entry.session.status = 'running'
      entry.session.connectionState = originHostId ? 'live' : entry.session.connectionState
      break
    case 'session.end':
      promptCleanup(entry.session.id)
      return true
    case 'session.notification':
      entry.session.hookEvents.push({
        method,
        sessionId: ccSessionId || entry.session.id,
        timestamp: Date.now(),
        originHostId,
        data: params,
      })
      break
    default:
      return false
  }

  entry.session.lastActivity = Date.now()
  onSessionsChanged()
  return true
}

export async function killSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) return
  if (entry.session.hostId) {
    const host = getRequiredHost(entry.session.hostId)
    await destroyRemotePty(id, host)
    entry.session.connectionState = 'offline'
    updateSession(id, 'dead')
    return
  }
  detachPty(id)
  updateSession(id, 'dead')
}

export async function reviveSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Session ${id} not found`)

  const session = entry.session
  if (session.status !== 'dead')
    throw new Error(`Session ${id} is not dead (status: ${session.status})`)

  if (session.hostId) {
    const host = getRequiredHost(session.hostId)
    session.connectionState = 'connecting'
    onSessionsChanged()
    await prepareRemoteHost(host)
    if (await hasRemoteTmuxSession(id, host)) {
      await reattachRemotePty(id, host)
    } else {
      await createRemotePty(id, session.worktreePath, host, { continueSession: true })
    }
    session.connectionState = 'live'
    updateSession(id, 'idle')
    return
  }

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

  if (entry.session.hostId) {
    const host = getRequiredHost(entry.session.hostId)
    try {
      await execRemote(host, [
        'git',
        '-C',
        entry.session.projectPath,
        'worktree',
        'remove',
        entry.session.worktreePath,
        '--force',
      ])
    } catch {
      // Remote worktree may already be removed or host unavailable.
    }
    return
  }

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
  const entry = sessions.get(id)
  if (entry?.session.hostId) {
    const host = getRequiredHost(entry.session.hostId)
    await destroyRemotePty(id, host)
  } else {
    destroyPty(id)
  }
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
    await removeSession(id)
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
  const worktreeName = `pr-${prNumber}`
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)

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

  const session = await createSessionForWorktree(projectPath, worktreePath, worktreeName)
  // We already know the PR number; set it directly so it shows immediately
  // (the async lookup fired by adoptWorktree will no-op since prNumber is set).
  session.prNumber = prNumber
  // Prefer an issue number parsed from the PR title if the name/branch didn't yield one.
  if (session.issueNumber === undefined) {
    session.issueNumber = parseIssueNumber(prInfo.title)
  }
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
    if (entry.session.hostId === null && entry.session.projectPath === oldProjectPath) {
      toMigrate.push(entry)
    }
  }

  const fingerprint = await getRepoFingerprint(newProjectPath)

  // Stored session paths are canonical, so canonicalize the old managed root
  // too before prefix-matching (oldProjectPath may be a symlink form).
  const oldManagedRoot = canonicalPath(join(oldProjectPath, '.claude', 'worktrees')) + sep
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
      session.hostId = session.hostId ?? null
      if (session.hostId) {
        if (
          session.status === 'running' ||
          session.status === 'idle' ||
          session.status === 'needs_input'
        ) {
          session.status = 'dead'
        }
        session.connectionState = 'offline'
        if (!session.branch) {
          session.branch = `cc-pewpew/${session.worktreeName}`
        }
        if (session.issueNumber === undefined) {
          session.issueNumber = parseIssueNumber(session.worktreeName, session.branch)
        }
        sessions.set(session.id, { session })
        continue
      }

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
      } else if (session.status === 'completed' || session.status === 'error') {
        // Terminal states: if the tmux session is gone, the card shouldn't
        // claim the session is still alive. Don't auto-recover — the
        // conversation already ended.
        if (!liveTmuxIds.has(session.id)) {
          session.status = 'dead'
        }
      }
      // Migrate legacy symlink-form paths to canonical so renderer matches work.
      session.worktreePath = canonicalPath(session.worktreePath)
      // Backfill / reconcile fields added in later versions. Read the real
      // branch from git when the worktree exists — an earlier version of this
      // code persisted an incorrect default that we self-heal. If the worktree
      // is gone, keep whatever was persisted (or the default fallback).
      if (existsSync(session.worktreePath)) {
        session.branch = resolveBranchFromWorktree(session.worktreePath, session.worktreeName)
      } else if (!session.branch) {
        session.branch = `cc-pewpew/${session.worktreeName}`
      }
      if (session.issueNumber === undefined) {
        session.issueNumber = parseIssueNumber(session.worktreeName, session.branch)
      }
      if (session.prNumber === undefined) {
        const m = session.worktreeName.match(/^pr-(\d+)$/)
        if (m) session.prNumber = parseInt(m[1], 10)
      }
      if (session.status !== 'dead') {
        session.lastActivity = Date.now()
      }
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

    // Lazily resolve PR numbers for any restored session that doesn't have one
    for (const session of data) {
      if (session.prNumber === undefined) resolvePrNumberAsync(session.id)
    }

    onSessionsChanged()
  } catch {
    // Corrupted sessions file — start fresh
  }
}
