import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { copyFileSync, mkdirSync, chmodSync } from 'fs'
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer'
import { getConfig, saveConfig, resolvePath, CONFIG_DIR, type CanvasState } from './config'
import { scanProjects } from './project-scanner'
import { installHooks } from './hook-installer'
import { startHookServer, stopHookServer } from './hook-server'
import { createTray } from './tray'
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
  getSessions,
  restoreSessions,
  killSession,
  removeWorktree,
  removeSession,
} from './session-manager'

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
    return scanProjects(dirs)
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

  ipcMain.handle('sessions:list', () => {
    return getSessions()
  })

  ipcMain.handle('sessions:kill', (_event, id: string) => {
    killSession(id)
  })

  ipcMain.handle('sessions:remove-worktree', async (_event, id: string) => {
    await removeWorktree(id)
  })

  ipcMain.handle('sessions:remove', async (_event, id: string) => {
    await removeSession(id)
  })

  ipcMain.handle('pty:write', (_event, sessionId: string, data: string) => {
    writePty(sessionId, data)
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

  const mainWindow = createWindow()
  startHookServer(mainWindow)
  initSessionManager(mainWindow)
  createTray(mainWindow)
  initPtyManager(mainWindow)
  restoreSessions()

  // Periodic text thumbnail capture from tmux
  const thumbInterval = setInterval(() => {
    if (mainWindow.isDestroyed()) return
    const thumbs = captureThumbnails()
    if (Object.keys(thumbs).length > 0) {
      mainWindow.webContents.send('thumbnails:text-updated', thumbs)
    }
  }, 3000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      startHookServer(win)
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
