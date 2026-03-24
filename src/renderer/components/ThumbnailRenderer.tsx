import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { useSessionsStore } from '../stores/sessions'

const SNAPSHOT_INTERVAL = 3000

function ThumbnailTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cols: 80,
      rows: 24,
      theme: {
        background: '#0e0e1e',
        foreground: '#e0e0e0',
        cursor: '#4ade80',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 10,
    })

    term.open(containerRef.current)
    termRef.current = term

    const cleanup = window.api.onPtyData((event) => {
      if (event.sessionId === sessionId) {
        term.write(event.data)
      }
    })

    const snapshotInterval = setInterval(() => {
      if (!term.element) return
      const canvas = term.element.querySelector('canvas')
      if (!canvas) return
      try {
        const dataUrl = canvas.toDataURL('image/png')
        useSessionsStore.getState().setThumbnail(sessionId, dataUrl)
      } catch {
        // Canvas may not be ready
      }
    }, SNAPSHOT_INTERVAL)

    return () => {
      clearInterval(snapshotInterval)
      cleanup()
      term.dispose()
      termRef.current = null
    }
  }, [sessionId])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        left: -9999,
        top: -9999,
        width: 640,
        height: 384,
        overflow: 'hidden',
      }}
    />
  )
}

export default function ThumbnailRenderer() {
  const sessions = useSessionsStore((s) => s.sessions)

  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'needs_input' || s.status === 'idle'
  )

  return (
    <>
      {activeSessions.map((session) => (
        <ThumbnailTerminal key={session.id} sessionId={session.id} />
      ))}
    </>
  )
}
