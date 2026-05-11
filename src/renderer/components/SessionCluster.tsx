import { useRef, useCallback, useEffect, useState, useEffectEvent } from 'react'
import type { Session } from '../../shared/types'
import { useSessionsStore } from '../stores/sessions'
import { useProjectsStore } from '../stores/projects'
import SessionCard from './SessionCard'
import ContextMenu, { type MenuItem } from './ContextMenu'

interface Props {
  projectPath: string
  projectName: string
  sessions: Session[]
  thumbnails: Record<string, string>
  accentColor: string
  position: { x: number; y: number }
  zoom: number
  isOrphaned?: boolean
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
  isOrphaned,
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

  const handleDocumentMove = useEffectEvent((e: MouseEvent) => {
    if (!dragging.current) return
    const dx = (e.clientX - dragStart.current.x) / zoom
    const dy = (e.clientY - dragStart.current.y) / zoom
    onDrag(projectPath, {
      x: dragStart.current.posX + dx,
      y: dragStart.current.posY + dy,
    })
  })

  const handleDocumentUp = useEffectEvent(() => {
    if (dragging.current) {
      dragging.current = false
      onDragEnd()
    }
  })

  useEffect(() => {
    const handleMove = (e: MouseEvent) => handleDocumentMove(e)
    const handleUp = () => handleDocumentUp()
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [])

  const handleHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setHeaderMenu({ x: e.clientX, y: e.clientY })
  }

  const handleLocateProject = async () => {
    const picked = await window.api.pickDirectory()
    if (!picked) return
    await window.api.relocateProject(projectPath, picked)
    useProjectsStore.getState().scanProjects()
  }

  const headerMenuItems: MenuItem[] = [
    {
      label: `Select all in ${projectName}`,
      onClick: () => useSessionsStore.getState().selectAll(projectPath),
    },
    ...(isOrphaned
      ? [
          { separator: true } as MenuItem,
          { label: 'Locate moved project…', onClick: handleLocateProject } as MenuItem,
        ]
      : []),
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
      <button
        type="button"
        className={`cluster-header${isOrphaned ? ' cluster-header--orphaned' : ''}`}
        style={isOrphaned ? undefined : { color: accentColor }}
        onMouseDown={handleMouseDown}
        onContextMenu={handleHeaderContextMenu}
      >
        {projectName}
      </button>
      <div
        className="cluster-cards"
        style={{ gridTemplateColumns: `repeat(${Math.min(sessions.length, 2)}, 240px)` }}
      >
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            thumbnail={thumbnails[session.id]}
            onOpenSession={onOpenSession}
            onSelect={onSelect}
          />
        ))}
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
