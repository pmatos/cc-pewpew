// INVARIANT: callers of exec() pass each path argument as its own argv entry;
// shellQuote handles POSIX single-quoting for the remote shell. Never concatenate
// user input into argv strings before passing them in. Both exec() and
// testConnection() insert `--` before the alias so a host alias beginning with
// `-` (e.g. from a hand-edited config.json) cannot be interpreted by ssh as an
// option, even if upstream validation was bypassed.

import { execFile } from 'child_process'
import { shellQuote } from './shell-quote'
import { classifySshExit } from './ssh-exit-parser'
import type { TestConnectionResult } from '../shared/types'

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

interface SshRunResult extends ExecResult {
  timedOut: boolean
}

function runSsh(argv: string[], timeoutMs: number): Promise<SshRunResult> {
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
  const { stdout, stderr, code } = await runSsh(sshArgv, timeoutMs)
  return { stdout, stderr, code }
}
