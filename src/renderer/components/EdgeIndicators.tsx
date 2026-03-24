import { useCanvasStore } from '../stores/canvas'

interface ClusterInfo {
  projectPath: string
  projectName: string
  position: { x: number; y: number }
  color: string
}

interface Props {
  clusters: ClusterInfo[]
  zoom: number
  panX: number
  panY: number
  viewportWidth: number
  viewportHeight: number
}

const DOT_SIZE = 12
const MARGIN = 6

export default function EdgeIndicators({
  clusters,
  zoom,
  panX,
  panY,
  viewportWidth,
  viewportHeight,
}: Props) {
  const panToCluster = useCanvasStore((s) => s.panToCluster)

  if (viewportWidth === 0 || viewportHeight === 0) return null

  const indicators: { x: number; y: number; color: string; name: string; path: string }[] = []

  for (const cluster of clusters) {
    const screenX = cluster.position.x * zoom + panX
    const screenY = cluster.position.y * zoom + panY

    const isOffScreen =
      screenX + 300 * zoom < 0 ||
      screenX > viewportWidth ||
      screenY + 300 * zoom < 0 ||
      screenY > viewportHeight

    if (!isOffScreen) continue

    const clampedX = Math.max(MARGIN, Math.min(viewportWidth - DOT_SIZE - MARGIN, screenX))
    const clampedY = Math.max(MARGIN, Math.min(viewportHeight - DOT_SIZE - MARGIN, screenY))

    indicators.push({
      x: clampedX,
      y: clampedY,
      color: cluster.color,
      name: cluster.projectName,
      path: cluster.projectPath,
    })
  }

  if (indicators.length === 0) return null

  return (
    <div className="edge-indicators">
      {indicators.map((ind) => (
        <div
          key={ind.path}
          className="edge-indicator"
          style={{
            left: ind.x,
            top: ind.y,
            background: ind.color,
          }}
          title={ind.name}
          onClick={(e) => {
            e.stopPropagation()
            panToCluster?.(ind.path)
          }}
        />
      ))}
    </div>
  )
}
