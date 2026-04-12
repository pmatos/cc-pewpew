import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useSessionsStore } from '../stores/sessions'
import { useCanvasStore } from '../stores/canvas'
import SessionCluster from './SessionCluster'
import EdgeIndicators from './EdgeIndicators'

const MIN_ZOOM = 0.3
const MAX_ZOOM = 1.0
const ZOOM_SENSITIVITY = 0.001
const KEYBOARD_ZOOM_STEP = 0.1
const DOT_SPACING = 30
const DOT_COLOR = '#2a2a4a'
const DOT_RADIUS = 1.5

const ACCENT_COLORS = [
  '#4ade80',
  '#60a5fa',
  '#f472b6',
  '#facc15',
  '#a78bfa',
  '#fb923c',
  '#2dd4bf',
  '#e879f9',
]

function hashColor(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) {
    hash = (hash + path.charCodeAt(i)) * 31
  }
  return ACCENT_COLORS[Math.abs(hash) % ACCENT_COLORS.length]
}

const CLUSTER_WIDTH = 510
const CLUSTER_GAP = 40

interface CanvasProps {
  onOpenSession?: (id: string, name: string) => void
}

export default function SessionCanvas({ onOpenSession }: CanvasProps) {
  const { sessions, thumbnails, toggleSelect, rangeSelect, clearSelection } = useSessionsStore()
  const viewportRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)

  const [zoom, setZoom] = useState(0.7)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  const [clusterPositions, setClusterPositions] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

  const setPanToCluster = useCanvasStore((s) => s.setPanToCluster)
  const panXRef = useRef(panX)
  const panYRef = useRef(panY)
  const zoomRef = useRef(zoom)
  panXRef.current = panX
  panYRef.current = panY
  zoomRef.current = zoom

  // Group sessions by project
  const clusters = useMemo(() => {
    const map = new Map<string, typeof sessions>()
    for (const session of sessions) {
      const existing = map.get(session.projectPath) || []
      existing.push(session)
      map.set(session.projectPath, existing)
    }
    return map
  }, [sessions])

  // Load persisted state
  useEffect(() => {
    Promise.all([window.api.getCanvasState(), window.api.getClusterPositions()]).then(
      ([canvasState, positions]) => {
        if (canvasState) {
          setZoom(canvasState.zoom)
          setPanX(canvasState.panX)
          setPanY(canvasState.panY)
        }
        if (positions) {
          setClusterPositions(positions)
        }
        setLoaded(true)
      }
    )
  }, [])

  // Assign default positions to new clusters
  useEffect(() => {
    if (!loaded) return
    let changed = false
    const updated = { ...clusterPositions }
    let idx = Object.keys(updated).length

    for (const projectPath of clusters.keys()) {
      if (!updated[projectPath]) {
        updated[projectPath] = {
          x: (idx % 3) * (CLUSTER_WIDTH + CLUSTER_GAP) + CLUSTER_GAP,
          y: Math.floor(idx / 3) * 400 + CLUSTER_GAP,
        }
        idx++
        changed = true
      }
    }

    if (changed) {
      setClusterPositions(updated)
      window.api.saveClusterPositions(updated)
    }
  }, [clusters, loaded, clusterPositions])

  // Register panToCluster in canvas store
  useEffect(() => {
    const panToClusterFn = (projectPath: string) => {
      const pos = clusterPositions[projectPath]
      if (!pos) return
      const viewport = viewportRef.current
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()

      const targetPanX = -pos.x * zoomRef.current + rect.width / 2
      const targetPanY = -pos.y * zoomRef.current + rect.height / 2

      const startPanX = panXRef.current
      const startPanY = panYRef.current
      const startTime = performance.now()
      const duration = 350

      const animate = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration)
        const ease = 1 - Math.pow(1 - t, 3)
        const newPanX = startPanX + (targetPanX - startPanX) * ease
        const newPanY = startPanY + (targetPanY - startPanY) * ease
        setPanX(newPanX)
        setPanY(newPanY)
        if (t < 1) {
          requestAnimationFrame(animate)
        } else {
          window.api.saveCanvasState({ zoom: zoomRef.current, panX: targetPanX, panY: targetPanY })
        }
      }
      requestAnimationFrame(animate)
    }

    setPanToCluster(panToClusterFn)
  }, [clusterPositions, setPanToCluster])

  // Track viewport size
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const updateSize = () => {
      const rect = viewport.getBoundingClientRect()
      setViewportSize({ width: rect.width, height: rect.height })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  // Persist canvas with debounce
  const persistCanvas = useCallback((z: number, px: number, py: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.api.saveCanvasState({ zoom: z, panX: px, panY: py })
    }, 500)
  }, [])

  // Draw dot grid
  useEffect(() => {
    const canvas = gridRef.current
    const viewport = viewportRef.current
    if (!canvas || !viewport) return

    const rect = viewport.getBoundingClientRect()
    canvas.width = rect.width
    canvas.height = rect.height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = DOT_COLOR

    const spacing = DOT_SPACING * zoom
    const offsetX = ((panX % spacing) + spacing) % spacing
    const offsetY = ((panY % spacing) + spacing) % spacing

    for (let x = offsetX; x < canvas.width; x += spacing) {
      for (let y = offsetY; y < canvas.height; y += spacing) {
        ctx.beginPath()
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [zoom, panX, panY, sessions.length])

  // Resize observer
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => {
      const canvas = gridRef.current
      if (!canvas) return
      const rect = viewport.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return

      if (e.key === '0') {
        e.preventDefault()
        setZoom(0.7)
        setPanX(0)
        setPanY(0)
        persistCanvas(0.7, 0, 0)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((prev) => {
          const next = Math.min(MAX_ZOOM, prev + KEYBOARD_ZOOM_STEP)
          persistCanvas(next, panX, panY)
          return next
        })
      } else if (e.key === '-') {
        e.preventDefault()
        setZoom((prev) => {
          const next = Math.max(MIN_ZOOM, prev - KEYBOARD_ZOOM_STEP)
          persistCanvas(next, panX, panY)
          return next
        })
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [panX, panY, persistCanvas])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return

      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      setZoom((prevZoom) => {
        const zoomDelta = -e.deltaY * ZOOM_SENSITIVITY * prevZoom
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevZoom + zoomDelta))
        const newPanX = cx - (cx - panX) * (newZoom / prevZoom)
        const newPanY = cy - (cy - panY) * (newZoom / prevZoom)
        setPanX(newPanX)
        setPanY(newPanY)
        persistCanvas(newZoom, newPanX, newPanY)
        return newZoom
      })
    },
    [panX, panY, persistCanvas]
  )

  const handleSelect = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        const clusterEntry = Array.from(clusters.entries()).find(([, clusterSessions]) =>
          clusterSessions.some((s) => s.id === id)
        )
        if (clusterEntry) {
          const orderedIds = clusterEntry[1].map((s) => s.id)
          rangeSelect(id, orderedIds)
        }
      } else {
        toggleSelect(id, e.ctrlKey || e.metaKey)
      }
    },
    [clusters, rangeSelect, toggleSelect]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('.session-cluster')) return

      clearSelection()
      setDragging(true)
      dragStart.current = { x: e.clientX, y: e.clientY, panX, panY }
    },
    [panX, panY, clearSelection]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      setPanX(dragStart.current.panX + dx)
      setPanY(dragStart.current.panY + dy)
    },
    [dragging]
  )

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      setDragging(false)
      persistCanvas(zoom, panX, panY)
    }
  }, [dragging, zoom, panX, panY, persistCanvas])

  const handleClusterDrag = useCallback((projectPath: string, pos: { x: number; y: number }) => {
    setClusterPositions((prev) => ({ ...prev, [projectPath]: pos }))
  }, [])

  const handleClusterDragEnd = useCallback(() => {
    window.api.saveClusterPositions(clusterPositions)
  }, [clusterPositions])

  if (!loaded) return null

  if (sessions.length === 0) {
    return (
      <div className="canvas-empty">
        <span className="canvas-placeholder">No sessions</span>
      </div>
    )
  }

  const transform = `translate(${panX}px, ${panY}px) scale(${zoom})`

  return (
    <div
      className="canvas-viewport"
      ref={viewportRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: dragging ? 'grabbing' : 'default' }}
    >
      <canvas className="dot-grid" ref={gridRef} />
      <div className="canvas-content" style={{ transform, transformOrigin: '0 0' }}>
        {Array.from(clusters.entries()).map(([projectPath, clusterSessions]) => (
          <SessionCluster
            key={projectPath}
            projectPath={projectPath}
            projectName={clusterSessions[0].projectName}
            sessions={clusterSessions}
            thumbnails={thumbnails}
            accentColor={hashColor(projectPath)}
            position={clusterPositions[projectPath] || { x: 0, y: 0 }}
            zoom={zoom}
            onDrag={handleClusterDrag}
            onDragEnd={handleClusterDragEnd}
            onOpenSession={onOpenSession}
            onSelect={handleSelect}
          />
        ))}
      </div>
      <EdgeIndicators
        clusters={Array.from(clusters.entries()).map(([projectPath, clusterSessions]) => ({
          projectPath,
          projectName: clusterSessions[0].projectName,
          position: clusterPositions[projectPath] || { x: 0, y: 0 },
          color: hashColor(projectPath),
        }))}
        zoom={zoom}
        panX={panX}
        panY={panY}
        viewportWidth={viewportSize.width}
        viewportHeight={viewportSize.height}
      />
    </div>
  )
}
