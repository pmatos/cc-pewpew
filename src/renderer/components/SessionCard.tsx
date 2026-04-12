import { useState, useEffect } from 'react'
import type { Session, SessionStatus } from '../../shared/types'
import { useProjectsStore } from '../stores/projects'
import { useSessionsStore } from '../stores/sessions'
import ContextMenu, { type MenuItem } from './ContextMenu'

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const STATUS_CONFIG: Record<SessionStatus, { className: string; label: string }> = {
  running: { className: 'status-running', label: 'Running' },
  needs_input: { className: 'status-needs-input', label: 'Needs input' },
  completed: { className: 'status-completed', label: 'Completed' },
  idle: { className: 'status-idle', label: 'Idle' },
  dead: { className: 'status-dead', label: 'Dead' },
  error: { className: 'status-dead', label: 'Error' },
}

interface Props {
  session: Session
  thumbnail?: string
  style?: React.CSSProperties
  onOpenSession?: (id: string, name: string) => void
  onSelect?: (id: string, e: React.MouseEvent) => void
}

export default function SessionCard({ session, thumbnail, style, onOpenSession, onSelect }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [, setTick] = useState(0)

  const selectedIds = useSessionsStore((s) => s.selectedIds)
  const clearSelection = useSessionsStore((s) => s.clearSelection)
  const isSelected = selectedIds.has(session.id)
  const selectedCount = selectedIds.size

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(interval)
  }, [])
  const { className: statusClass, label } = STATUS_CONFIG[session.status]

  const sessionName = `${session.projectName}/${session.worktreeName}`

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      onSelect?.(session.id, e)
      return
    }
    if (selectedCount > 0) {
      clearSelection()
    }
    if (onOpenSession && session.status !== 'dead' && session.status !== 'error') {
      onOpenSession(session.id, sessionName)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!isSelected && selectedCount > 0) {
      clearSelection()
    }
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const buildMenuItems = (): MenuItem[] => {
    if (isSelected && selectedCount > 1) {
      const ids = [...selectedIds]
      const sessions = useSessionsStore.getState().sessions
      const deadCount = ids.filter((id) => {
        const s = sessions.find((sess) => sess.id === id)
        return s?.status === 'dead' || s?.status === 'error'
      }).length
      return [
        {
          label: `Send command to ${selectedCount} sessions`,
          onClick: () => useSessionsStore.getState().openBroadcastDialog(),
        },
        {
          label: `Kill ${selectedCount} sessions`,
          onClick: async () => {
            await window.api.killSessionBatch(ids)
            clearSelection()
          },
        },
        ...(deadCount > 0
          ? [
              {
                label: `Restart ${deadCount} dead session${deadCount > 1 ? 's' : ''}`,
                onClick: async () => {
                  await window.api.reviveSessionBatch(ids)
                  clearSelection()
                },
              },
            ]
          : []),
        {
          label: `Remove ${selectedCount} from canvas`,
          onClick: async () => {
            await window.api.removeSessionBatch(ids)
            clearSelection()
            useProjectsStore.getState().scanProjects()
          },
        },
      ]
    }
    return [
      {
        label: session.status === 'dead' ? 'Restart terminal' : 'Open terminal',
        onClick: () => onOpenSession?.(session.id, sessionName),
      },
      {
        label: 'Kill session',
        onClick: () => window.api.killSession(session.id),
      },
      {
        label: 'Remove from canvas',
        onClick: async () => {
          await window.api.removeSession(session.id)
          useProjectsStore.getState().scanProjects()
        },
      },
    ]
  }

  const classes = [
    'session-card',
    session.status === 'needs_input' ? 'needs-input' : '',
    isSelected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} onClick={handleClick} onContextMenu={handleContextMenu} style={style}>
      <div className="session-card-thumb">
        {thumbnail ? <pre className="session-card-text-thumb">{thumbnail}</pre> : null}
      </div>
      <div className="session-card-body">
        <div className="session-card-header">{sessionName}</div>
        <div className="session-card-status">
          <span className={`status-dot ${statusClass}`} />
          <span>{label}</span>
        </div>
        <div className="session-card-time">{timeAgo(session.lastActivity)}</div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={buildMenuItems()} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
