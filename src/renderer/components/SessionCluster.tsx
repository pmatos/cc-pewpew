import { useRef, useCallback, useEffect, useState } from 'react'
import type { Session } from '../../shared/types'
import { useSessionsStore } from '../stores/sessions'
import SessionCard from './SessionCard'
import ContextMenu, { type MenuItem } from './ContextMenu'

const CARD_WIDTH = 240
const CARD_GAP = 12
const CLUSTER_COLS = 2

interface Props {
  projectPath: string
  projectName: string
  sessions: Session[]
  thumbnails: Record<string, string>
  accentColor: string
  position: { x: number; y: number }
  zoom: number
  onDrag: (projectPath: string, pos: { x: number; y: number }) => void
  onDragEnd: () => void
  onOpenSession?: (id: string, name: string) => void
  onSelect?: (id: string, e: React.MouseEvent) => void
}

export default function SessionCluster({
  projectPath,
  projectName,
  sessions,
  thumbnails,
  accentColor,
  position,
  zoom,
  onDrag,
  onDragEnd,
  onOpenSession,
  onSelect,
}: Props) {
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 })
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      dragging.current = true
      dragStart.current = { x: e.clientX, y: e.clientY, posX: position.x, posY: position.y }
    },
    [position]
  )

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      onDrag(projectPath, {
        x: dragStart.current.posX + dx,
        y: dragStart.current.posY + dy,
      })
    }

    const handleUp = () => {
      if (dragging.current) {
        dragging.current = false
        onDragEnd()
      }
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [projectPath, zoom, onDrag, onDragEnd])

  const handleHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setHeaderMenu({ x: e.clientX, y: e.clientY })
  }

  const headerMenuItems: MenuItem[] = [
    {
      label: `Select all in ${projectName}`,
      onClick: () => useSessionsStore.getState().selectAll(projectPath),
    },
  ]

  return (
    <div
      className="session-cluster"
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        borderColor: accentColor,
      }}
    >
      <div
        className="cluster-header"
        style={{ color: accentColor }}
        onMouseDown={handleMouseDown}
        onContextMenu={handleHeaderContextMenu}
      >
        {projectName}
      </div>
      <div
        className="cluster-cards"
        style={{
          width: Math.min(sessions.length, CLUSTER_COLS) * (CARD_WIDTH + CARD_GAP) - CARD_GAP,
          height: Math.ceil(sessions.length / CLUSTER_COLS) * (230 + CARD_GAP) - CARD_GAP,
        }}
      >
        {sessions.map((session, i) => {
          const col = i % CLUSTER_COLS
          const row = Math.floor(i / CLUSTER_COLS)
          return (
            <SessionCard
              key={session.id}
              session={session}
              thumbnail={thumbnails[session.id]}
              onOpenSession={onOpenSession}
              onSelect={onSelect}
              style={{
                position: 'absolute',
                left: col * (CARD_WIDTH + CARD_GAP),
                top: row * (230 + CARD_GAP),
                width: CARD_WIDTH,
              }}
            />
          )
        })}
      </div>

      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          items={headerMenuItems}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </div>
  )
}
