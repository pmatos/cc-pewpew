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

    // Auto-copy selection to clipboard
    const selectionDisposable = term.onSelectionChange(() => {
      const text = term.getSelection()
      if (text) {
        navigator.clipboard.writeText(text)
      }
    })

    // Ctrl+Shift+C to copy, Ctrl+Shift+V to paste
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.shiftKey && e.type === 'keydown') {
        if (e.key === 'C') {
          const text = term.getSelection()
          if (text) navigator.clipboard.writeText(text)
          return false
        }
        if (e.key === 'V') {
          e.preventDefault()
          navigator.clipboard.readText().then((text) => {
            if (text) window.api.ptyWrite(sessionId, text)
          })
          return false
        }
      }
      // Shift+Enter → kitty protocol sequence for "newline, don't submit"
      // Block both keydown and keyup to prevent xterm sending \r on keyup
      if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
        if (e.type === 'keydown') {
          window.api.ptyWrite(sessionId, '\x1b[13;2u')
        }
        return false
      }
      return true
    })

    // Forward user input to pty
    const inputDisposable = term.onData((data) => {
      window.api.ptyWrite(sessionId, data)
    })

    let aborted = false
    let dataCleanup: (() => void) | null = null
    let refitTimer: ReturnType<typeof setTimeout> | null = null

    // Sequenced init: fit → resize pty → wait for tmux → scrollback → live data → focus
    requestAnimationFrame(() => {
      ;(async () => {
        // Ensure fonts are loaded before measuring — wrong metrics cause garbled rendering
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 500))])
        if (aborted) return

        fitAddon.fit()
        await window.api.ptyResize(sessionId, term.cols, term.rows)
        await new Promise((r) => setTimeout(r, 50))
        if (aborted) return

        const scrollback = await window.api.ptyGetScrollback(sessionId)
        if (aborted) return
        if (scrollback) {
          term.write(scrollback)
        }

        dataCleanup = window.api.onPtyData((event) => {
          if (event.sessionId === sessionId) {
            term.write(event.data)
          }
        })

        term.focus()

        // Recovery pass: Wayland compositors + fractional DPR can leave the canvas
        // renderer in a bad state. Force a resize cycle (shrink then restore) to
        // trigger a full re-render — same effect as fullscreen toggle.
        refitTimer = setTimeout(() => {
          if (aborted) return
          console.log('[Terminal] recovery pass firing', { cols: term.cols, rows: term.rows })
          term.clearTextureAtlas()
          term.resize(term.cols - 1, term.rows)
          fitAddon.fit()
          term.refresh(0, term.rows - 1)
          window.api.ptyResize(sessionId, term.cols, term.rows)
        }, 150)
      })()
    })

    // Resize observer
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      window.api.ptyResize(sessionId, term.cols, term.rows)
    })
    observer.observe(containerRef.current)

    return () => {
      aborted = true
      if (refitTimer) clearTimeout(refitTimer)
      observer.disconnect()
      selectionDisposable.dispose()
      inputDisposable.dispose()
      if (dataCleanup) dataCleanup()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  return <div ref={containerRef} className="terminal-container" />
}
