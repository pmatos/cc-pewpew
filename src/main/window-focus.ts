import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const SESSION_TYPE = process.env.XDG_SESSION_TYPE || ''
const DESKTOP = process.env.XDG_CURRENT_DESKTOP || ''

async function focusViaGhosttyDBus(ghosttyClass: string): Promise<boolean> {
  try {
    await execFileAsync(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        ghosttyClass,
        '--object-path',
        `/${ghosttyClass.replace(/\./g, '/')}`,
        '--method',
        'org.gtk.Actions.Activate',
        'present-surface',
        '[]',
        '{}',
      ],
      { timeout: 3000 }
    )
    return true
  } catch {
    return false
  }
}

async function focusViaNiri(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('niri', ['msg', '--json', 'windows'], { timeout: 3000 })
    const windows = JSON.parse(stdout)
    const win = windows.find((w: { pid: number }) => w.pid === pid)
    if (!win) return false
    await execFileAsync('niri', ['msg', 'action', 'focus-window', '--id', String(win.id)], {
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

async function focusViaXdotool(ghosttyClass: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('xdotool', ['search', '--class', ghosttyClass], {
      timeout: 3000,
    })
    const wid = stdout.trim().split('\n')[0]
    if (!wid) return false
    await execFileAsync('xdotool', ['windowactivate', wid], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export async function focusWindow(ghosttyClass: string, pid: number): Promise<void> {
  // Try GTK D-Bus present-surface first (works on most Wayland compositors)
  if (await focusViaGhosttyDBus(ghosttyClass)) return

  // Try compositor-specific IPC
  if (DESKTOP.toLowerCase().includes('niri')) {
    if (await focusViaNiri(pid)) return
  }

  // X11 fallback
  if (SESSION_TYPE === 'x11') {
    if (await focusViaXdotool(ghosttyClass)) return
  }

  // Last resort: try xdotool anyway (XWayland)
  await focusViaXdotool(ghosttyClass)
}
