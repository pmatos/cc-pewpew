import { BrowserWindow, Notification } from 'electron'
import type { Session } from '../shared/types'

export function notifyNeedsInput(session: Session): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: 'Session needs input',
    body: `${session.projectName}/${session.worktreeName}`,
  })

  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
      win.focus()
      win.webContents.send('sessions:open-detail', session.id)
    }
  })

  notification.show()
}
