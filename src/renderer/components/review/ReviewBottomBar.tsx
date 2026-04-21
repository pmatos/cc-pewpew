import type { JSX } from 'react'

interface ReviewBottomBarProps {
  approved: number
  commented: number
  rejected: number
  total: number
  onSendToSession: () => void
  onCopyToClipboard: () => void
}

export default function ReviewBottomBar({
  approved,
  commented,
  rejected,
  total,
  onSendToSession,
  onCopyToClipboard,
}: ReviewBottomBarProps) {
  const parts: JSX.Element[] = []

  if (approved > 0) {
    parts.push(
      <span key="approved" className="rv-bottom-bar-count--approved">
        {approved} approved
      </span>
    )
  }
  if (commented > 0) {
    parts.push(
      <span key="commented" className="rv-bottom-bar-count--commented">
        {commented} commented
      </span>
    )
  }
  if (rejected > 0) {
    parts.push(
      <span key="rejected" className="rv-bottom-bar-count--rejected">
        {rejected} rejected
      </span>
    )
  }

  return (
    <div className="rv-bottom-bar">
      <div className="rv-bottom-bar-stats">
        {parts.length > 0 ? (
          <>
            {parts.reduce<JSX.Element[]>((acc, el, i) => {
              if (i > 0) acc.push(<span key={`sep-${i}`}> &middot; </span>)
              acc.push(el)
              return acc
            }, [])}
            {' / '}
            {total} total
          </>
        ) : (
          <>{total} total</>
        )}
      </div>
      <div className="rv-bottom-bar-actions">
        <button
          className="rv-bottom-bar-btn rv-bottom-bar-btn--secondary"
          onClick={onCopyToClipboard}
        >
          Copy
        </button>
        <button className="rv-bottom-bar-btn rv-bottom-bar-btn--primary" onClick={onSendToSession}>
          Send to session
        </button>
      </div>
    </div>
  )
}
