import { useState } from 'react'
import type { Session, SessionStatus } from '../../shared/types'
import ContextMenu, { type MenuItem } from './ContextMenu'

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const STATUS_CONFIG: Record<SessionStatus, { color: string; label: string }> = {
  running: { color: '#4ade80', label: 'Running' },
  needs_input: { color: '#facc15', label: 'Needs input' },
  completed: { color: '#60a5fa', label: 'Completed' },
  idle: { color: '#888', label: 'Idle' },
  dead: { color: '#f87171', label: 'Dead' },
  error: { color: '#f87171', label: 'Error' },
}

interface Props {
  session: Session
}

export default function SessionCard({ session }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { color, label } = STATUS_CONFIG[session.status]

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: MenuItem[] = [
    {
      label: 'Kill session',
      onClick: () => window.api.killSession(session.id),
    },
    {
      label: 'Focus window',
      onClick: () => {},
    },
  ]

  return (
    <div className="session-card" onContextMenu={handleContextMenu}>
      <div className="session-card-thumb" />
      <div className="session-card-body">
        <div className="session-card-header">
          {session.projectName}/{session.worktreeName}
        </div>
        <div className="session-card-status">
          <span className="status-dot" style={{ background: color }} />
          <span>{label}</span>
        </div>
        <div className="session-card-time">{timeAgo(session.lastActivity)}</div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
