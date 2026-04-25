import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, resolve } from 'path'
import { copyFileSync, mkdirSync, chmodSync } from 'fs'
import {
  getConfig,
  saveConfig,
  resolvePath,
  CONFIG_DIR,
  shouldWarnGitignore,
  markGitignoreWarned,
  type CanvasState,
} from './config'
import { scanProjects } from './project-scanner'
import { installHooks, isSettingsGitignored } from './hook-installer'
import { startHookServer, stopHookServer } from './hook-server'
import { createTray } from './tray'
import { registerWindow, broadcastToAll } from './window-registry'
import {
  initPtyManager,
  stopPtyManager,
  writePty,
  resizePty,
  destroyPty,
  getScrollback,
  captureThumbnails,
} from './pty-manager'
import {
  initSessionManager,
  createSession,
  createSessionForWorktree,
  mirrorAllWorktrees,
  createPrSession,
  getSession,
  getSessions,
  restoreSessions,
  killSession,
  reviveSession,
  reconnectRemoteSession,
  removeWorktree,
  removeSession,
  relocateProject,
  updateLastKnownStatesBatch,
} from './session-manager'
import { parseDiff, synthesizeUntrackedFile } from './diff-parser'
import { listHosts, addHost, updateHost, deleteHost, getHost } from './host-registry'
import {
  testConnection,
  validateRemoteRepo,
  stopAllHostConnections,
  stopHostConnection,
  setOnHostConnectionStopped,
} from './host-connection'
import { invalidateBootstrap } from './host-bootstrap'
import { stopHookServerForHost } from './hook-server'
import {
  listRemoteProjects,
  addRemoteProject as persistRemoteProject,
  removeRemoteProject,
  toProject as remoteToProject,
  validateRemotePath,
} from './remote-project-registry'
import type { DiffMode, ValidateRemoteRepoReason } from '../shared/types'

// Use native Wayland rendering when available (avoids Xwayland scaling artifacts)
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

// Linux dual-GPU workaround: ANGLE/EGL initialization can fail inside AppImages
// or on systems with multiple GPUs (e.g. Intel iGPU + NVIDIA dGPU) because the
// bundled Chromium can't access the right driver libraries. If the user passed
// --disable-gpu on the command line, honour it; otherwise enable the Vulkan ANGLE
// backend which handles dual-GPU setups more reliably than the default EGL path.
if (process.platform === 'linux') {
  if (process.argv.includes('--disable-gpu')) {
    app.disableHardwareAcceleration()
  } else {
    // Prefer Vulkan backend — it sidesteps the EGL/GBM initialisation failures
    // seen on hybrid Intel+NVIDIA laptops under Wayland.
    app.commandLine.appendSwitch('use-angle', 'vulkan')
    app.commandLine.appendSwitch('enable-features', 'Vulkan')
    // If Vulkan also fails, Chromium will fall back to SwiftShader automatically.
  }
}

// Apply UI scale to the entire app (native menu bar + web content) before app is ready
const uiScale = getConfig().uiScale ?? 1.2
app.commandLine.appendSwitch('force-device-scale-factor', uiScale.toString())

