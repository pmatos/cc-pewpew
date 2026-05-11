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
  const parts: { key: string; className: string; label: string }[] = []

  if (approved > 0) {
    parts.push({
      key: 'approved',
      className: 'rv-bottom-bar-count--approved',
      label: `${approved} approved`,
    })
  }
  if (commented > 0) {
    parts.push({
      key: 'commented',
      className: 'rv-bottom-bar-count--commented',
      label: `${commented} commented`,
    })
  }
  if (rejected > 0) {
    parts.push({
      key: 'rejected',
      className: 'rv-bottom-bar-count--rejected',
      label: `${rejected} rejected`,
    })
  }

  return (
    <div className="rv-bottom-bar">
      <div className="rv-bottom-bar-stats">
        {parts.length > 0 ? (
          <>
            {parts.flatMap((part, partIndex) => [
              ...(partIndex > 0 ? [<span key={`sep-${part.key}`}> &middot; </span>] : []),
              <span key={part.key} className={part.className}>
                {part.label}
              </span>,
            ])}
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
