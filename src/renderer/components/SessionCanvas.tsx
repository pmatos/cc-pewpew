import { useEffect, useRef, useState, useCallback } from 'react'
import { useSessionsStore } from '../stores/sessions'
import SessionCard from './SessionCard'

const MIN_ZOOM = 0.3
const MAX_ZOOM = 1.0
const ZOOM_STEP = 0.1
const CARD_WIDTH = 240
const CARD_HEIGHT = 230
const CARD_GAP = 16
const COLS = 4
const DOT_SPACING = 30
const DOT_COLOR = '#2a2a4a'
const DOT_RADIUS = 1.5

export default function SessionCanvas() {
  const { sessions, thumbnails } = useSessionsStore()
  const viewportRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)

  const [zoom, setZoom] = useState(0.7)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  // Load persisted state
  useEffect(() => {
    window.api.getCanvasState().then((state) => {
      if (state) {
        setZoom(state.zoom)
        setPanX(state.panX)
        setPanY(state.panY)
      }
      setLoaded(true)
    })
  }, [])

  // Persist with debounce
  const persistState = useCallback((z: number, px: number, py: number) => {
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

  // Resize observer for dot grid
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
        persistState(0.7, 0, 0)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((prev) => {
          const next = Math.min(MAX_ZOOM, prev + ZOOM_STEP)
          persistState(next, panX, panY)
          return next
        })
      } else if (e.key === '-') {
        e.preventDefault()
        setZoom((prev) => {
          const next = Math.max(MIN_ZOOM, prev - ZOOM_STEP)
          persistState(next, panX, panY)
          return next
        })
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [panX, panY, persistState])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return

      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      setZoom((prevZoom) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevZoom + delta))

        const newPanX = cx - (cx - panX) * (newZoom / prevZoom)
        const newPanY = cy - (cy - panY) * (newZoom / prevZoom)

        setPanX(newPanX)
        setPanY(newPanY)
        persistState(newZoom, newPanX, newPanY)

        return newZoom
      })
    },
    [panX, panY, persistState]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('.session-card')) return

      setDragging(true)
      dragStart.current = { x: e.clientX, y: e.clientY, panX, panY }
    },
    [panX, panY]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      const newPanX = dragStart.current.panX + dx
      const newPanY = dragStart.current.panY + dy
      setPanX(newPanX)
      setPanY(newPanY)
    },
    [dragging]
  )

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      setDragging(false)
      persistState(zoom, panX, panY)
    }
  }, [dragging, zoom, panX, panY, persistState])

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
        {sessions.map((session, i) => {
          const col = i % COLS
          const row = Math.floor(i / COLS)
          const left = col * (CARD_WIDTH + CARD_GAP) + CARD_GAP
          const top = row * (CARD_HEIGHT + CARD_GAP) + CARD_GAP

          return (
            <SessionCard
              key={session.id}
              session={session}
              thumbnail={thumbnails[session.id]}
              style={{ position: 'absolute', left, top, width: CARD_WIDTH }}
            />
          )
        })}
      </div>
    </div>
  )
}
