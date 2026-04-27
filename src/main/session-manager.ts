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
  probeRemoteTmuxSession,
  reattachPty,
  reattachRemotePty,
  createRemotePty,
} from './pty-manager'
import { getRepoFingerprint, gitWorktrees } from './project-scanner'
import { installHooks, installRemoteHooks } from './hook-installer'
import { getHost } from './host-registry'
import { listRemoteProjects } from './remote-project-registry'
import { listenHookServerForHost } from './hook-server'
import {
  ensureHostConnection,
  exec as execRemote,
  retainHostConnection,
  releaseHostConnection,
  stopHostConnection,
  runtimeStateFor,
  startBootstrapWindow,
  type HostConnectionState,
} from './host-connection'
import { bootstrapHost, HostBootstrapError } from './host-bootstrap'
import { emitToast } from './notifications'
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

// Contract: on success the caller owns an incremented refcount on the host
// SSH runtime and must call releaseHostConnection eventually. Retaining after
// ensureHostConnection also covers bootstrap failures. An ensureHostConnection
// failure still has to tear down the hook listener we started first (the
// reverse-forward target); stopHostConnection triggers the
// setOnHostConnectionStopped callback to do that.
async function prepareRemoteHost(host: Host): Promise<{ notifyScriptPath: string }> {
  const localSocketPath = listenHookServerForHost(host.hostId)
  let remoteSocketPath: string
  try {
    ;({ remoteSocketPath } = await ensureHostConnection(host, localSocketPath))
  } catch (err) {
    // SSH couldn't start. Capture the runtime state BEFORE the teardown wipes
    // the entry so callers can still classify auth-failed / unreachable —
    // stopHostConnection does `runtimes.delete(hostId)` and a later
    // `runtimeStateFor` would otherwise return `undefined`.
    const capturedState = runtimeStateFor(host.hostId)
    // Tear down the host runtime (which runtimeFor already registered) so the
    // hook-server teardown callback fires and we don't leak the per-host
    // listener across repeated failed startups.
    await stopHostConnection(host.hostId).catch(() => undefined)
    if (capturedState === 'auth-failed' || capturedState === 'unreachable') {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      ;(wrapped as Error & { hostConnectionState?: HostConnectionState }).hostConnectionState =
        capturedState
      throw wrapped
    }
    throw err
  }
  retainHostConnection(host.hostId)
  const endBootstrapWindow = startBootstrapWindow(host.hostId)
  try {
    const bootstrap = await bootstrapHost(
      host.hostId,
      {
        exec: (argv, opts) => execRemote(host, argv, opts),
      },
      remoteSocketPath
    )
    return { notifyScriptPath: bootstrap.notifyScriptPath }
  } catch (err) {
    await releaseHostConnection(host.hostId).catch(() => undefined)
    if (err instanceof HostBootstrapError) {
      const label = host.label || host.alias
      if (err.kind === 'missing-deps') {
        emitToast({
          severity: 'error',
          title: `${label}: missing required tools`,
          detail: err.missingDeps.join(', '),
          hostLabel: label,
        })
      } else if (err.kind === 'stream-local-bind') {
        emitToast({
          severity: 'error',
          title: `${label}: hook socket missing`,
          detail: err.message,
          hostLabel: label,
        })
      } else {
        emitToast({
          severity: 'error',
          title: `${label}: failed to install hook script`,
          detail: err.message,
          hostLabel: label,
        })
      }
    }
    throw err
  } finally {
    endBootstrapWindow()
  }
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

// Rate-limit `lastKnownState` writes per session to once every 10s so the
// 3s thumbnail tick doesn't churn `sessions.json` on disk.
const LAST_KNOWN_STATE_MIN_INTERVAL_MS = 10_000
const LAST_KNOWN_STATE_MAX_BYTES = 3 * 1024
const lastKnownStateWrites = new Map<string, number>()

// Mutate a single session's `lastKnownState` in memory, respecting the 10s
// per-session rate limit and 3 KiB cap. Returns `true` when the entry was
// actually mutated so the caller can decide whether to flush; callers that
// update many sessions in one tick should prefer `updateLastKnownStatesBatch`
// to collapse the disk write + broadcast into one call (avoids an O(N) write
// storm from a tight timer loop).
function applyLastKnownState(id: string, text: string, now: number): boolean {
  const entry = sessions.get(id)
  if (!entry) return false
  const last = lastKnownStateWrites.get(id) ?? 0
  if (now - last < LAST_KNOWN_STATE_MIN_INTERVAL_MS) return false
  const trimmed =
    text.length > LAST_KNOWN_STATE_MAX_BYTES ? text.slice(-LAST_KNOWN_STATE_MAX_BYTES) : text
  // Idle sessions emit identical thumbnail text every tick; without this
  // no-op the 10s window would still trigger a sessions.json write +
  // broadcast for every live session indefinitely.
  if (entry.session.lastKnownState?.text === trimmed) return false
  entry.session.lastKnownState = { text: trimmed, timestamp: now }
  lastKnownStateWrites.set(id, now)
  return true
}

export function updateLastKnownState(id: string, text: string): void {
  const now = Date.now()
  if (applyLastKnownState(id, text, now)) {
    onSessionsChanged()
  }
}

// Batch variant for the periodic thumbnail tick: collects all (id, text)
// pairs for one tick and emits a single persist + broadcast when at least
// one session was updated. Prevents an O(N) burst of JSON writes when many
// session snapshots unlock the 10s window simultaneously.
export function updateLastKnownStatesBatch(
  updates: ReadonlyArray<{ id: string; text: string }>
): void {
  const now = Date.now()
  let any = false
  for (const { id, text } of updates) {
    if (applyLastKnownState(id, text, now)) any = true
  }
  if (any) onSessionsChanged()
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

  // prepareRemoteHost retains the SSH runtime on success; we own the ref and
  // release it at the end (or in catch). createRemotePty takes its own retain
  // on success, which is what keeps the connection alive past this function.
  const { notifyScriptPath } = await prepareRemoteHost(host)
  let branch: string
  try {
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

    branch =
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
  } catch (err) {
    await releaseHostConnection(hostId).catch(() => undefined)
    throw err
  }
  await releaseHostConnection(hostId).catch(() => undefined)

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

  // Filter by origin first so local and remote sessions with the same worktree
  // path don't shadow each other — picking the wrong one would drop the event.
  let entry: SessionEntry | undefined
  for (const e of sessions.values()) {
    if ((e.session.hostId ?? null) !== originHostId) continue
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
      // Fire-and-forget, but attach a catch so a remote removeSession failure
      // doesn't become an unhandled rejection in the main process.
      promptCleanup(entry.session.id).catch((err) => {
        console.error(`promptCleanup(${entry.session.id}) failed:`, err)
      })
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

interface ReconnectOutcome {
  state: HostConnectionState | undefined
  // True when the caller inherits an outstanding retain on the host runtime —
  // the sibling batch probe consumes it and releases at the end. This keeps
  // the ControlMaster alive across the doReconnect → batch boundary so each
  // sibling probe reuses the existing ControlPath instead of spawning a
  // fresh SSH handshake (which would also fail independently on a flaky
  // host).
  retainedForBatch: boolean
}

// In-flight reconnect promises keyed by session id. Two concurrent clicks on
// the same pending card (fast double-click, or a click that races the
// auto-fired batch probe) coalesce into one SSH attempt.
const inflightReconnects = new Map<string, Promise<ReconnectOutcome>>()

// Probe-only reconnect for a remote session. If the remote tmux session is
// present we reattach and mark `live`; if it is gone we mark the session
// `dead` (matches issue #12 AC #4: "either reattach the PTY or marks the
// session dead"). Creating a fresh remote tmux session is `reviveSession`'s
// job — that requires explicit user intent ("Restart terminal" on dead).
//
// On SSH failure we classify via `runtimeStateFor` (set by host-connection's
// `startRuntime` before ensureHostConnection rejects), so auth-failed vs.
// network-unreachable get distinct UI states without re-parsing stderr.
export async function reconnectRemoteSession(id: string): Promise<void> {
  const existing = inflightReconnects.get(id)
  if (existing) {
    await existing
    return
  }

  // Capture hostId BEFORE the await: if `removeSession(id)` runs while this
  // reconnect is in flight, `sessions.get(id)` would return undefined after
  // the await and we'd neither release the host retain nor run the sibling
  // batch — leaking the ControlMaster for the lifetime of the app.
  const initialHostId = sessions.get(id)?.session.hostId ?? null

  const promise = doReconnectRemoteSession(id)
  inflightReconnects.set(id, promise)
  let reconnectError: unknown = undefined
  let outcome: ReconnectOutcome | undefined
  try {
    outcome = await promise
  } catch (err) {
    reconnectError = err
  } finally {
    inflightReconnects.delete(id)
  }
  const successState = outcome?.state
  const retainedForBatch = outcome?.retainedForBatch ?? false
  // Fire-and-forget the sibling batch probe — the caller should not block on
  // it. `probePendingSessionsOnHost` is idempotent so concurrent clicks on
  // multiple cards of the same host still collapse to a single batch.
  //
  // Always attempt the batch probe, even when the clicked reconnect rejected:
  // - on success (runtime was `live`), we reconcile siblings over the
  //   now-live ControlMaster
  // - on auth-failed / unreachable, the batch's short-circuit cascades that
  //   state to every pending sibling without any new SSH I/O (spec AC #8)
  //
  // Skip only when there's no host at all (orphaned hostId / missing registry
  // entry) or we couldn't determine any state — there's nothing to probe.
  const hostId = sessions.get(id)?.session.hostId ?? initialHostId
  const tagged = (reconnectError as { hostConnectionState?: HostConnectionState } | null)
    ?.hostConnectionState
  const stateHint = successState ?? tagged ?? (hostId ? runtimeStateFor(hostId) : undefined)
  if (hostId && stateHint) {
    // Fire-and-forget: user's first click should not wait for sibling
    // reconciliation. When doReconnect left us an outstanding retain, the
    // batch consumes it and releases at the end — that keeps the
    // ControlMaster alive across the probe so siblings reuse one SSH
    // handshake instead of spawning one per card.
    ;(async () => {
      try {
        await probePendingSessionsOnHost(hostId, stateHint)
      } catch (err) {
        console.error(`probePendingSessionsOnHost(${hostId}) failed:`, err)
      } finally {
        if (retainedForBatch) {
          await releaseHostConnection(hostId).catch(() => undefined)
        }
      }
    })()
  } else if (hostId && retainedForBatch) {
    // No batch to run but doReconnect handed us an outstanding retain — must
    // release or we leak the runtime.
    await releaseHostConnection(hostId).catch(() => undefined)
  }
  if (reconnectError !== undefined) throw reconnectError
}

async function doReconnectRemoteSession(id: string): Promise<ReconnectOutcome> {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Session ${id} not found`)
  const session = entry.session
  if (!session.hostId) {
    throw new Error(`Session ${id} is not a remote session`)
  }
  const hostId = session.hostId
  const host = getHost(hostId)
  if (!host) {
    session.connectionState = 'unreachable'
    onSessionsChanged()
    throw new Error(`Host configuration for "${hostId}" was removed`)
  }
  session.connectionState = 'connecting'
  onSessionsChanged()

  let retained = false
  try {
    await prepareRemoteHost(host)
    retained = true
    const probe = await probeRemoteTmuxSession(id, host)
    if (probe === 'present') {
      await reattachRemotePty(id, host)
      session.connectionState = 'live'
      if (session.status === 'running') session.status = 'idle'
      session.lastActivity = Date.now()
      onSessionsChanged()
    } else if (probe === 'absent') {
      // Remote confirmed the tmux session is gone — mark dead. The user can
      // invoke "Restart terminal" (reviveSession) to spawn a fresh one.
      session.connectionState = 'offline'
      session.status = 'dead'
      session.lastActivity = Date.now()
      onSessionsChanged()
    } else {
      // SSH-level failure probing an otherwise-live control connection. Treat
      // as unreachable and let the user retry; do NOT mark dead because the
      // remote Claude may still be running.
      session.connectionState = 'unreachable'
      onSessionsChanged()
    }
  } catch (err) {
    // Prefer the state captured by prepareRemoteHost (attached to the error
    // before stopHostConnection wipes the runtime entry). Fall back to the
    // live runtime when the failure happened after prepareRemoteHost returned
    // (e.g. bootstrap / PTY attach step).
    const tagged = (err as { hostConnectionState?: HostConnectionState } | null)
      ?.hostConnectionState
    const runtimeState = tagged ?? runtimeStateFor(hostId)
    if (runtimeState === 'auth-failed') {
      session.connectionState = 'auth-failed'
    } else if (runtimeState === 'unreachable') {
      session.connectionState = 'unreachable'
    } else {
      session.connectionState = 'offline'
    }
    onSessionsChanged()
    if (retained) {
      await releaseHostConnection(hostId).catch(() => undefined)
    }
    throw err
  }
  // `retained` is unconditionally true at this point — the only path that
  // leaves it false throws inside prepareRemoteHost and goes through the
  // catch block's `throw err`.
  //
  // Do NOT release here: the caller (reconnectRemoteSession) owns the retain
  // and transfers it to the sibling batch probe, which releases at the end.
  // This keeps the ControlMaster alive across the boundary so per-sibling
  // `tmux has-session` calls reuse the existing ControlPath instead of
  // spawning fresh SSH handshakes (which would also fail independently on a
  // flaky host). The snapshot of runtime state captured here is still
  // accurate — the release hasn't happened yet.
  const finalState = runtimeStateFor(hostId)
  return { state: finalState, retainedForBatch: true }
}

// Eager batch probe for remaining `pending` sessions on a host that just
// became live. Runs `tmux has-session` per sibling over the live ControlMaster
// (no new SSH handshakes). If the runtime state is `auth-failed` /
// `unreachable` we short-circuit: all siblings inherit that state without any
// network I/O, satisfying spec AC #8 "auth failures transition directly to
// host-auth-failed with no further attempts".
const inflightBatchProbes = new Map<string, Promise<void>>()

export async function probePendingSessionsOnHost(
  hostId: string,
  stateHint?: HostConnectionState
): Promise<void> {
  const existing = inflightBatchProbes.get(hostId)
  if (existing) return existing
  const promise = doProbePendingSessionsOnHost(hostId, stateHint)
  inflightBatchProbes.set(hostId, promise)
  try {
    await promise
  } finally {
    inflightBatchProbes.delete(hostId)
  }
}

async function doProbePendingSessionsOnHost(
  hostId: string,
  stateHint?: HostConnectionState
): Promise<void> {
  const host = getHost(hostId)
  if (!host) return

  const pending: Session[] = []
  for (const entry of sessions.values()) {
    if (entry.session.hostId === hostId && entry.session.connectionState === 'pending') {
      pending.push(entry.session)
    }
  }
  if (pending.length === 0) return

  // Short-circuit the cascade if the runtime is known-failed. Prefer
  // stateHint: on an ensureHostConnection failure the runtime entry has been
  // deleted by stopHostConnection, so runtimeStateFor would return undefined
  // and we'd fall through to the probe loop — defeating the "no further
  // attempts" contract on auth-failed cascades.
  const runtime = stateHint ?? runtimeStateFor(hostId)
  if (runtime === 'auth-failed' || runtime === 'unreachable') {
    for (const s of pending) s.connectionState = runtime
    onSessionsChanged()
    return
  }

  let bailed = false
  for (const s of pending) {
    if (bailed) break
    // The snapshot was taken once at batch entry; by the time we get here
    // another concurrent reconnect (e.g. user clicking a sibling card) may
    // have already advanced this session out of `pending`. Skip — otherwise
    // we'd duplicate the remote reattach and leak the earlier runtime retain.
    if (s.connectionState !== 'pending') continue
    try {
      const probe = await probeRemoteTmuxSession(s.id, host)
      if (probe === 'present') {
        await reattachRemotePty(s.id, host)
        s.connectionState = 'live'
        if (s.status === 'running') s.status = 'idle'
        s.lastActivity = Date.now()
      } else if (probe === 'absent') {
        s.connectionState = 'offline'
        s.status = 'dead'
        s.lastActivity = Date.now()
      } else {
        // SSH probe failed (timeout / auth / network) — the remote may still be
        // running. Mark unreachable and bail so we don't mis-classify the rest
        // of the batch as dead on a transient failure.
        s.connectionState = 'unreachable'
        bailed = true
      }
    } catch (err) {
      // A mid-batch SSH failure means the host dropped. Mark this sibling
      // unreachable and stop — remaining siblings stay `pending` for a
      // later manual reconnect, avoiding a flood of follow-up SSH attempts.
      console.error(`probePendingSessionsOnHost(${hostId}) aborted on ${s.id}:`, err)
      s.connectionState = 'unreachable'
      bailed = true
    }
  }
  onSessionsChanged()
}

export async function reviveSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Session ${id} not found`)

  const session = entry.session
  if (session.status !== 'dead')
    throw new Error(`Session ${id} is not dead (status: ${session.status})`)

  if (session.hostId) {
    const host = getRequiredHost(session.hostId)
    const hostId = session.hostId
    session.connectionState = 'connecting'
    onSessionsChanged()
    // prepareRemoteHost retains the SSH runtime on success; we release it at
    // the end/in catch. createRemotePty/reattachRemotePty take over on success.
    // The prepareRemoteHost await is inside the try so a bootstrap failure
    // also resets connectionState instead of leaving it pinned at connecting.
    let retained = false
    try {
      await prepareRemoteHost(host)
      retained = true
      if (await hasRemoteTmuxSession(id, host)) {
        await reattachRemotePty(id, host)
      } else {
        await createRemotePty(id, session.worktreePath, host, { continueSession: true })
      }
    } catch (err) {
      session.connectionState = 'offline'
      onSessionsChanged()
      if (retained) {
        await releaseHostConnection(hostId).catch(() => undefined)
      }
      throw err
    }
    await releaseHostConnection(hostId).catch(() => undefined)
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

// Local-only forget: detach the PTY wrapper for every session bound to the
// host (releases the host-connection refcount via releaseRemoteEntry without
// talking to the remote tmux), then drop the entries so they vanish from
// sessions.json on the next persist. Worktrees, remote tmux sessions, and the
// remote ~/.config/cc-pewpew/ tree are intentionally left alone — that is the
// v1 host-delete contract (issue #14).
export function removeSessionsForHost(hostId: string): void {
  let removed = false
  for (const [id, entry] of sessions) {
    if (entry.session.hostId !== hostId) continue
    detachPty(id)
    sessions.delete(id)
    removed = true
  }
  if (removed) onSessionsChanged()
}

const cleanupInProgress = new Set<string>()

async function promptCleanup(id: string): Promise<void> {
  if (cleanupInProgress.has(id)) return
  cleanupInProgress.add(id)
  try {
    const entry = sessions.get(id)
    if (!entry) return

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
  } finally {
    cleanupInProgress.delete(id)
  }
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

// Backfill / reconcile fields added in later versions. For local sessions
// (worktreePath exists on this machine) the live git branch trumps whatever
// was persisted — an earlier version stored a wrong default that we self-heal
// here. Remote sessions can't access git without SSH, so they keep the
// persisted branch and only fall back when it's missing.
function backfillDerivedFields(session: Session): void {
  if (!session.hostId && existsSync(session.worktreePath)) {
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
        // Lazy restore: a remote session materializes in `pending` until the
        // user's first click (or reconnectRemoteSession) opens the host's SSH
        // control connection and probes tmux. No network I/O here.
        // `running` → `idle` matches the local "resumedStatus" mapping; a
        // persisted status of `dead` means the remote tmux is confirmed gone
        // and there is nothing to reconnect to, so leave connectionState unset.
        if (session.status === 'running') {
          session.status = 'idle'
        }
        if (session.status !== 'dead') {
          session.connectionState = 'pending'
        }
        backfillDerivedFields(session)
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
      backfillDerivedFields(session)
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