function installNotifyScript(): void {
  const hooksDir = join(CONFIG_DIR, 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const src = join(__dirname, '../../hooks/notify.sh')
  const dest = join(hooksDir, 'notify.sh')
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
}

function createWindow(): BrowserWindow {
  const config = getConfig()
  const ws = config.windowState

  const mainWindow = new BrowserWindow({
    width: ws?.width ?? 1200,
    height: ws?.height ?? 800,
    x: ws?.x,
    y: ws?.y,
    title: 'cc-pewpew',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (ws?.maximized) {
    mainWindow.maximize()
  }

  mainWindow.on('close', () => {
    const bounds = mainWindow.getBounds()
    const maximized = mainWindow.isMaximized()
    const cfg = getConfig()
    cfg.windowState = { ...bounds, maximized }
    saveConfig(cfg)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      const { default: installExtension, REACT_DEVELOPER_TOOLS } =
        await import('electron-devtools-installer')
      await installExtension(REACT_DEVELOPER_TOOLS)
    } catch {
      // React DevTools install can fail in some environments
    }
  }

  installNotifyScript()

  ipcMain.handle('projects:scan', async () => {
    const config = getConfig()
    const dirs = config.scanDirs.map(resolvePath)
    const pinned = (config.pinnedPaths || []).map(resolvePath)
    const local = await scanProjects(dirs, pinned, config.followSymlinks, config.scanDepth)
    const remote = listRemoteProjects().map(remoteToProject)
    return [...local, ...remote].sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('projects:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('projects:relocate', async (_event, oldPath: string, newPath: string) => {
    return relocateProject(oldPath, newPath)
  })

  ipcMain.handle('projects:pin-path', async (_event, path: string) => {
    const config = getConfig()
    const resolved = resolve(path)
    if (!config.pinnedPaths.includes(resolved)) {
      config.pinnedPaths.push(resolved)
      saveConfig(config)
    }
  })

  ipcMain.handle('projects:add-remote', async (_event, input: { hostId: string; path: string }) => {
    const host = getHost(input.hostId)
    if (!host) throw new Error('Unknown host')
    // Normalize the path before the SSH probe so the remote check, dedup,
    // and persistence all see the same canonical form.
    const path = validateRemotePath(input.path)
    const result = await validateRemoteRepo(host.alias, path)
    if (!result.ok) {
      const labels: Record<ValidateRemoteRepoReason, string> = {
        'not-a-git-repo': 'Not a git repository',
        'auth-failed': 'Auth failed',
        network: 'Network error',
        'dep-missing': 'Missing dependency',
        unknown: 'ssh error',
      }
      const label = labels[result.reason ?? 'unknown']
      throw new Error(`${label}: ${result.message ?? 'unknown'}`)
    }
    return persistRemoteProject({
      hostId: input.hostId,
      path,
      repoFingerprint: result.fingerprint,
    })
  })

  ipcMain.handle('projects:remove-remote', async (_event, hostId: string, path: string) => {
    removeRemoteProject(hostId, path)
  })

  ipcMain.handle('projects:setup', async (_event, projectPath: string) => {
    await installHooks(projectPath)
  })

  ipcMain.handle('projects:create', async (_event, name: string) => {
    const config = getConfig()
    const dir = resolvePath(config.scanDirs[0] || '~/dev')
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const repoPath = join(dir, name)
    mkdirSync(repoPath, { recursive: true })
    await execFileAsync('git', ['init', repoPath])
  })

  ipcMain.handle('projects:open-file-manager', async (_event, path: string) => {
    await shell.openPath(path)
  })

  ipcMain.handle(
    'sessions:create',
    async (_event, projectPath: string, name?: string, hostId?: string | null) => {
      return createSession(projectPath, name, hostId ?? null)
    }
  )

  ipcMain.handle('sessions:create-pr', async (_event, projectPath: string, prNumber: number) => {
    return createPrSession(projectPath, prNumber)
  })

  async function gitignoreWarning(
    projectPath: string,
    checkPaths: string[]
  ): Promise<'gitignore' | undefined> {
    if (!shouldWarnGitignore(projectPath) || checkPaths.length === 0) return undefined
    for (const p of checkPaths) {
      if (!(await isSettingsGitignored(p))) {
        markGitignoreWarned(projectPath)
        return 'gitignore'
      }
    }
    // All checked worktrees ignore the file. Leave the project un-warned so a
    // later mirror of a branch that doesn't ignore it can still surface the
    // prompt.
    return undefined
  }

  ipcMain.handle('sessions:mirror', async (_event, projectPath: string, worktreePath: string) => {
    const session = await createSessionForWorktree(projectPath, worktreePath)
    const warning = await gitignoreWarning(projectPath, [session.worktreePath])
    return { session, warning }
  })

  ipcMain.handle('sessions:mirror-all', async (_event, projectPath: string) => {
    const result = await mirrorAllWorktrees(projectPath)
    const warning = await gitignoreWarning(
      projectPath,
      result.mirrored.map((s) => s.worktreePath)
    )
    return { result, warning }
  })

  ipcMain.handle('sessions:list', () => {
    return getSessions()
  })

  // Single-session handlers log and re-throw so the renderer can react (e.g.
  // DetailPane.handleRevive clears its "Reviving..." state on rejection).
  // Batch handlers below swallow per-session errors so one failure doesn't
  // abort a multi-select operation.
  ipcMain.handle('sessions:kill', async (_event, id: string) => {
    try {
      await killSession(id)
    } catch (err) {
      console.error(`Failed to kill session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:revive', async (_event, id: string) => {
    try {
      await reviveSession(id)
    } catch (err) {
      console.error(`Failed to revive session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:reconnect', async (_event, id: string) => {
    try {
      await reconnectRemoteSession(id)
    } catch (err) {
      console.error(`Failed to reconnect session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:remove-worktree', async (_event, id: string) => {
    await removeWorktree(id)
  })

  ipcMain.handle('sessions:remove', async (_event, id: string) => {
    try {
      await removeSession(id)
    } catch (err) {
      console.error(`Failed to remove session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:kill-batch', async (_event, ids: string[]) => {
    for (const id of ids) {
      try {
        await killSession(id)
      } catch (err) {
        console.error(`Failed to kill session ${id}:`, err)
      }
    }
  })

  ipcMain.handle('sessions:revive-batch', async (_event, ids: string[]) => {
    for (const id of ids) {
      try {
        await reviveSession(id)
      } catch (err) {
        console.error(`Failed to revive session ${id}:`, err)
      }
    }
  })

  ipcMain.handle('sessions:remove-batch', async (_event, ids: string[]) => {
    for (const id of ids) {
      try {
        await removeSession(id)
      } catch (err) {
        console.error(`Failed to remove session ${id}:`, err)
      }
    }
  })

  ipcMain.handle('pty:write', (_event, sessionId: string, data: string) => {
    writePty(sessionId, data)
  })

  ipcMain.handle('pty:write-batch', (_event, ids: string[], data: string) => {
    for (const id of ids) writePty(id, data)
  })

  ipcMain.handle('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows)
  })

  ipcMain.handle('pty:destroy', (_event, sessionId: string) => {
    destroyPty(sessionId)
  })

  ipcMain.handle('pty:scrollback', (_event, sessionId: string) => {
    return getScrollback(sessionId)
  })

  ipcMain.handle(
    'review:get-diff',
    async (_event, sessionId: string, mode: DiffMode, baseBranch?: string) => {
      const session = getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      const cwd = session.worktreePath || session.projectPath
      const { execFile: execFileCb } = await import('child_process')
      const { promisify: pfy } = await import('util')
      const { readFile } = await import('fs/promises')
      const execAsync = pfy(execFileCb)

      let diffArgs: string[]
      switch (mode) {
        case 'uncommitted': {
          // Check if HEAD exists — new repos with no commits have no HEAD
          try {
            await execAsync('git', ['rev-parse', 'HEAD'], { cwd })
            diffArgs = ['diff', 'HEAD']
          } catch {
            // No HEAD: diff staged+unstaged against the empty tree
            const { stdout: emptyTree } = await execAsync(
              'git',
              ['hash-object', '-t', 'tree', '/dev/null'],
              { cwd }
            )
            diffArgs = ['diff', emptyTree.trim()]
          }
          break
        }
        case 'unpushed':
          diffArgs = ['diff', '@{upstream}']
          break
        case 'branch':
          diffArgs = ['diff', `${baseBranch ?? 'main'}...`]
          break
      }

      const { stdout: rawDiff } = await execAsync('git', diffArgs, { cwd, maxBuffer: 10_000_000 })
      const files = parseDiff(rawDiff)

      if (mode === 'uncommitted') {
        const { stdout: untrackedRaw } = await execAsync(
          'git',
          ['ls-files', '--others', '--exclude-standard'],
          { cwd }
        )
        const { stat } = await import('fs/promises')
        const untrackedPaths = untrackedRaw.split('\n').filter(Boolean)
        const MAX_FILE_SIZE = 1_000_000 // 1MB
        for (const filePath of untrackedPaths) {
          const fullPath = join(cwd, filePath)
          const fileStat = await stat(fullPath).catch(() => null)
          if (!fileStat || fileStat.size > MAX_FILE_SIZE) continue
          const content = await readFile(fullPath, 'utf-8').catch(() => '')
          files.push(synthesizeUntrackedFile(filePath, content))
        }
      }

      return files
    }
  )

  ipcMain.handle('review:list-branches', async (_event, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const cwd = session.worktreePath || session.projectPath
    const { execFile: execFileCb } = await import('child_process')
    const { promisify: pfy } = await import('util')
    const execAsync = pfy(execFileCb)
    const { stdout } = await execAsync('git', ['branch', '-a', '--format=%(refname:short)'], {
      cwd,
    })
    return stdout.split('\n').filter(Boolean)
  })

  ipcMain.handle('review:get-default-branch', async (_event, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const cwd = session.worktreePath || session.projectPath
    const { execFile: execFileCb } = await import('child_process')
    const { promisify: pfy } = await import('util')
    const execAsync = pfy(execFileCb)
    try {
      const { stdout } = await execAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd,
      })
      const ref = stdout.trim()
      return ref.replace('refs/remotes/origin/', '')
    } catch {
      return 'main'
    }
  })

  ipcMain.handle('config:get-canvas', () => {
    return getConfig().canvas
  })

  ipcMain.handle('config:save-canvas', (_event, canvas: CanvasState) => {
    const config = getConfig()
    config.canvas = canvas
    saveConfig(config)
  })

  ipcMain.handle('config:get-clusters', () => {
    return getConfig().clusterPositions
  })

  ipcMain.handle(
    'config:save-clusters',
    (_event, positions: Record<string, { x: number; y: number }>) => {
      const config = getConfig()
      config.clusterPositions = positions
      saveConfig(config)
    }
  )

  ipcMain.handle('config:get-sidebar-width', () => {
    return getConfig().sidebarWidth
  })

  ipcMain.handle('config:save-sidebar-width', (_event, width: number) => {
    const config = getConfig()
    config.sidebarWidth = width
    saveConfig(config)
  })

  ipcMain.handle('config:get-ui-scale', () => {
    return getConfig().uiScale
  })

  ipcMain.handle('swim-lanes:open', (_event, sessionIds: string[]) => {
    const swimWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: `cc-pewpew — Swimming Lanes (${sessionIds.length})`,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    registerWindow(swimWindow)

    const query = `?sessions=${sessionIds.join(',')}`
    if (process.env.ELECTRON_RENDERER_URL) {
      swimWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/swim-lanes.html${query}`)
    } else {
      swimWindow.loadFile(join(__dirname, '../../dist/swim-lanes.html'), { search: query })
    }
  })

  ipcMain.handle('hosts:list', () => listHosts())
  ipcMain.handle('hosts:add', (_event, alias: string, label: string) => addHost({ alias, label }))
  ipcMain.handle('hosts:update', async (_event, hostId: string, alias: string, label: string) => {
    const previous = getHost(hostId)
    const updated = updateHost(hostId, { alias, label })
    if (previous && previous.alias !== alias) {
      invalidateBootstrap(hostId)
      await stopHostConnection(hostId).catch(() => undefined)
    }
    return updated
  })
  ipcMain.handle('hosts:delete', (_event, hostId: string) => deleteHost(hostId))
  ipcMain.handle('hosts:test-connection', async (_event, hostId: string) => {
    const host = getHost(hostId)
    if (!host) throw new Error('Unknown host')
    return testConnection(host.alias)
  })

  const mainWindow = createWindow()
  registerWindow(mainWindow, true)
  startHookServer()
  // Tear down the per-host hook listener whenever its SSH control connection
  // goes away, so long-running apps that cycle through many hosts don't
  // accumulate idle Unix-socket servers and ipc-<hostId>.sock files.
  setOnHostConnectionStopped((hostId) => stopHookServerForHost(hostId))
  initSessionManager()
  createTray()
  initPtyManager()
  restoreSessions()

  // Periodic text thumbnail capture from tmux.
  // Also snapshots `lastKnownState` from every live PTY buffer (local + remote)
  // so a remote session's cached preview survives the next app restart without
  // any new SSH traffic (issue #12 AC #1 / #9). The batch helper applies the
  // 10s per-session rate limit and emits a single persist + broadcast per
  // tick, avoiding an O(N) write storm when many sessions unlock the window
  // simultaneously.
  let thumbCaptureInFlight = false
  const thumbInterval = setInterval(() => {
    // Skip if the previous tick is still running. Remote captures await ssh
    // round-trips, so a slow host could otherwise stack overlapping ssh
    // fan-outs across ticks. Per-session results still surface as they settle
    // via the onCapture callback below — the in-flight guard only gates the
    // next batch start, not the broadcast cadence within a batch.
    if (thumbCaptureInFlight) return
    thumbCaptureInFlight = true
    void (async () => {
      try {
        const captured = await captureThumbnails({
          // Broadcast each thumbnail the instant its capture lands so a wedged
          // remote session timing out at the 3 s cap can't delay healthy
          // siblings' updates.
          onCapture: (sessionId, text) =>
            broadcastToAll('thumbnails:text-updated', { [sessionId]: text }),
        })
        // Persist directly from the captured Record. The Record is a snapshot
        // of capture-pane text at capture time, so it can't race the live PTY
        // stream that flows through the next 3 s tick — which would otherwise
        // pollute a fast session's clean capture text with raw streaming-tail
        // bytes while waiting for a slow sibling's exec to settle.
        const updates = Object.entries(captured).map(([id, text]) => ({ id, text }))
        if (updates.length > 0) updateLastKnownStatesBatch(updates)
      } finally {
        thumbCaptureInFlight = false
      }
    })()
  }, 3000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      registerWindow(win, true)
    }
  })

  // before-quit fires synchronously; Electron won't wait for async work unless
  // we preventDefault. Pattern: first fire → preventDefault, run teardown,
  // app.quit() re-enters and we let it through.
  let teardownStarted = false
  app.on('before-quit', (event) => {
    if (teardownStarted) return
    teardownStarted = true
    event.preventDefault()
    clearInterval(thumbInterval)
    stopPtyManager()
    stopHookServer()
    void (async () => {
      // Bound teardown so an unreachable host can't wedge shutdown.
      await Promise.race([
        stopAllHostConnections().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      app.quit()
    })()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
