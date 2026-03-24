import { useSessionsStore } from '../stores/sessions'
import SessionCard from './SessionCard'

export default function SessionCanvas() {
  const { sessions, thumbnails } = useSessionsStore()

  if (sessions.length === 0) {
    return (
      <div className="canvas-empty">
        <span className="canvas-placeholder">No sessions</span>
      </div>
    )
  }

  return (
    <div className="session-canvas">
      {sessions.map((session) => (
        <SessionCard key={session.id} session={session} thumbnail={thumbnails[session.id]} />
      ))}
    </div>
  )
}
