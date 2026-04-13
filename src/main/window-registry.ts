import { BrowserWindow } from 'electron'

const windows = new Set<BrowserWindow>()
let mainWindow: BrowserWindow | null = null

export function registerWindow(win: BrowserWindow, isMain = false): void {
  windows.add(win)
  if (isMain) mainWindow = win
  win.on('closed', () => {
    windows.delete(win)
    if (win === mainWindow) mainWindow = null
  })
}

export function unregisterWindow(win: BrowserWindow): void {
  windows.delete(win)
  if (win === mainWindow) mainWindow = null
}

export function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}
