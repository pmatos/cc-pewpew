import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, Session } from '../shared/types'

// Hoisted state so vi.mock factories can reach mutable per-test values before
// the SUT imports run.
const state = vi.hoisted(() => ({
  configDir: '',
  liveTmuxIds: [] as string[],
  tmuxAvailable: true,
  repoFingerprint: undefined as string | undefined,
  hosts: [] as Host[],
  runtimeStates: new Map<string, string>(),
  // Call logs for assertion.
  ensureHostConnectionCalls: [] as string[],
  createRemotePtyCalls: [] as { sessionId: string; cwd: string; hostId: string }[],
  reattachRemotePtyCalls: [] as { sessionId: string; hostId: string }[],
  createPtyCalls: [] as { sessionId: string; cwd: string }[],
  reattachPtyCalls: [] as string[],
  hasRemoteTmuxResult: new Map<string, boolean>(),
  probeRemoteTmuxResult: new Map<string, 'present' | 'absent' | 'unreachable'>(),
  execRemoteCalls: [] as { hostId: string; argv: string[] }[],
  // Toggle to simulate ensureHostConnection throwing.
  ensureHostConnectionThrows: null as null | { message: string; runtimeStateAfter: string },
  // When set, delays next ensureHostConnection resolution (used for idempotency
  // and cascade tests).
  ensureHostConnectionGate: null as null | Promise<void>,
}))

vi.mock('./config', () => ({
  get CONFIG_DIR() {
    return state.configDir
  },
  getConfig: () => ({
    scanDirs: [],
    pinnedPaths: [],
    followSymlinks: true,
    canvas: { zoom: 1, panX: 0, panY: 0 },
    clusterPositions: {},
    sidebarWidth: 250,
    uiScale: 1,
    hosts: state.hosts,
    remoteProjects: [],
  }),
  saveConfig: vi.fn(),
}))

vi.mock('./window-registry', () => ({
  broadcastToAll: vi.fn(),
  getMainWindow: () => null,
}))

vi.mock('./tray', () => ({
  updateTray: vi.fn(),
  createTray: vi.fn(),
}))

vi.mock('./notifications', () => ({
  notifyNeedsInput: vi.fn(),
}))

vi.mock('./project-scanner', () => ({
  getRepoFingerprint: vi.fn(async () => state.repoFingerprint),
  gitWorktrees: vi.fn(async () => []),
}))

vi.mock('./hook-installer', () => ({
  installHooks: vi.fn(async () => undefined),
  installRemoteHooks: vi.fn(async () => undefined),
}))

vi.mock('./host-registry', () => ({
  getHost: (hostId: string) => state.hosts.find((h) => h.hostId === hostId),
}))

vi.mock('./remote-project-registry', () => ({
  listRemoteProjects: () => [],
}))

vi.mock('./hook-server', () => ({
  listenHookServerForHost: (hostId: string) => `/tmp/cc-pewpew-ipc-${hostId}.sock`,
}))

vi.mock('./host-bootstrap', () => ({
  bootstrapHost: vi.fn(async () => ({ notifyScriptPath: '/tmp/notify-v1.sh' })),
}))

vi.mock('./pty-manager', () => ({
  createPty: (sessionId: string, cwd: string) => {
    state.createPtyCalls.push({ sessionId, cwd })
  },
  detachPty: vi.fn(),
  destroyPty: vi.fn(),
  destroyRemotePty: vi.fn(async () => undefined),
  hasPty: vi.fn(() => false),
  hasTmuxSession: vi.fn(() => false),
  hasRemoteTmuxSession: vi.fn(async (sessionId: string) => {
    return state.hasRemoteTmuxResult.get(sessionId) ?? false
  }),
  probeRemoteTmuxSession: vi.fn(async (sessionId: string) => {
    const explicit = state.probeRemoteTmuxResult.get(sessionId)
    if (explicit) return explicit
    // Back-compat for tests written against hasRemoteTmuxResult: true →
    // present, false → absent. Tests that need 'unreachable' set it via
    // probeRemoteTmuxResult directly.
    return state.hasRemoteTmuxResult.get(sessionId) ? 'present' : 'absent'
  }),
  isTmuxAvailable: () => state.tmuxAvailable,
  discoverTmuxSessions: () => [...state.liveTmuxIds],
  reattachPty: (sessionId: string) => {
    state.reattachPtyCalls.push(sessionId)
  },
  reattachRemotePty: async (sessionId: string, host: Host) => {
    state.reattachRemotePtyCalls.push({ sessionId, hostId: host.hostId })
  },
  createRemotePty: async (sessionId: string, cwd: string, host: Host) => {
    state.createRemotePtyCalls.push({ sessionId, cwd, hostId: host.hostId })
  },
}))

