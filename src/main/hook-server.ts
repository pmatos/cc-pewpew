import { createServer, type Server, type Socket } from 'net'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { type BrowserWindow } from 'electron'
import { CONFIG_DIR } from './config'

const SOCKET_PATH = join(CONFIG_DIR, 'ipc.sock')
const SOCKET_BREADCRUMB = join(CONFIG_DIR, 'socket-path')

const METHODS = new Set([
  'ping',
  'session.start',
  'session.stop',
  'session.activity',
  'session.end',
  'session.notification',
])

let server: Server | null = null
let mainWindowRef: BrowserWindow | null = null

function handleRequest(
  raw: string
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

  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('hook:event', {
      method: req.method,
      params: req.params,
    })
  }

  return { jsonrpc: '2.0', result: 'ok', id: req.id ?? null }
}

function handleConnection(socket: Socket): void {
  let buffer = ''

  socket.on('data', (data) => {
    buffer += data.toString()

    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (!line) continue

      const response = handleRequest(line)
      if (response) {
        socket.write(JSON.stringify(response) + '\n')
      }
    }

    // Handle single message without trailing newline (connection close flushes)
  })

  socket.on('end', () => {
    if (buffer.trim()) {
      const response = handleRequest(buffer.trim())
      if (response) {
        socket.write(JSON.stringify(response) + '\n')
      }
    }
  })

  socket.on('error', () => {
    // Client disconnected, ignore
  })
}

export function startHookServer(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow

  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH)
    } catch {
      // ignore
    }
  }

  server = createServer(handleConnection)

  server.listen(SOCKET_PATH, () => {
    writeFileSync(SOCKET_BREADCRUMB, SOCKET_PATH)
  })

  server.on('error', (err) => {
    console.error('Hook server error:', err)
  })
}

export function stopHookServer(): void {
  if (server) {
    server.close()
    server = null
  }

  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)
  } catch {
    // ignore
  }
  try {
    if (existsSync(SOCKET_BREADCRUMB)) unlinkSync(SOCKET_BREADCRUMB)
  } catch {
    // ignore
  }

  mainWindowRef = null
}
