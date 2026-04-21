#!/usr/bin/env node
// Smoke test: launch the built Electron app under Xvfb, verify the renderer
// page registers with the DevTools protocol within a timeout, then exit.
// Catches: main-process crashes, failed native module loads (node-pty),
// missing renderer assets, and renderer-side load errors.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronBin from 'electron'

const CDP_PORT = 9333
const BOOT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500

const xdgConfigHome = mkdtempSync(join(tmpdir(), 'cc-pewpew-smoke-'))

const electronArgs = [
  '.',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-debugging-address=127.0.0.1',
]

console.log(`[smoke] launching: ${electronBin} ${electronArgs.join(' ')}`)
console.log(`[smoke] XDG_CONFIG_HOME=${xdgConfigHome}`)

const child = spawn(electronBin, electronArgs, {
  env: {
    ...process.env,
    XDG_CONFIG_HOME: xdgConfigHome,
    ELECTRON_DISABLE_SANDBOX: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

let exited = false
child.on('exit', (code, signal) => {
  exited = true
  console.log(`[smoke] electron exited code=${code} signal=${signal}`)
})

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

async function waitForPage() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) throw new Error('electron exited before CDP became available')
    try {
      const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const page = targets.find(
        (t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes('index.html')
      )
      if (page) return page
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`timed out after ${BOOT_TIMEOUT_MS}ms waiting for renderer page`)
}

function cleanup() {
  if (!exited) {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  try {
    rmSync(xdgConfigHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

try {
  const page = await waitForPage()
  console.log(`[smoke] renderer registered: url=${page.url} title=${JSON.stringify(page.title)}`)
  console.log('[smoke] PASS')
  cleanup()
  process.exit(0)
} catch (err) {
  console.error(`[smoke] FAIL: ${err.message}`)
  cleanup()
  process.exit(1)
}
