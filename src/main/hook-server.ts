import { createServer, type Server, type Socket } from 'net'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { broadcastToAll } from './window-registry'
import { CONFIG_DIR } from './config'
import { sanitizeHostIdForPath } from './host-connection'
import { handleHookEvent } from './session-manager'

const LOCAL_SOCKET_PATH = join(CONFIG_DIR, 'ipc.sock')
const LOCAL_SOCKET_BREADCRUMB = join(CONFIG_DIR, 'socket-path')

const METHODS = new Set([
  'ping',
  'session.start',
  'session.stop',
  'session.activity',
  'session.end',
  'session.notification',
])

const servers = new Map<string, { server: Server; socketPath: string }>()

function originKey(originHostId: string | null): string {
  return originHostId ?? 'local'
}

function socketPathForOrigin(originHostId: string | null): string {
  // Sanitize hostId so a malformed/hand-edited value can't escape CONFIG_DIR
  // through path traversal segments.
  return originHostId
    ? join(CONFIG_DIR, `ipc-${sanitizeHostIdForPath(originHostId)}.sock`)
    : LOCAL_SOCKET_PATH
}

function unlinkIfPresent(path: string): void {
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // ignore stale socket cleanup failures; listen() will surface real errors
  }
}

function handleRequest(
  raw: string,
  originHostId: string | null
): { jsonrpc: string; result?: unknown; error?: unknown; id: unknown } | null {
  let req: { jsonrpc?: string; method?: string; params?: unknown; id?: unknown }
  try {
    req = JSON.parse(raw)
  } catch {
    return { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }
  }

  if (req.jsonrpc !== '2.0' || !req.method) {
    return {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: req.id ?? null,
    }
  }

  if (!METHODS.has(req.method)) {
    return {
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: req.id ?? null,
    }
  }

  if (req.method === 'ping') {
    return { jsonrpc: '2.0', result: 'pong', id: req.id ?? null }
  }

  const accepted = handleHookEvent(
    req.method,
    (req.params as Record<string, unknown>) ?? {},
    originHostId
  )

  if (accepted) {
    broadcastToAll('hook:event', {
      method: req.method,
      params: req.params,
      originHostId,
    })
  }

  return { jsonrpc: '2.0', result: 'ok', id: req.id ?? null }
}

function handleConnection(socket: Socket, originHostId: string | null): void {
  let buffer = ''

  socket.on('data', (data) => {
    buffer += data.toString()

    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (!line) continue

      const response = handleRequest(line, originHostId)
      if (response) {
        socket.write(JSON.stringify(response) + '\n')
      }
    }
  })

  socket.on('end', () => {
    if (buffer.trim()) {
      const response = handleRequest(buffer.trim(), originHostId)
      if (response) {
        socket.write(JSON.stringify(response) + '\n')
      }
    }
  })

  socket.on('error', () => {
    // Client disconnected, ignore
  })
}

function listenOrigin(originHostId: string | null): string {
  const key = originKey(originHostId)
  const existing = servers.get(key)
  if (existing) return existing.socketPath

  const socketPath = socketPathForOrigin(originHostId)
  unlinkIfPresent(socketPath)

  const server = createServer((socket) => handleConnection(socket, originHostId))
  server.listen(socketPath, () => {
    if (originHostId === null) {
      writeFileSync(LOCAL_SOCKET_BREADCRUMB, socketPath)
    }
  })

  server.on('error', (err) => {
    console.error('Hook server error:', err)
  })

  servers.set(key, { server, socketPath })
  return socketPath
}

export function startHookServer(): void {
  listenOrigin(null)
}

export function listenHookServerForHost(hostId: string): string {
  return listenOrigin(hostId)
}

export function stopHookServerForHost(hostId: string): void {
  const key = originKey(hostId)
  const entry = servers.get(key)
  if (!entry) return
  entry.server.close()
  servers.delete(key)
  unlinkIfPresent(entry.socketPath)
}

export function stopHookServer(): void {
  for (const [key, entry] of servers) {
    entry.server.close()
    servers.delete(key)
    unlinkIfPresent(entry.socketPath)
  }

  try {
    if (existsSync(LOCAL_SOCKET_BREADCRUMB)) unlinkSync(LOCAL_SOCKET_BREADCRUMB)
  } catch {
    // ignore
  }
}
