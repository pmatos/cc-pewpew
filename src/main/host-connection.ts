// INVARIANT: callers of exec() pass each path argument as its own argv entry;
// shellQuote handles POSIX single-quoting for the remote shell. Never concatenate
// user input into argv strings before passing them in. Both exec() and
// testConnection() insert `--` before the alias so a host alias beginning with
// `-` (e.g. from a hand-edited config.json) cannot be interpreted by ssh as an
// option, even if upstream validation was bypassed.

import { execFile, spawn } from 'child_process'
import { mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir, userInfo } from 'os'
import * as pty from 'node-pty'
import type { IPty, IPtyForkOptions } from 'node-pty'
import { shellQuote } from './shell-quote'
import { classifySshExit } from './ssh-exit-parser'
import { CONFIG_DIR } from './config'
import type { Host, HostId, TestConnectionResult, ValidateRemoteRepoResult } from '../shared/types'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

type HostConnectionState = 'offline' | 'connecting' | 'live' | 'auth-failed' | 'unreachable'

interface HostRuntime {
  host: Host
  controlPath: string
  localSocketPath: string
  remoteSocketPath: string
  child: ReturnType<typeof spawn> | null
  state: HostConnectionState
  refs: number
  ready?: Promise<void>
}

const runtimes = new Map<HostId, HostRuntime>()

// Fired after the SSH control connection is fully torn down. Lets higher-level
// modules (index.ts wires hook-server here) release resources that were
// allocated alongside the SSH runtime without host-connection taking on a
// cross-module dependency.
let onConnectionStopped: ((hostId: HostId) => void) | null = null
export function setOnHostConnectionStopped(fn: ((hostId: HostId) => void) | null): void {
  onConnectionStopped = fn
}

function uidSegment(): string {
  if (typeof process.getuid === 'function') return String(process.getuid())
  try {
    return String(userInfo().uid)
  } catch {
    return homedir().replace(/[^A-Za-z0-9_.-]/g, '_')
  }
}

// Strip any character that could let a hand-edited/corrupted hostId traverse
// out of the intended directory when used in a filesystem path. UUIDs pass
// through unchanged. Shared with hook-server.ts and any other module that
// uses hostId as a path segment.
export function sanitizeHostIdForPath(hostId: HostId): string {
  return hostId.replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function remoteSocketPathForHost(hostId: HostId): string {
  // Include hostId so two configured hosts that resolve to the same remote
  // account don't collide on the reverse-forwarded socket (StreamLocalBindUnlink
  // would otherwise let the later connection steal the earlier one's socket).
  return `/tmp/cc-pewpew-${uidSegment()}-${sanitizeHostIdForPath(hostId)}.sock`
}

function controlPathForHost(hostId: HostId): string {
  return join(CONFIG_DIR, `ssh-${sanitizeHostIdForPath(hostId)}.sock`)
}

function runtimeFor(host: Host, localSocketPath: string): HostRuntime {
  const existing = runtimes.get(host.hostId)
  if (existing) {
    existing.host = host
    existing.localSocketPath = localSocketPath
    return existing
  }

  mkdirSync(CONFIG_DIR, { recursive: true })
  const runtime: HostRuntime = {
    host,
    controlPath: controlPathForHost(host.hostId),
    localSocketPath,
    remoteSocketPath: remoteSocketPathForHost(host.hostId),
    child: null,
    state: 'offline',
    refs: 0,
  }
  runtimes.set(host.hostId, runtime)
  return runtime
}

// 16 MiB lets `tmux capture-pane -S -5000` (up to 5000 lines with ANSI escapes)
// fit even for wide terminals with heavy color output, which would otherwise
// overflow execFile's default and return empty scrollback on reattach.
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

function runSsh(
  argv: string[],
  timeoutMs: number,
  maxBuffer = DEFAULT_MAX_BUFFER
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      argv,
      { timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        // execFile's `timeout` option kills the child with `killSignal` (default
        // SIGTERM) when it fires. Node sets `error.killed === true` in that
        // case; `error.code === 'ETIMEDOUT'` only appears for OS-level socket
        // timeouts and is kept as a belt-and-braces check.
        const errno = (error ?? null) as (NodeJS.ErrnoException & { killed?: boolean }) | null
        const timedOut = Boolean(errno && (errno.killed === true || errno.code === 'ETIMEDOUT'))
        // ENOENT means the ssh binary itself couldn't be launched. Surface it
        // as an exit-127 "command not found" so classifySshExit routes it to
        // `dep-missing` instead of the generic `unknown`.
        if (!timedOut && errno && errno.code === 'ENOENT') {
          resolve({
            stdout: '',
            stderr: 'ssh: command not found',
            code: 127,
            timedOut: false,
          })
          return
        }
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : (child.exitCode ?? 1)
          : 0
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          code,
          timedOut,
        })
      }
    )
  })
}

