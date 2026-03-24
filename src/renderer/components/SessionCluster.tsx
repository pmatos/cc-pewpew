import { useRef, useCallback, useEffect } from 'react'
import type { Session } from '../../shared/types'
import SessionCard from './SessionCard'

const CARD_WIDTH = 240
const CARD_GAP = 12
const CLUSTER_COLS = 2
const CLUSTER_PADDING = 12
const HEADER_HEIGHT = 32

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
}: Props) {
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 })

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
      <div className="cluster-header" style={{ color: accentColor }} onMouseDown={handleMouseDown}>
        {projectName}
      </div>
      <div className="cluster-cards">
        {sessions.map((session, i) => {
          const col = i % CLUSTER_COLS
          const row = Math.floor(i / CLUSTER_COLS)
          return (
            <SessionCard
              key={session.id}
              session={session}
              thumbnail={thumbnails[session.id]}
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
      <div
        style={{
          width: Math.min(sessions.length, CLUSTER_COLS) * (CARD_WIDTH + CARD_GAP) - CARD_GAP,
          height:
            Math.ceil(sessions.length / CLUSTER_COLS) * (230 + CARD_GAP) -
            CARD_GAP +
            HEADER_HEIGHT +
            CLUSTER_PADDING,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
