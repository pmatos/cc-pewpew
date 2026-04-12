import { useState, useEffect, useRef } from 'react'
import { useSessionsStore } from '../stores/sessions'

export default function BroadcastDialog() {
  const open = useSessionsStore((s) => s.broadcastDialogOpen)
  const selectedIds = useSessionsStore((s) => s.selectedIds)
  const closeBroadcastDialog = useSessionsStore((s) => s.closeBroadcastDialog)
  const clearSelection = useSessionsStore((s) => s.clearSelection)
  const [command, setCommand] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setCommand('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (open && selectedIds.size === 0) {
      closeBroadcastDialog()
    }
  }, [open, selectedIds.size, closeBroadcastDialog])

  if (!open) return null

  const handleSend = async () => {
    if (!command.trim()) return
    await window.api.ptyWriteBatch([...selectedIds], command + '\r')
    clearSelection()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape') {
      closeBroadcastDialog()
    }
  }

  return (
    <div
      className="broadcast-dialog-overlay"
      onClick={closeBroadcastDialog}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="broadcast-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="session-name-label">Send command to {selectedIds.size} sessions</div>
        <input
          ref={inputRef}
          type="text"
          className="create-input"
          placeholder="Type a command..."
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="create-actions">
          <button className="create-btn" disabled={!command.trim()} onClick={handleSend}>
            Send
          </button>
          <button className="create-btn cancel" onClick={closeBroadcastDialog}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
