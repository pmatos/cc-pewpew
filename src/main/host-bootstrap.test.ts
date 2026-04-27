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
      availableAgents: { claude: true, codex: true },
    })
    expect(
      calls.some(
        (argv) => argv.includes('tmux') && argv.includes('claude') && argv.includes('codex')
      )
    ).toBe(true)
    expect(calls.some((argv) => argv.includes('/tmp/ipc'))).toBe(true)
    expect(
      calls.some((argv) => argv.includes('/home/dev/.config/cc-pewpew/hooks/notify-v1.sh'))
    ).toBe(true)
  })

  it('hard-fails on missing strict deps but tolerates missing agent CLIs', async () => {
    const calls: string[][] = []
    await expect(
      bootstrapHost('host-bootstrap-missing', fakeConnection(calls, ' jq\n'), '/tmp/ipc')
    ).rejects.toMatchObject({
      kind: 'missing-deps',
      missingDeps: ['jq'],
    } satisfies Partial<HostBootstrapError>)
  })

  it('reports availableAgents.codex=false when only codex is missing', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-no-codex',
      fakeConnection(calls, ' codex\n'),
      '/tmp/ipc'
    )
    expect(result.availableAgents).toEqual({ claude: true, codex: false })
  })

  it('reports availableAgents.claude=false when only claude is missing', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-no-claude',
      fakeConnection(calls, ' claude\n'),
      '/tmp/ipc'
    )
    expect(result.availableAgents).toEqual({ claude: false, codex: true })
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

  it('re-probes agent availability on cache hits (codex installed after first bootstrap)', async () => {
    // First call: codex missing on remote.
    let depsStdout = ' codex\n'
    const calls: string[][] = []
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        const script = argv[2]
        if (script.includes('command -v')) return ok(depsStdout)
        if (script === 'test -S "$1"') return ok()
        if (script.includes('XDG_CONFIG_HOME')) return ok('/home/dev/.config')
        return ok()
      },
    }

    const first = await bootstrapHost('host-reprobe', conn, '/tmp/ipc')
    expect(first.availableAgents).toEqual({ claude: true, codex: false })

    // User installs codex out-of-band; second call must reflect it.
    depsStdout = '\n'
    const second = await bootstrapHost('host-reprobe', conn, '/tmp/ipc')
    expect(second.availableAgents).toEqual({ claude: true, codex: true })

    // Sanity: the heavy install path didn't run twice. The "notify-v" install
    // command should appear at most once even though we bootstrapped twice.
    const installCalls = calls.filter((argv) =>
      argv.some((part) => part.includes(`notify-v${NOTIFY_SCRIPT_VERSION}.sh`))
    )
    expect(installCalls).toHaveLength(1)
  })

  it('throws install-failed when the agent probe times out on a cache hit', async () => {
    // Prime the cache with a successful first bootstrap.
    const calls: string[][] = []
    const okConn = fakeConnection(calls)
    await bootstrapHost('host-probe-fail', okConn, '/tmp/ipc')

    // Second call: probe times out. Must NOT silently report both agents
    // unavailable — that would surface as a misleading "<tool> not installed"
    // downstream.
    const failingConn: HostBootstrapConnection = {
      exec: async (argv) => {
        const script = argv[2]
        if (script.includes('command -v')) {
          return { stdout: '', stderr: '', code: 0, timedOut: true }
        }
        return ok()
      },
    }
    await expect(bootstrapHost('host-probe-fail', failingConn, '/tmp/ipc')).rejects.toMatchObject({
      kind: 'install-failed',
    })
  })

  it('throws install-failed when the agent probe exits non-zero on a cache hit', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-probe-nonzero', fakeConnection(calls), '/tmp/ipc')

    const failingConn: HostBootstrapConnection = {
      exec: async (argv) => {
        const script = argv[2]
        if (script.includes('command -v')) {
          return { stdout: '', stderr: 'permission denied', code: 1, timedOut: false }
        }
        return ok()
      },
    }
    await expect(
      bootstrapHost('host-probe-nonzero', failingConn, '/tmp/ipc')
    ).rejects.toMatchObject({ kind: 'install-failed' })
  })
})
