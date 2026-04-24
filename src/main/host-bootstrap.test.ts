import { describe, it, expect } from 'vitest'
import {
  bootstrapHost,
  HostBootstrapError,
  NOTIFY_SCRIPT_VERSION,
  type HostBootstrapConnection,
} from './host-bootstrap'
import type { ExecResult } from './host-connection'

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false }
}

function fakeConnection(calls: string[][], depsStdout = '\n'): HostBootstrapConnection {
  return {
    exec: async (argv) => {
      calls.push(argv)
      const script = argv[2]
      if (script.includes('command -v')) return ok(depsStdout)
      if (script === 'test -S "$1"') return ok()
      if (script.includes('XDG_CONFIG_HOME')) return ok('/home/dev/.config')
      if (script.includes('notify-v')) return ok()
      return ok()
    },
  }
}

describe('bootstrapHost', () => {
  it('probes deps, checks the remote socket, and installs notify-v1.sh', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-all-present',
      fakeConnection(calls),
      '/tmp/ipc'
    )

    expect(result).toEqual({
      notifyScriptPath: '/home/dev/.config/cc-pewpew/hooks/notify-v1.sh',
      remoteSocketPath: '/tmp/ipc',
    })
    expect(calls.some((argv) => argv.includes('tmux') && argv.includes('claude'))).toBe(true)
    expect(calls.some((argv) => argv.includes('/tmp/ipc'))).toBe(true)
    expect(
      calls.some((argv) => argv.includes('/home/dev/.config/cc-pewpew/hooks/notify-v1.sh'))
    ).toBe(true)
  })

  it('returns a typed missing-deps error with the selective missing set', async () => {
    const calls: string[][] = []
    await expect(
      bootstrapHost('host-bootstrap-missing', fakeConnection(calls, ' jq claude\n'), '/tmp/ipc')
    ).rejects.toMatchObject({
      kind: 'missing-deps',
      missingDeps: ['jq', 'claude'],
    } satisfies Partial<HostBootstrapError>)
  })

  it('installs through a version guard so already-installed notify scripts are kept', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-bootstrap-version-guard', fakeConnection(calls), '/tmp/ipc')

    const installCall = calls.find((argv) =>
      argv.some((part) => part.includes(`notify-v${NOTIFY_SCRIPT_VERSION}.sh`))
    )
    expect(installCall).toBeDefined()
    expect(installCall?.[2]).toContain('grep -q "CC_PEWPEW_NOTIFY_VERSION=$5"')
    expect(installCall).toContain(String(NOTIFY_SCRIPT_VERSION))
  })
})