vi.mock('./host-connection', () => ({
  ensureHostConnection: async (host: Host) => {
    state.ensureHostConnectionCalls.push(host.hostId)
    if (state.ensureHostConnectionGate) await state.ensureHostConnectionGate
    if (state.ensureHostConnectionThrows) {
      const stateAfter = state.ensureHostConnectionThrows.runtimeStateAfter
      state.runtimeStates.set(host.hostId, stateAfter)
      throw new Error(state.ensureHostConnectionThrows.message)
    }
    state.runtimeStates.set(host.hostId, 'live')
    return { remoteSocketPath: '/tmp/remote.sock', controlPath: '/tmp/cm.sock' }
  },
  exec: async (hostOrAlias: Host | string, argv: string[]) => {
    const hostId = typeof hostOrAlias === 'string' ? hostOrAlias : hostOrAlias.hostId
    state.execRemoteCalls.push({ hostId, argv })
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  },
  retainHostConnection: vi.fn(),
  releaseHostConnection: vi.fn(async () => undefined),
  stopHostConnection: vi.fn(async () => undefined),
  runtimeStateFor: (hostId: string) => state.runtimeStates.get(hostId),
  classifyConnectionFailure: (_code: number | null, _stderr: string) => 'offline',
}))

// Import SUT after all mocks are registered.
async function loadSessionManager(): Promise<typeof import('./session-manager')> {
  vi.resetModules()
  return import('./session-manager')
}

function writeSessionsJson(sessions: Partial<Session>[]): void {
  writeFileSync(join(state.configDir, 'sessions.json'), JSON.stringify(sessions))
}

function baseRemoteSession(overrides: Partial<Session>): Session {
  return {
    id: 'r1',
    hostId: 'h1',
    projectPath: '/remote/proj',
    projectName: 'proj',
    worktreeName: 'feat',
    worktreePath: '/remote/proj/.claude/worktrees/feat',
    branch: 'cc-pewpew/feat',
    pid: 0,
    tmuxSession: 'cc-pewpew-r1',
    status: 'idle',
    lastActivity: 1000,
    hookEvents: [],
    ...overrides,
  }
}

function baseLocalSession(overrides: Partial<Session>): Session {
  return {
    id: 'l1',
    hostId: null,
    projectPath: '/local/proj',
    projectName: 'proj',
    worktreeName: 'local-feat',
    worktreePath: join(state.configDir, 'local-wt'),
    branch: 'cc-pewpew/local-feat',
    pid: 0,
    tmuxSession: 'cc-pewpew-l1',
    status: 'idle',
    lastActivity: 1000,
    hookEvents: [],
    ...overrides,
  }
}

beforeEach(() => {
  state.configDir = mkdtempSync(join(tmpdir(), 'sess-mgr-'))
  state.liveTmuxIds = []
  state.tmuxAvailable = true
  state.repoFingerprint = undefined
  state.hosts = [{ hostId: 'h1', alias: 'devbox', label: 'Dev' }]
  state.runtimeStates = new Map()
  state.ensureHostConnectionCalls = []
  state.createRemotePtyCalls = []
  state.reattachRemotePtyCalls = []
  state.createPtyCalls = []
  state.reattachPtyCalls = []
  state.hasRemoteTmuxResult = new Map()
  state.probeRemoteTmuxResult = new Map()
  state.execRemoteCalls = []
  state.ensureHostConnectionThrows = null
  state.ensureHostConnectionGate = null
})

