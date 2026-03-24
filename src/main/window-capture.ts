import { desktopCapturer, type BrowserWindow } from 'electron'
import { getSessions } from './session-manager'

let captureInterval: ReturnType<typeof setInterval> | null = null
let mainWindowRef: BrowserWindow | null = null
const lastThumbnails = new Map<string, string>()

async function captureThumbnails(): Promise<void> {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return

  const sessions = getSessions()
  if (sessions.length === 0) return

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 400, height: 300 },
    })
  } catch {
    return
  }

  for (const session of sessions) {
    if (session.status === 'dead' || session.status === 'completed') continue

    const titlePattern = `${session.projectName}/${session.worktreeName}`
    const source = sources.find((s) => s.name.includes(titlePattern))

    if (source && !source.thumbnail.isEmpty()) {
      lastThumbnails.set(session.id, source.thumbnail.toDataURL())
    }
  }

  const thumbnailObj: Record<string, string> = {}
  for (const [id, data] of lastThumbnails) {
    thumbnailObj[id] = data
  }

  mainWindowRef.webContents.send('thumbnails:updated', thumbnailObj)
}

export function startCapture(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  captureInterval = setInterval(captureThumbnails, 3000)
  // Initial capture after short delay
  setTimeout(captureThumbnails, 1000)
}

export function stopCapture(): void {
  if (captureInterval) {
    clearInterval(captureInterval)
    captureInterval = null
  }
  mainWindowRef = null
}
