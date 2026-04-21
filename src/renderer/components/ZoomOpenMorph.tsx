import { useEffect, useRef, useState } from 'react'

export interface ZoomOpenMorphProps {
  startRect: { left: number; top: number; width: number; height: number }
  // Called when the growth animation finishes. Parent should mount the DetailPane
  // now so xterm has time to init during the fade.
  onGrown: () => void
  // Called after the fade completes. Parent should unmount this layer.
  onDone: () => void
}

const MORPH_DURATION_MS = 180

export default function ZoomOpenMorph({ startRect, onGrown, onDone }: ZoomOpenMorphProps) {
  const [phase, setPhase] = useState<'start' | 'end' | 'fade'>('start')
  const layerRef = useRef<HTMLDivElement>(null)
  const grownFiredRef = useRef(false)

  const fireGrown = () => {
    if (grownFiredRef.current) return
    grownFiredRef.current = true
    onGrown()
  }

  // Trigger the transition on next frame so the browser registers the start rect first.
  useEffect(() => {
    const id = requestAnimationFrame(() => setPhase('end'))
    return () => cancelAnimationFrame(id)
  }, [])

  // Safety timer: if transitionend never fires (reduced motion, interrupted), finish anyway.
  useEffect(() => {
    if (phase !== 'end') return
    const t = setTimeout(() => {
      fireGrown()
      setPhase('fade')
    }, MORPH_DURATION_MS + 50)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (phase !== 'fade') return
    const t = setTimeout(onDone, 60)
    return () => clearTimeout(t)
  }, [phase, onDone])

  const style: React.CSSProperties =
    phase === 'start'
      ? {
          left: startRect.left,
          top: startRect.top,
          width: startRect.width,
          height: startRect.height,
          opacity: 1,
        }
      : phase === 'end'
        ? { left: 0, top: 0, width: '100vw', height: '100vh', opacity: 1 }
        : { left: 0, top: 0, width: '100vw', height: '100vh', opacity: 0 }

  return (
    <div
      ref={layerRef}
      className="zoom-open-morph"
      style={style}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'width' && phase === 'end') {
          fireGrown()
          setPhase('fade')
        }
      }}
    ></div>
  )
}
