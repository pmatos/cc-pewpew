import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

interface FakeResult {
  stdout: string
  stderr: string
  error: (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
  exitCode: number | null
}

let nextResult: FakeResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
const execFileCalls: { file: string; args: string[] }[] = []

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (
      error: (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null,
      stdout: string,
      stderr: string
    ) => void
  ) => {
    execFileCalls.push({ file, args })
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null }
    child.exitCode = nextResult.exitCode
    setImmediate(() => cb(nextResult.error, nextResult.stdout, nextResult.stderr))
    return child
  },
}))

import { validateRemoteRepo } from './host-connection'

beforeEach(() => {
  nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
  execFileCalls.length = 0
})

describe('validateRemoteRepo', () => {
  it('returns ok with fingerprint on code=0 stdout', async () => {
    nextResult = { stdout: 'abc123\n', stderr: '', error: null, exitCode: 0 }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result).toEqual({ ok: true, fingerprint: 'abc123' })
  })

  it('returns ok without fingerprint for an empty repo (no commits yet)', async () => {
    nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
    const result = await validateRemoteRepo('dev', '/srv/empty-repo')
    expect(result).toEqual({ ok: true, fingerprint: undefined })
  })

  it('returns not-a-git-repo when remote exits non-zero with no ssh markers', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: { name: 'Error', message: 'x', code: 1 } as unknown as NodeJS.ErrnoException,
      exitCode: 1,
    }
    const result = await validateRemoteRepo('dev', '/not/a/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-a-git-repo')
    expect(result.message).toMatch(/git repository/)
  })

  it('returns auth-failed on Permission denied stderr', async () => {
    nextResult = {
      stdout: '',
      stderr: 'Permission denied (publickey).',
      error: { name: 'Error', message: 'x', code: 255 } as unknown as NodeJS.ErrnoException,
      exitCode: 255,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('auth-failed')
  })

  it('returns network on Connection refused stderr', async () => {
    nextResult = {
      stdout: '',
      stderr: 'ssh: connect to host dev port 22: Connection refused',
      error: { name: 'Error', message: 'x', code: 255 } as unknown as NodeJS.ErrnoException,
      exitCode: 255,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
  })

  it('returns dep-missing when ssh binary is absent', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('ENOENT'), {
        code: 'ENOENT',
      }) as NodeJS.ErrnoException,
      exitCode: null,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('dep-missing')
  })

  it('passes the remote path as a positional argv element (not interpolated)', async () => {
    nextResult = { stdout: 'abc\n', stderr: '', error: null, exitCode: 0 }
    await validateRemoteRepo('dev', "/pa'th")
    const call = execFileCalls[0]
    expect(call.file).toBe('ssh')
    // Last argv entry passed to ssh is the shell-quoted remote path; previous
    // entries cover "sh", "-c", SCRIPT, "_" — each shell-quoted independently.
    expect(call.args[call.args.length - 1]).toBe("'/pa'\"'\"'th'")
    expect(call.args).toContain('--')
    expect(call.args).toContain('dev')
  })
})
