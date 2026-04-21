import { useEffect, useState, useCallback } from 'react'
import Terminal from './Terminal'
import ReviewOverlay from './ReviewOverlay'
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
  // Monotonic flip count — each toggle increments by 1, rotating +180deg.
  // Using a counter (instead of a boolean) keeps the rotation going in the
  // same direction on return instead of reversing.
  const [flipCount, setFlipCount] = useState(0)
  const reviewOpen = flipCount % 2 === 1

  const refocusTerminal = useCallback(() => {
    setTimeout(() => {
      const term = document.querySelector<HTMLElement>(
        '.detail-pane-terminal .xterm-helper-textarea'
      )
      term?.focus()
    }, 420)
  }, [])

  const closeReview = useCallback(() => {
    setFlipCount((c) => (c % 2 === 1 ? c + 1 : c))
    refocusTerminal()
  }, [refocusTerminal])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'r') {
        e.preventDefault()
        e.stopPropagation()
        setFlipCount((c) => {
          const next = c + 1
          if (next % 2 === 0) {
            // Flipping back to terminal — refocus after animation
            refocusTerminal()
          }
          return next
        })
        return
      }

      if (e.key === 'Escape') {
        if (reviewOpen) {
          e.preventDefault()
          e.stopPropagation()
          closeReview()
          return
        }
        const target = e.target as HTMLElement
        const isTerminalFocused = target.closest('.terminal-container')
        if (!isTerminalFocused) {
          e.stopPropagation()
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose, reviewOpen, closeReview, refocusTerminal])

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
          <div className="flip-container">
            <div className="flip-inner" style={{ transform: `rotateY(${flipCount * 180}deg)` }}>
              <div className="flip-front">
                <Terminal sessionId={sessionId} />
              </div>
              <div className="flip-back">
                {reviewOpen && <ReviewOverlay sessionId={sessionId} onClose={closeReview} />}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
