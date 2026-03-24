import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  sessionId: string
}

export default function Terminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      theme: {
        background: '#0e0e1e',
        foreground: '#e0e0e0',
        cursor: '#4ade80',
        selectionBackground: '#2a2a4a',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 14,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fitAddon

    // Fit after layout settles
    requestAnimationFrame(() => {
      fitAddon.fit()
      window.api.ptyResize(sessionId, term.cols, term.rows)
    })

    // Forward user input to pty
    const inputDisposable = term.onData((data) => {
      window.api.ptyWrite(sessionId, data)
    })

    // Receive pty data — filter by sessionId
    const cleanup = window.api.onPtyData((event) => {
      if (event.sessionId === sessionId) {
        term.write(event.data)
      }
    })

    // Resize observer
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      window.api.ptyResize(sessionId, term.cols, term.rows)
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      cleanup()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  return <div ref={containerRef} className="terminal-container" />
}
