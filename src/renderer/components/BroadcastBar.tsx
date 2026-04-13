import { useState, useRef } from 'react'

interface Props {
  sessionIds: string[]
}

export default function BroadcastBar({ sessionIds }: Props) {
  const [command, setCommand] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const send = () => {
    const trimmed = command.trim()
    if (!trimmed) return
    window.api.ptyWriteBatch(sessionIds, trimmed + '\r')
    setCommand('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') {
      inputRef.current?.blur()
    }
  }

  return (
    <div className="broadcast-bar">
      <input
        ref={inputRef}
        type="text"
        placeholder="Broadcast command to all lanes..."
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button onClick={send}>Send to all</button>
    </div>
  )
}
