import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { copyFileSync, mkdirSync, chmodSync } from 'fs'
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer'
import { getConfig, resolvePath, CONFIG_DIR } from './config'
import { scanProjects } from './project-scanner'
import { installHooks } from './hook-installer'
import { startHookServer, stopHookServer } from './hook-server'

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

  const mainWindow = createWindow()
  startHookServer(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      startHookServer(win)
    }
  })
})

app.on('before-quit', () => {
  stopHookServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
