import React, { useState, useRef, useEffect } from 'react'
import type { RejectMode } from '../../../shared/types'

interface FeedbackInputProps {
  mode: 'comment' | 'reject'
  onSubmit: (comment: string, rejectMode?: RejectMode) => void
  onCancel: () => void
}

const FeedbackInput: React.FC<FeedbackInputProps> = ({ mode, onSubmit, onCancel }) => {
  const [comment, setComment] = useState('')
  const [rejectMode, setRejectMode] = useState<RejectMode>('propose_alternative')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.stopPropagation()
      onSubmit(comment, mode === 'reject' ? rejectMode : undefined)
    }
  }

  return (
    <div className="rv-feedback-input" onKeyDown={handleKeyDown}>
      {mode === 'reject' && (
        <div className="rv-feedback-radio-group">
          <label>
            <input
              type="radio"
              name="reject-mode"
              value="propose_alternative"
              checked={rejectMode === 'propose_alternative'}
              onChange={() => setRejectMode('propose_alternative')}
            />
            Propose alternative
          </label>
          <label>
            <input
              type="radio"
              name="reject-mode"
              value="request_possibilities"
              checked={rejectMode === 'request_possibilities'}
              onChange={() => setRejectMode('request_possibilities')}
            />
            Request other possibilities
          </label>
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="rv-feedback-textarea"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={mode === 'reject' ? 'Describe your feedback...' : 'Add a comment...'}
      />
      <div className="rv-feedback-actions">
        <button className="rv-feedback-btn rv-feedback-btn--cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="rv-feedback-btn rv-feedback-btn--submit"
          onClick={() => onSubmit(comment, mode === 'reject' ? rejectMode : undefined)}
        >
          Submit
        </button>
      </div>
    </div>
  )
}

export default FeedbackInput
