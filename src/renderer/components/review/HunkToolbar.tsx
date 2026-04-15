import React from 'react'

interface HunkToolbarProps {
  onApprove: () => void
  onComment: () => void
  onReject: () => void
}

const HunkToolbar: React.FC<HunkToolbarProps> = ({ onApprove, onComment, onReject }) => {
  return (
    <div className="rv-hunk-toolbar">
      <button
        className="rv-toolbar-btn rv-toolbar-btn--approve"
        title="Approve"
        onMouseDown={(e) => {
          e.preventDefault()
          onApprove()
        }}
      >
        ✓
      </button>
      <button
        className="rv-toolbar-btn rv-toolbar-btn--comment"
        title="Comment"
        onMouseDown={(e) => {
          e.preventDefault()
          onComment()
        }}
      >
        💬
      </button>
      <button
        className="rv-toolbar-btn rv-toolbar-btn--reject"
        title="Reject"
        onMouseDown={(e) => {
          e.preventDefault()
          onReject()
        }}
      >
        ✗
      </button>
    </div>
  )
}

export default HunkToolbar
