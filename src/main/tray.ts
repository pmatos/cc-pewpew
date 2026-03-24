import { Tray, Menu, nativeImage, type BrowserWindow, app } from 'electron'
import type { Session } from '../shared/types'

let tray: Tray | null = null
let mainWindowRef: BrowserWindow | null = null

function createTrayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="6" fill="#4ade80"/>
    <circle cx="8" cy="8" r="3" fill="#1a1a2e"/>
  </svg>`
  const encoded = Buffer.from(svg).toString('base64')
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${encoded}`)
}

function showAndOpenSession(sessionId: string): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return
  mainWindowRef.show()
  mainWindowRef.focus()
  mainWindowRef.webContents.send('sessions:open-detail', sessionId)
}

export function createTray(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  tray = new Tray(createTrayIcon())
  tray.setToolTip('cc-pewpew — 0 sessions')

  tray.on('click', () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return
    if (mainWindowRef.isVisible()) {
      mainWindowRef.hide()
    } else {
      mainWindowRef.show()
      mainWindowRef.focus()
    }
  })

  updateTray([])
}

export function updateTray(sessions: Session[]): void {
  if (!tray) return

  tray.setToolTip(`cc-pewpew — ${sessions.length} session${sessions.length !== 1 ? 's' : ''}`)

  const needsInput = sessions.filter((s) => s.status === 'needs_input')

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Show cc-pewpew',
      click: () => {
        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
          mainWindowRef.show()
          mainWindowRef.focus()
        }
      },
    },
    { type: 'separator' },
  ]

  if (needsInput.length > 0) {
    for (const session of needsInput) {
      menuItems.push({
        label: `${session.projectName}/${session.worktreeName}`,
        click: () => showAndOpenSession(session.id),
      })
    }
    menuItems.push({ type: 'separator' })
  }

  menuItems.push({
    label: 'Quit',
    click: () => app.quit(),
  })

  tray.setContextMenu(Menu.buildFromTemplate(menuItems))
}
