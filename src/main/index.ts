import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, resolve } from 'path'
import { copyFileSync, mkdirSync, chmodSync } from 'fs'
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer'
import { getConfig, saveConfig, resolvePath, CONFIG_DIR, type CanvasState } from './config'
import { scanProjects } from './project-scanner'
import { installHooks } from './hook-installer'
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
  createPrSession,
  getSession,
  getSessions,
  restoreSessions,
  killSession,
  reviveSession,
  removeWorktree,
  removeSession,
  relocateProject,
} from './session-manager'
import { parseDiff, synthesizeUntrackedFile } from './diff-parser'
import type { DiffMode } from '../shared/types'

// Use native Wayland rendering when available (avoids Xwayland scaling artifacts)
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

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
    return scanProjects(dirs, pinned, config.followSymlinks)
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

  ipcMain.handle('sessions:create', async (_event, projectPath: string, name?: string) => {
    return createSession(projectPath, name)
  })

  ipcMain.handle('sessions:create-pr', async (_event, projectPath: string, prNumber: number) => {
    return createPrSession(projectPath, prNumber)
  })

  ipcMain.handle('sessions:list', () => {
    return getSessions()
  })

  ipcMain.handle('sessions:kill', (_event, id: string) => {
    killSession(id)
  })

  ipcMain.handle('sessions:revive', (_event, id: string) => {
    reviveSession(id)
  })

  ipcMain.handle('sessions:remove-worktree', async (_event, id: string) => {
    await removeWorktree(id)
  })

  ipcMain.handle('sessions:remove', async (_event, id: string) => {
    await removeSession(id)
  })

  ipcMain.handle('sessions:kill-batch', (_event, ids: string[]) => {
    for (const id of ids) killSession(id)
  })

  ipcMain.handle('sessions:revive-batch', (_event, ids: string[]) => {
    for (const id of ids) {
      try {
        reviveSession(id)
      } catch {}
    }
  })

  ipcMain.handle('sessions:remove-batch', async (_event, ids: string[]) => {
    for (const id of ids) await removeSession(id)
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
            diffArgs = ['diff', '--cached']
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

  const mainWindow = createWindow()
  registerWindow(mainWindow, true)
  startHookServer()
  initSessionManager()
  createTray()
  initPtyManager()
  restoreSessions()

  // Periodic text thumbnail capture from tmux
  const thumbInterval = setInterval(() => {
    const thumbs = captureThumbnails()
    if (Object.keys(thumbs).length > 0) {
      broadcastToAll('thumbnails:text-updated', thumbs)
    }
  }, 3000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      registerWindow(win, true)
    }
  })

  app.on('before-quit', () => {
    clearInterval(thumbInterval)
    stopPtyManager()
    stopHookServer()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
