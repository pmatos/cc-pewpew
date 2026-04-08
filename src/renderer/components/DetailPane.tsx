import { useEffect, useState } from 'react'
import Terminal from './Terminal'
import { useSessionsStore } from '../stores/sessions'

interface Props {
  sessionId: string
  sessionName: string
  onClose: () => void
}

export default function DetailPane({ sessionId, sessionName, onClose }: Props) {
  const session = useSessionsStore((s) => s.sessions.find((s) => s.id === sessionId))
  const isDead = session?.status === 'dead'
  const [reviving, setReviving] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTerminalFocused = target.closest('.terminal-container')
      if (e.key === 'Escape' && !isTerminalFocused) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  const handleRevive = async () => {
    setReviving(true)
    try {
      await window.api.reviveSession(sessionId)
    } catch {
      setReviving(false)
    }
  }

  return (
    <div className="detail-pane">
      <div className="detail-pane-header">
        <button
          className="detail-pane-close"
          onClick={onClose}
          aria-label="Back to canvas"
          title="Back to canvas"
        >
          ←
        </button>
        <span className="detail-pane-title">{sessionName}</span>
      </div>
      <div className="detail-pane-terminal">
        {isDead ? (
          <div className="dead-session-overlay">
            <div className="dead-session-content">
              <div className="dead-session-icon">&#x1f480;</div>
              <h3>Session terminated</h3>
              <p>
                This session&apos;s terminal was lost (e.g. after a reboot). You can restart a new
                terminal in the same worktree.
              </p>
              <button className="dead-session-restart" onClick={handleRevive} disabled={reviving}>
                {reviving ? 'Restarting...' : 'Restart terminal'}
              </button>
            </div>
          </div>
        ) : (
          <Terminal sessionId={sessionId} />
        )}
      </div>
    </div>
  )
}
