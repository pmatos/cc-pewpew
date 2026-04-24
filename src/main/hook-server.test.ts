import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  configDir: '',
  hookResult: true,
  hookCalls: [] as {
    method: string
    params: Record<string, unknown>
    originHostId: string | null
  }[],
  broadcasts: [] as { channel: string; payload: unknown }[],
}))

vi.mock('./config', () => ({
  get CONFIG_DIR() {
    return state.configDir
  },
}))

vi.mock('./window-registry', () => ({
  broadcastToAll: (channel: string, payload: unknown) => {
    state.broadcasts.push({ channel, payload })
  },
}))

vi.mock('./session-manager', () => ({
  handleHookEvent: (
    method: string,
    params: Record<string, unknown>,
    originHostId: string | null
  ) => {
    state.hookCalls.push({ method, params, originHostId })
    return state.hookResult
  },
}))

async function loadHookServer(): Promise<typeof import('./hook-server')> {
  vi.resetModules()
  hookServer = await import('./hook-server')
  return hookServer
}

let hookServer: typeof import('./hook-server') | null = null

function send(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.on('connect', () => {
      socket.write(JSON.stringify(payload) + '\n')
    })
    socket.on('data', (data) => {
      response += data.toString()
      if (response.includes('\n')) {
        socket.end()
        resolve(JSON.parse(response.trim()))
      }
    })
    socket.on('error', reject)
  })
}

describe('hook-server', () => {
  beforeEach(() => {
    state.configDir = mkdtempSync(join(tmpdir(), 'cc-pewpew-hook-'))
    state.hookResult = true
    state.hookCalls = []
    state.broadcasts = []
  })

  afterEach(async () => {
    hookServer?.stopHookServer()
    hookServer = null
    rmSync(state.configDir, { recursive: true, force: true })
  })

  it('listens on local and per-host sockets and tags originHostId', async () => {
    const mod = await loadHookServer()
    mod.startHookServer()
    const hostSocket = mod.listenHookServerForHost('h1')

    await send(join(state.configDir, 'ipc.sock'), {
      jsonrpc: '2.0',
      method: 'session.activity',
      params: { cwd: '/local' },
      id: 1,
    })
    await send(hostSocket, {
      jsonrpc: '2.0',
      method: 'session.activity',
      params: { cwd: '/remote' },
      id: 2,
    })

    expect(state.hookCalls.map((c) => c.originHostId)).toEqual([null, 'h1'])
    expect(
      state.broadcasts.map((b) => (b.payload as { originHostId: string | null }).originHostId)
    ).toEqual([null, 'h1'])
  })

  it('does not broadcast events dropped by session-origin validation', async () => {
    const mod = await loadHookServer()
    mod.startHookServer()
    const hostSocket = mod.listenHookServerForHost('h1')
    state.hookResult = false

    const response = await send(hostSocket, {
      jsonrpc: '2.0',
      method: 'session.stop',
      params: { session_id: 's1' },
      id: 3,
    })

    expect(response).toMatchObject({ jsonrpc: '2.0', result: 'ok', id: 3 })
    expect(state.hookCalls).toHaveLength(1)
    expect(state.hookCalls[0].originHostId).toBe('h1')
    expect(state.broadcasts).toEqual([])
  })
})
