import { Notification } from 'electron'
import { focusWindow } from './window-focus'
import type { Session } from '../shared/types'

export function notifyNeedsInput(session: Session): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: 'Session needs input',
    body: `${session.projectName}/${session.worktreeName}`,
  })

  notification.on('click', () => {
    focusWindow(session.ghosttyClass, session.pid)
  })

  notification.show()
}