function controlArgs(runtime: HostRuntime): string[] {
  return [
    '-N',
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=yes',
    '-o',
    `ControlPath=${runtime.controlPath}`,
    '-o',
    'ControlPersist=10m',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    `${runtime.remoteSocketPath}:${runtime.localSocketPath}`,
    '--',
    runtime.host.alias,
  ]
}

async function controlCheck(runtime: HostRuntime): Promise<boolean> {
  const result = await runSsh(
    [
      '-o',
      'BatchMode=yes',
      '-o',
      `ControlPath=${runtime.controlPath}`,
      '-O',
      'check',
      '--',
      runtime.host.alias,
    ],
    1000
  )
  return result.code === 0
}

async function waitForControl(runtime: HostRuntime): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!runtime.child || runtime.child.exitCode !== null) break
    if (await controlCheck(runtime)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('ssh control connection did not become ready')
}

function classifyConnectionFailure(code: number | null, stderr: string): HostConnectionState {
  const { reason } = classifySshExit({ exitCode: code, stderr })
  if (reason === 'auth-failed') return 'auth-failed'
  if (reason === 'network') return 'unreachable'
  return 'offline'
}

async function startRuntime(runtime: HostRuntime): Promise<void> {
  runtime.state = 'connecting'
  let stderr = ''

  const child = spawn('ssh', controlArgs(runtime), {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  runtime.child = child

  child.stderr?.on('data', (data) => {
    stderr += data.toString()
  })

  const exitPromise = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      runtime.child = null
      runtime.state = classifyConnectionFailure(code, stderr)
      reject(new Error(stderr.trim() || `ssh control connection exited: ${code ?? 'signal'}`))
    })
  })

  // Attach before any await so spawn failures (ENOENT, EACCES) don't
  // bubble up as unhandled EventEmitter errors and crash the main process.
  const errorPromise = new Promise<never>((_, reject) => {
    child.once('error', (err) => {
      runtime.child = null
      runtime.state = 'offline'
      const errno = err as NodeJS.ErrnoException
      reject(
        new Error(
          errno.code === 'ENOENT'
            ? 'ssh: command not found'
            : `ssh failed to spawn: ${errno.message || errno.code || 'unknown'}`
        )
      )
    })
  })

  try {
    await Promise.race([waitForControl(runtime), exitPromise, errorPromise])
    runtime.state = 'live'
  } catch (err) {
    const exitCode = child.exitCode
    if (runtime.child) {
      try {
        runtime.child.kill()
      } catch {
        // Already gone.
      }
    }
    runtime.child = null
    runtime.state = classifyConnectionFailure(exitCode, stderr)
    throw err
  }
}

export async function ensureHostConnection(
  host: Host,
  localSocketPath: string
): Promise<{ remoteSocketPath: string; controlPath: string }> {
  const runtime = runtimeFor(host, localSocketPath)
  if (runtime.state === 'live' && runtime.child) {
    return { remoteSocketPath: runtime.remoteSocketPath, controlPath: runtime.controlPath }
  }
  if (!runtime.ready) {
    runtime.ready = startRuntime(runtime).finally(() => {
      runtime.ready = undefined
    })
  }
  await runtime.ready
  return { remoteSocketPath: runtime.remoteSocketPath, controlPath: runtime.controlPath }
}

export function retainHostConnection(hostId: HostId): void {
  const runtime = runtimes.get(hostId)
  if (runtime) runtime.refs++
}

export async function releaseHostConnection(hostId: HostId): Promise<void> {
  const runtime = runtimes.get(hostId)
  if (!runtime) return
  runtime.refs = Math.max(0, runtime.refs - 1)
  if (runtime.refs > 0) return
  await stopHostConnection(hostId)
}

export async function stopHostConnection(hostId: HostId): Promise<void> {
  const runtime = runtimes.get(hostId)
  if (!runtime) return

  if (runtime.child) {
    await runSsh(
      [
        '-o',
        'BatchMode=yes',
        '-o',
        `ControlPath=${runtime.controlPath}`,
        '-O',
        'exit',
        '--',
        runtime.host.alias,
      ],
      2000
    ).catch(() => undefined)
    try {
      runtime.child.kill()
    } catch {
      // Already gone.
    }
  }

  runtime.child = null
  runtime.state = 'offline'
  runtimes.delete(hostId)
  try {
    unlinkSync(runtime.controlPath)
  } catch {
    // Control socket may already be gone.
  }
  onConnectionStopped?.(hostId)
}

export async function stopAllHostConnections(): Promise<void> {
  await Promise.all(Array.from(runtimes.keys()).map((hostId) => stopHostConnection(hostId)))
}

