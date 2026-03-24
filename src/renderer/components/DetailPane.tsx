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
      if (e.key === 'Escape') {
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
        <button className="detail-pane-close" onClick={onClose} title="Back to canvas (Escape)">
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
