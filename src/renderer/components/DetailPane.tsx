import { useEffect } from 'react'
import Terminal from './Terminal'

interface Props {
  sessionId: string
  sessionName: string
  onClose: () => void
}

export default function DetailPane({ sessionId, sessionName, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only close on Escape if terminal is NOT focused
      // (terminal needs Escape for vim, etc.)
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
        <Terminal sessionId={sessionId} />
      </div>
    </div>
  )
}
