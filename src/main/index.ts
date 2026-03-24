import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { copyFileSync, mkdirSync, chmodSync } from 'fs'
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer'
import { getConfig, saveConfig, resolvePath, CONFIG_DIR, type CanvasState } from './config'
import { scanProjects } from './project-scanner'
import { installHooks } from './hook-installer'
import { startHookServer, stopHookServer } from './hook-server'
import { startCapture, stopCapture } from './window-capture'
import { focusWindow } from './window-focus'
import { createTray } from './tray'
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
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'cc-pewpew',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

  ipcMain.handle('sessions:remove', (_event, id: string) => {
    removeSession(id)
  })

  ipcMain.handle('sessions:focus', async (_event, ghosttyClass: string, pid: number) => {
    await focusWindow(ghosttyClass, pid)
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

  restoreSessions()

  const mainWindow = createWindow()
  startHookServer(mainWindow)
  initSessionManager(mainWindow)
  startCapture(mainWindow)
  createTray(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      startHookServer(win)
    }
  })
})

app.on('before-quit', () => {
  stopCapture()
  stopHookServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