export async function testConnection(
  alias: string,
  opts: { timeoutMs?: number } = {}
): Promise<TestConnectionResult> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const argv = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', alias, 'true']
  const { stderr, code, timedOut } = await runSsh(argv, timeoutMs)

  if (timedOut) {
    return { ok: false, reason: 'network', message: 'ssh timed out' }
  }
  if (code === 0) {
    return { ok: true }
  }
  const { reason, message } = classifySshExit({ exitCode: code, stderr })
  return { ok: false, reason, message }
}

function aliasOf(aliasOrHost: string | Host): string {
  return typeof aliasOrHost === 'string' ? aliasOrHost : aliasOrHost.alias
}

function runtimeForHostIfLive(host: Host): HostRuntime | undefined {
  const runtime = runtimes.get(host.hostId)
  return runtime?.state === 'live' ? runtime : undefined
}

// Forward-looking helper for remote project/session operations.
export async function exec(
  aliasOrHost: string | Host,
  argv: string[],
  opts: { timeoutMs?: number } = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const quoted = argv.map(shellQuote)
  const liveRuntime =
    typeof aliasOrHost === 'string' ? undefined : runtimeForHostIfLive(aliasOrHost)
  const sshArgv = liveRuntime
    ? [
        '-o',
        'BatchMode=yes',
        '-o',
        `ControlPath=${liveRuntime.controlPath}`,
        '--',
        aliasOf(aliasOrHost),
        ...quoted,
      ]
    : ['-o', 'BatchMode=yes', '--', aliasOf(aliasOrHost), ...quoted]
  return runSsh(sshArgv, timeoutMs)
}

export function spawnAttach(host: Host, argv: string[], options: IPtyForkOptions): IPty {
  const runtime = runtimeForHostIfLive(host)
  const quoted = argv.map(shellQuote)
  const sshArgv = [
    '-tt',
    '-o',
    'BatchMode=yes',
    ...(runtime ? ['-o', `ControlPath=${runtime.controlPath}`] : []),
    '--',
    host.alias,
    ...quoted,
  ]
  return pty.spawn('ssh', sshArgv, options)
}

// Validates that a remote path is a git repository ROOT (not a subdirectory)
// and extracts its root-commit fingerprint in a single ssh round-trip. The
// remote path is passed as a positional argument ($1) to `sh -c`, never
// interpolated into the script text — this keeps the INVARIANT at the top of
// this file intact even for paths containing shell metacharacters.
//
// The probe uses `git rev-parse --show-prefix`: it exits 0 with an empty
// stdout at a repo root, 0 with a non-empty "subdir/" at a subdirectory, and
// ~128 outside any repo. We reject non-empty prefixes with exit 2 and a
// diagnostic on stderr so the caller can surface "must be the repository
// root" instead of a generic error. Worktrees and submodules (where `.git` is
// a file) are accepted because `rev-parse` resolves them natively.
//
// The fingerprint step is best-effort: an empty repo with no HEAD returns
// an empty fingerprint, not a rejection.
//
// The probe deliberately does NOT swallow `rev-parse`'s stderr and propagates
// the original exit code, so that a missing `git` binary on the remote
// (shell-level exit 127 + "command not found") remains distinguishable from a
// path that simply isn't a git repo — `classifySshExit` routes the former to
// `dep-missing`.
export async function validateRemoteRepo(
  alias: string,
  path: string,
  opts: { timeoutMs?: number } = {}
): Promise<ValidateRemoteRepoResult> {
  const script =
    'prefix=$(git -C "$1" rev-parse --show-prefix)\n' +
    'rc=$?\n' +
    'if [ $rc -ne 0 ]; then exit $rc; fi\n' +
    'if [ -n "$prefix" ]; then\n' +
    '  printf "Remote path must be the repository root (got subdirectory: %s)\\n" "$prefix" >&2\n' +
    '  exit 2\n' +
    'fi\n' +
    'git -C "$1" rev-list --max-parents=0 HEAD 2>/dev/null || true'
  const { stdout, stderr, code, timedOut } = await exec(alias, ['sh', '-c', script, '_', path], {
    timeoutMs: opts.timeoutMs ?? 15000,
  })
  if (timedOut) {
    return { ok: false, reason: 'network', message: 'ssh timed out' }
  }
  if (code === 0) {
    const fingerprint = stdout.trim().split('\n')[0] || undefined
    return { ok: true, fingerprint }
  }
  const { reason, message } = classifySshExit({ exitCode: code, stderr })
  if (reason === 'auth-failed' || reason === 'network' || reason === 'dep-missing') {
    return { ok: false, reason, message }
  }
  return {
    ok: false,
    reason: 'not-a-git-repo',
    message: stderr.trim() ? message : 'Path is not a git repository',
  }
}