afterEach(() => {
  rmSync(state.configDir, { recursive: true, force: true })
})

describe('restoreSessions — remote lazy materialization', () => {
  it('materializes remote sessions in pending state and opens no SSH', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()
    expect(got).toHaveLength(1)
    expect(got[0].connectionState).toBe('pending')
    expect(got[0].status).toBe('idle')
    expect(state.ensureHostConnectionCalls).toEqual([])
    expect(state.createRemotePtyCalls).toEqual([])
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('round-trips lastKnownState across restore', async () => {
    writeSessionsJson([
      baseRemoteSession({
        id: 'r1',
        lastKnownState: { text: 'cached preview', timestamp: 42 },
      }),
    ])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.lastKnownState).toEqual({ text: 'cached preview', timestamp: 42 })
  })

  it('normalizes remote running → idle (mid-session crash normalization)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'running' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].status).toBe('idle')
    expect(sm.getSessions()[0].connectionState).toBe('pending')
  })

  it('preserves dead status and skips connectionState for confirmed-dead remote', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'dead' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].status).toBe('dead')
    expect(sm.getSessions()[0].connectionState).toBeUndefined()
  })

  it('preserves needs_input status on restore', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'needs_input' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].status).toBe('needs_input')
    expect(sm.getSessions()[0].connectionState).toBe('pending')
  })

  it('tolerates missing lastKnownState (fresh post-deploy restart)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].lastKnownState).toBeUndefined()
  })
})

