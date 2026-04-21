// INVARIANT: callers of exec() pass each path argument as its own argv entry;
// shellQuote handles POSIX single-quoting for the remote shell. Never concatenate
// user input into argv strings before passing them in. Both exec() and
// testConnection() insert `--` before the alias so a host alias beginning with
// `-` (e.g. from a hand-edited config.json) cannot be interpreted by ssh as an
// option, even if upstream validation was bypassed.

import { execFile } from 'child_process'
import { shellQuote } from './shell-quote'
import { classifySshExit } from './ssh-exit-parser'
import type { TestConnectionResult, ValidateRemoteRepoResult } from '../shared/types'

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

function runSsh(argv: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      argv,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
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

// Forward-looking helper for slices 2+. Slice 1 has no caller, but the
// shell-quote invariant is tested and shipped so later code inherits a correct
// foundation.
export async function exec(
  alias: string,
  argv: string[],
  opts: { timeoutMs?: number } = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const quoted = argv.map(shellQuote)
  const sshArgv = ['-o', 'BatchMode=yes', '--', alias, ...quoted]
  return runSsh(sshArgv, timeoutMs)
}

// Validates that a remote path is a git repository and extracts its root-commit
// fingerprint in a single ssh round-trip. The remote path is passed as a
// positional argument ($1) to `sh -c`, never interpolated into the script text
// — this keeps the INVARIANT at the top of this file intact even for paths
// containing shell metacharacters.
//
// The probe uses `git rev-parse --git-dir` rather than a bare `test -d .git`
// so that worktrees and submodules (where `.git` is a file pointing at a
// separate gitdir) are accepted as valid. The fingerprint step is best-effort:
// an empty repo with no HEAD returns an empty fingerprint, not a rejection.
//
// The probe deliberately does NOT swallow stderr on rev-parse and propagates
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
    'git -C "$1" rev-parse --git-dir >/dev/null\n' +
    'rc=$?\n' +
    'if [ $rc -eq 0 ]; then\n' +
    '  git -C "$1" rev-list --max-parents=0 HEAD 2>/dev/null || true\n' +
    'else\n' +
    '  exit $rc\n' +
    'fi'
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
    message: 'Path is not a git repository',
  }
}
