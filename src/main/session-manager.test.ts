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
  detachPtyCalls: [] as string[],
  hasRemoteTmuxResult: new Map<string, boolean>(),
  probeRemoteTmuxResult: new Map<string, 'present' | 'absent' | 'unreachable'>(),
  // Per-session side effect fired before the probe resolves. Lets tests
  // simulate a concurrent reconnect advancing another session's state while
  // the batch is in flight.
  probeSideEffect: new Map<string, () => void>(),
  runtimeRefs: new Map<string, number>(),
  sessionsUpdatedBroadcasts: 0,
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
  broadcastToAll: (channel: string) => {
    if (channel === 'sessions:updated') state.sessionsUpdatedBroadcasts++
  },
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
  detachPty: (sessionId: string) => {
    state.detachPtyCalls.push(sessionId)
  },
  destroyPty: vi.fn(),
  destroyRemotePty: vi.fn(async () => undefined),
  hasPty: vi.fn(() => false),
  hasTmuxSession: vi.fn(() => false),
  hasRemoteTmuxSession: vi.fn(async (sessionId: string) => {
    return state.hasRemoteTmuxResult.get(sessionId) ?? false
  }),
  probeRemoteTmuxSession: vi.fn(async (sessionId: string) => {
    const effect = state.probeSideEffect.get(sessionId)
    if (effect) effect()
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
    // Match production: reattachRemotePty retains the host runtime for the
    // PTY's lifetime so the runtime survives the caller's release.
    state.runtimeRefs.set(host.hostId, (state.runtimeRefs.get(host.hostId) ?? 0) + 1)
  },
  createRemotePty: async (sessionId: string, cwd: string, host: Host) => {
    state.createRemotePtyCalls.push({ sessionId, cwd, hostId: host.hostId })
    state.runtimeRefs.set(host.hostId, (state.runtimeRefs.get(host.hostId) ?? 0) + 1)
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
  retainHostConnection: vi.fn((hostId: string) => {
    state.runtimeRefs.set(hostId, (state.runtimeRefs.get(hostId) ?? 0) + 1)
  }),
  // Match production: releaseHostConnection decrements refcount; on zero it
  // delegates to stopHostConnection which wipes the runtime entry. That delete
  // is what makes the sibling-batch cascade dependent on a state hint
  // captured BEFORE the release.
  releaseHostConnection: vi.fn(async (hostId: string) => {
    const refs = (state.runtimeRefs.get(hostId) ?? 0) - 1
    if (refs <= 0) {
      state.runtimeRefs.delete(hostId)
      state.runtimeStates.delete(hostId)
    } else {
      state.runtimeRefs.set(hostId, refs)
    }
  }),
  stopHostConnection: vi.fn(async (hostId: string) => {
    state.runtimeRefs.delete(hostId)
    state.runtimeStates.delete(hostId)
  }),
  runtimeStateFor: (hostId: string) => state.runtimeStates.get(hostId),
  classifyConnectionFailure: (_code: number | null, _stderr: string) => 'offline',
  startBootstrapWindow: () => () => {},
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
    tool: 'claude',
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
    tool: 'claude',
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
  state.detachPtyCalls = []
  state.hasRemoteTmuxResult = new Map()
  state.probeRemoteTmuxResult = new Map()
  state.runtimeRefs = new Map()
  state.sessionsUpdatedBroadcasts = 0
  state.probeSideEffect = new Map()
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

  it('auth-failed reconnect cascades to sibling pending sessions without new SSH', async () => {
    writeSessionsJson([
      baseRemoteSession({ id: 'clicked', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling1', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling2', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied',
      runtimeStateAfter: 'auth-failed',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('clicked')).rejects.toThrow(/Permission denied/)
    // Let the fire-and-forget batch probe complete.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['clicked'].connectionState).toBe('auth-failed')
    expect(byId['sibling1'].connectionState).toBe('auth-failed')
    expect(byId['sibling2'].connectionState).toBe('auth-failed')
    // Only one SSH attempt (the clicked one). No probe calls for siblings.
    expect(state.ensureHostConnectionCalls).toEqual(['h1'])
    expect(state.execRemoteCalls).toEqual([])
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

  it('keeps host runtime alive through sibling batch probe on absent outcome', async () => {
    // Regression guard for two issues in one: (a) sibling probe must still
    // run when the clicked session's outcome is `absent` (no PTY retain), and
    // (b) the ControlMaster must stay up through the batch so sibling probes
    // reuse the existing ControlPath instead of spawning fresh SSH per card.
    writeSessionsJson([
      baseRemoteSession({ id: 'first', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.probeRemoteTmuxResult.set('first', 'absent')
    state.probeRemoteTmuxResult.set('sibling', 'present')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('first')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['first'].status).toBe('dead')
    expect(byId['sibling'].connectionState).toBe('live')
    // Only one ensureHostConnection call — siblings reused the ControlMaster
    // from the clicked session's reconnect (one SSH handshake, not N).
    expect(state.ensureHostConnectionCalls).toEqual(['h1'])
    // Sibling's reattach kept the runtime alive (refs=1 from sibling PTY).
    // The test would have failed if doReconnect released before the batch
    // probed siblings, because execRemote would then fall off the ControlPath
    // fast path and classifySshExit… actually, a more direct check: only one
    // SSH connection was opened total.
    expect(state.runtimeRefs.get('h1')).toBe(1)
  })

  it('releases retain when absent outcome has no sibling to retain the runtime', async () => {
    // Only one session on the host; clicked reconnect ends `absent`. After
    // the batch completes with no live siblings, the retain chain unwinds to
    // zero and the runtime is torn down.
    writeSessionsJson([
      baseRemoteSession({ id: 'lonely', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.probeRemoteTmuxResult.set('lonely', 'absent')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('lonely')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.runtimeStates.has('h1')).toBe(false)
    expect(state.runtimeRefs.has('h1')).toBe(false)
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

  it('releases host retain when session is removed mid-reconnect', async () => {
    // doReconnectRemoteSession returns retainedForBatch=true; the outer caller
    // owns releasing it. If `sessions.get(id)` is read after the await without
    // a fallback, a concurrent removeSession() would leave hostId undefined
    // and neither the batch nor the direct release path would run — the
    // ControlMaster would leak for the lifetime of the app.
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })] as Session[])
    state.probeRemoteTmuxResult.set('r1', 'absent')
    let gateResolve!: () => void
    state.ensureHostConnectionGate = new Promise<void>((res) => {
      gateResolve = res
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const reconnectPromise = sm.reconnectRemoteSession('r1')
    // Allow doReconnectRemoteSession's synchronous prelude to run and park at
    // the gated `await ensureHostConnection`.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await sm.removeSession('r1')
    gateResolve()
    await reconnectPromise
    // Allow the fire-and-forget batch + release to complete.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.runtimeRefs.has('h1')).toBe(false)
    expect(state.runtimeStates.has('h1')).toBe(false)
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

  it('skips a sibling whose state advanced out of pending during the batch', async () => {
    // If a concurrent reconnect moves a sibling out of `pending` while the
    // batch is iterating, the batch must not re-probe/reattach it (doing so
    // would duplicate the remote attach and leak refs).
    writeSessionsJson(threePendingOnH1())
    state.probeRemoteTmuxResult.set('a', 'present')
    state.probeRemoteTmuxResult.set('b', 'present')
    state.probeRemoteTmuxResult.set('c', 'present')
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    // When the batch probes 'a' (first sibling in the snapshot), flip 'b'
    // out of pending — simulating a concurrent reconnect on 'b' completing
    // mid-batch.
    state.probeSideEffect.set('a', () => {
      const bSession = sm.getSessions().find((s) => s.id === 'b')!
      bSession.connectionState = 'live'
      bSession.status = 'idle'
    })

    await sm.probePendingSessionsOnHost('h1')

    // 'b' must not have been reattached by the batch (state ≠ pending).
    const bReattaches = state.reattachRemotePtyCalls.filter((c) => c.sessionId === 'b').length
    expect(bReattaches).toBe(0)
    // 'a' and 'c' still got reattached.
    const aReattaches = state.reattachRemotePtyCalls.filter((c) => c.sessionId === 'a').length
    const cReattaches = state.reattachRemotePtyCalls.filter((c) => c.sessionId === 'c').length
    expect(aReattaches).toBe(1)
    expect(cReattaches).toBe(1)
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

describe('updateLastKnownStatesBatch', () => {
  it('persists once per batch regardless of session count', async () => {
    writeSessionsJson([
      baseRemoteSession({ id: 'a', hostId: 'h1' }),
      baseRemoteSession({ id: 'b', hostId: 'h1' }),
      baseRemoteSession({ id: 'c', hostId: 'h1' }),
    ] as Session[])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const before = state.sessionsUpdatedBroadcasts

    sm.updateLastKnownStatesBatch([
      { id: 'a', text: 'aaa' },
      { id: 'b', text: 'bbb' },
      { id: 'c', text: 'ccc' },
    ])

    expect(state.sessionsUpdatedBroadcasts - before).toBe(1)
    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].lastKnownState?.text).toBe('aaa')
    expect(byId['b'].lastKnownState?.text).toBe('bbb')
    expect(byId['c'].lastKnownState?.text).toBe('ccc')
  })

  it('does not persist when every update is rate-limited', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'a' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    sm.updateLastKnownStatesBatch([{ id: 'a', text: 'first' }])
    const afterFirst = state.sessionsUpdatedBroadcasts

    // Immediate second call: rate-limited, must not trigger another broadcast.
    sm.updateLastKnownStatesBatch([{ id: 'a', text: 'second' }])

    expect(state.sessionsUpdatedBroadcasts - afterFirst).toBe(0)
  })

  it('skips write when text is unchanged across rate-limit windows', async () => {
    // Idle sessions emit identical thumbnail text every 3s tick. Once the
    // 10s rate-limit elapses, the gate would otherwise fire a write +
    // broadcast every 10s indefinitely. The text-equality early-return
    // turns this into a no-op for stable sessions.
    writeSessionsJson([baseRemoteSession({ id: 'a' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    sm.updateLastKnownStatesBatch([{ id: 'a', text: 'idle prompt $' }])
    const afterFirst = state.sessionsUpdatedBroadcasts

    // Advance past the 10s rate-limit window.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 11_000)
    try {
      sm.updateLastKnownStatesBatch([{ id: 'a', text: 'idle prompt $' }])
      expect(state.sessionsUpdatedBroadcasts - afterFirst).toBe(0)

      // A real text change still goes through.
      sm.updateLastKnownStatesBatch([{ id: 'a', text: 'idle prompt $ ls' }])
      expect(state.sessionsUpdatedBroadcasts - afterFirst).toBe(1)
    } finally {
      vi.useRealTimers()
    }
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

describe('removeSessionsForHost (issue #14)', () => {
  it('drops only the matching host, detaches PTY for each, and broadcasts once', async () => {
    state.hosts = [
      { hostId: 'A', alias: 'a', label: 'A' },
      { hostId: 'B', alias: 'b', label: 'B' },
    ]
    writeSessionsJson([
      baseRemoteSession({ id: 'rA1', hostId: 'A' }),
      baseRemoteSession({ id: 'rA2', hostId: 'A', worktreeName: 'feat-2' }),
      baseRemoteSession({ id: 'rB1', hostId: 'B' }),
    ])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    state.sessionsUpdatedBroadcasts = 0

    sm.removeSessionsForHost('A')

    const remaining = sm.getSessions()
    expect(remaining.map((s) => s.id)).toEqual(['rB1'])
    expect(state.detachPtyCalls.sort()).toEqual(['rA1', 'rA2'])
    expect(state.sessionsUpdatedBroadcasts).toBe(1)
  })

  it('skips persist + broadcast when no sessions match', async () => {
    state.hosts = [{ hostId: 'A', alias: 'a', label: 'A' }]
    writeSessionsJson([baseRemoteSession({ id: 'rA1', hostId: 'A' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    state.sessionsUpdatedBroadcasts = 0

    sm.removeSessionsForHost('does-not-exist')

    expect(sm.getSessions().map((s) => s.id)).toEqual(['rA1'])
    expect(state.detachPtyCalls).toEqual([])
    expect(state.sessionsUpdatedBroadcasts).toBe(0)
  })
})

describe('codex agent integration', () => {
  it('backfills tool="claude" on legacy sessions missing the field', async () => {
    // Persisted JSON omits `tool` to simulate a session created before the
    // multi-agent change; restoreSessions must default it without crashing.
    writeFileSync(
      join(state.configDir, 'sessions.json'),
      JSON.stringify([
        {
          id: 'legacy1',
          hostId: null,
          projectPath: '/p',
          projectName: 'p',
          worktreeName: 'w',
          worktreePath: '/p/w',
          branch: 'main',
          pid: 0,
          tmuxSession: 'cc-pewpew-legacy1',
          status: 'idle',
          lastActivity: 0,
          hookEvents: [],
        },
      ])
    )
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const restored = sm.getSessions().find((s) => s.id === 'legacy1')
    expect(restored?.tool).toBe('claude')
  })

  it('handleHookEvent session.start captures codex session_id as agentSessionId', async () => {
    writeSessionsJson([baseLocalSession({ id: 'cx1', tool: 'codex', worktreePath: '/cx/wt' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.start', { cwd: '/cx/wt', session_id: 'codex-uuid-9' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cx1')
    expect(updated?.agentSessionId).toBe('codex-uuid-9')
  })

  it('handleHookEvent session.stop sets needs_input for codex sessions (parity with claude)', async () => {
    writeSessionsJson([baseLocalSession({ id: 'cx2', tool: 'codex', worktreePath: '/cx/wt2' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.stop', { cwd: '/cx/wt2' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cx2')
    expect(updated?.status).toBe('needs_input')
  })

  it('does not overwrite agentSessionId once captured', async () => {
    writeSessionsJson([
      baseLocalSession({
        id: 'cx3',
        tool: 'codex',
        worktreePath: '/cx/wt3',
        agentSessionId: 'first',
      }),
    ])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.start', { cwd: '/cx/wt3', session_id: 'second' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cx3')
    expect(updated?.agentSessionId).toBe('first')
  })

  it('claude session.start does not set agentSessionId', async () => {
    writeSessionsJson([baseLocalSession({ id: 'cl1', tool: 'claude', worktreePath: '/cl/wt' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.start', { cwd: '/cl/wt', session_id: 'should-not-store' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cl1')
    expect(updated?.agentSessionId).toBeUndefined()
  })
})