describe('reconnectRemoteSession', () => {
  it('tmux present → reattach and mark live', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBe('live')
    expect(got.status).toBe('idle')
    expect(state.reattachRemotePtyCalls).toEqual([{ sessionId: 'r1', hostId: 'h1' }])
    expect(state.createRemotePtyCalls).toEqual([])
  })

  it('tmux gone → mark session dead without creating new PTY', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBe('offline')
    expect(state.createRemotePtyCalls).toEqual([])
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('auth-failed classification via runtimeStateFor', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied (publickey)',
      runtimeStateAfter: 'auth-failed',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow(/Permission denied/)

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBe('auth-failed')
    expect(got.status).toBe('idle')
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('network failure classified as unreachable', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Connection refused',
      runtimeStateAfter: 'unreachable',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow(/Connection refused/)

    expect(sm.getSessions()[0].connectionState).toBe('unreachable')
  })

  it('orphaned hostId → unreachable without SSH attempt', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', hostId: 'missing-host' })])
    state.hosts = [] // host registry empty
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow(/was removed/)

    expect(sm.getSessions()[0].connectionState).toBe('unreachable')
    expect(state.ensureHostConnectionCalls).toEqual([])
  })

  it('idempotency: concurrent calls coalesce into a single SSH attempt', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', true)
    let gateResolve!: () => void
    state.ensureHostConnectionGate = new Promise<void>((res) => {
      gateResolve = res
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const a = sm.reconnectRemoteSession('r1')
    const b = sm.reconnectRemoteSession('r1')
    gateResolve()
    await Promise.all([a, b])

    expect(state.ensureHostConnectionCalls).toEqual(['h1'])
    expect(state.reattachRemotePtyCalls).toHaveLength(1)
  })

  it('SSH probe failure on reconnect → unreachable, NOT dead', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.probeRemoteTmuxResult.set('r1', 'unreachable')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBe('unreachable')
    expect(got.status).toBe('idle')
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('triggers sibling batch probe even when first session ends dead (host is live)', async () => {
    writeSessionsJson([
      baseRemoteSession({ id: 'first', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    // First session: tmux gone, but host is live → dead outcome
    state.probeRemoteTmuxResult.set('first', 'absent')
    // Sibling: tmux alive
    state.probeRemoteTmuxResult.set('sibling', 'present')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('first')
    // Allow the fire-and-forget batch probe to complete.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['first'].status).toBe('dead')
    expect(byId['first'].connectionState).toBe('offline')
    // Critical: sibling was probed via the now-live host connection
    expect(byId['sibling'].connectionState).toBe('live')
  })

  it('retry succeeds after an auth-failed attempt (no app restart needed)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied',
      runtimeStateAfter: 'auth-failed',
    }
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow()
    expect(sm.getSessions()[0].connectionState).toBe('auth-failed')

    // User fixes SSH config → retry succeeds.
    state.ensureHostConnectionThrows = null
    await sm.reconnectRemoteSession('r1')

    expect(sm.getSessions()[0].connectionState).toBe('live')
    expect(state.ensureHostConnectionCalls).toEqual(['h1', 'h1'])
  })
})

describe('probePendingSessionsOnHost', () => {
  function threePendingOnH1(): Session[] {
    return [
      baseRemoteSession({ id: 'a', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'b', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'c', hostId: 'h1', status: 'idle' }),
    ] as Session[]
  }

  it('probes all pending siblings over the live control connection', async () => {
    writeSessionsJson(threePendingOnH1())
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('b', true)
    state.hasRemoteTmuxResult.set('c', true)
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    expect(sm.getSessions().every((s) => s.connectionState === 'live')).toBe(true)
    expect(state.ensureHostConnectionCalls).toEqual([])
    expect(state.reattachRemotePtyCalls.map((c) => c.sessionId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('marks only the tmux-gone sibling dead', async () => {
    writeSessionsJson(threePendingOnH1())
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('b', false)
    state.hasRemoteTmuxResult.set('c', true)
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].connectionState).toBe('live')
    expect(byId['b'].status).toBe('dead')
    expect(byId['b'].connectionState).toBe('offline')
    expect(byId['c'].connectionState).toBe('live')
  })

  it('short-circuits to auth-failed cascade with zero network', async () => {
    writeSessionsJson(threePendingOnH1())
    state.runtimeStates.set('h1', 'auth-failed')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    expect(sm.getSessions().every((s) => s.connectionState === 'auth-failed')).toBe(true)
    expect(state.execRemoteCalls).toEqual([])
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('SSH probe failure on a sibling → mark it unreachable and bail, do NOT downgrade rest to dead', async () => {
    writeSessionsJson(threePendingOnH1())
    state.probeRemoteTmuxResult.set('a', 'present')
    state.probeRemoteTmuxResult.set('b', 'unreachable')
    state.probeRemoteTmuxResult.set('c', 'present')
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].connectionState).toBe('live')
    expect(byId['b'].connectionState).toBe('unreachable')
    // c remains pending — we bail to avoid a flood of SSH calls on a bad host
    expect(byId['c'].connectionState).toBe('pending')
  })

  it('idempotency: concurrent batch probes coalesce', async () => {
    writeSessionsJson(threePendingOnH1())
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('b', true)
    state.hasRemoteTmuxResult.set('c', true)
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await Promise.all([sm.probePendingSessionsOnHost('h1'), sm.probePendingSessionsOnHost('h1')])

    expect(state.reattachRemotePtyCalls).toHaveLength(3)
  })
})

describe('updateLastKnownState', () => {
  it('persists text + timestamp; caps at 3 KiB; rate-limits to 10s per session', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    // First write goes through.
    const big = 'x'.repeat(5 * 1024)
    sm.updateLastKnownState('r1', big)
    let got = sm.getSessions()[0]
    expect(got.lastKnownState?.text.length).toBe(3 * 1024)
    expect(got.lastKnownState?.timestamp).toBeGreaterThan(0)
    const firstTs = got.lastKnownState!.timestamp

    // Second write within the 10s window is dropped.
    sm.updateLastKnownState('r1', 'newer')
    got = sm.getSessions()[0]
    expect(got.lastKnownState?.timestamp).toBe(firstTs)
    expect(got.lastKnownState?.text).not.toBe('newer')
  })
})

describe('restoreSessions — local path unchanged (AC #10 regression)', () => {
  it('reattaches a local session with a live tmux', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    state.liveTmuxIds = ['l1']
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('idle')
    expect(got.connectionState).toBeUndefined()
    expect(state.reattachPtyCalls).toEqual(['l1'])
    expect(state.ensureHostConnectionCalls).toEqual([])
  })
})
