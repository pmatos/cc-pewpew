import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { onThemeChanged } from '../stores/theme'

interface Props {
  sessionId: string
}

function readTerminalTheme() {
  const styles = getComputedStyle(document.documentElement)
  return {
    background: styles.getPropertyValue('--bg-terminal').trim() || '#0e0e1e',
    foreground: styles.getPropertyValue('--text-primary').trim() || '#e0e0e0',
    cursor: styles.getPropertyValue('--accent-green').trim() || '#4ade80',
    selectionBackground: styles.getPropertyValue('--border').trim() || '#2a2a4a',
  }
}

export default function Terminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    const term = new XTerm({
      theme: readTerminalTheme(),
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 14,
      cursorBlink: true,
    })

    const themeUnsubscribe = onThemeChanged(() => {
      term.options.theme = readTerminalTheme()
      term.refresh(0, term.rows - 1)
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // Register handlers before open() — they queue until the terminal has DOM
    const selectionDisposable = term.onSelectionChange(() => {
      const text = term.getSelection()
      if (text) {
        navigator.clipboard.writeText(text)
      }
    })

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
      if (e.ctrlKey && !e.shiftKey && e.key === 'r') {
        return false
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
        if (e.type === 'keydown') {
          window.api.ptyWrite(sessionId, '\n')
        }
        return false
      }
      return true
    })

    const inputDisposable = term.onData((data) => {
      window.api.ptyWrite(sessionId, data)
    })

    let aborted = false
    let dataCleanup: (() => void) | null = null
    let webglAddon: WebglAddon | null = null

    const syncTerminal = async (invalidateAtlas = false) => {
      if (aborted) return
      fitAddon.fit()
      if (invalidateAtlas && webglAddon) {
        try {
          webglAddon.clearTextureAtlas()
        } catch {
          // Atlas rebuild can fail if the renderer is mid-dispose.
        }
      }
      term.refresh(0, term.rows - 1)
      await window.api.ptyResize(sessionId, term.cols, term.rows)
    }

    const pulsePtyResize = async () => {
      if (aborted) return
      const cols = term.cols
      const rows = term.rows
      const pulseCols = cols > 2 ? cols - 1 : cols + 1

      await window.api.ptyResize(sessionId, pulseCols, rows)
      await new Promise((r) => setTimeout(r, 40))
      if (aborted) return
      await window.api.ptyResize(sessionId, cols, rows)
    }

    // Defer term.open() until fonts are loaded and layout is stable.
    // Opening before fonts causes xterm to render with wrong glyph metrics,
    // producing garbled output on Wayland with fractional DPR.
    requestAnimationFrame(() => {
      ;(async () => {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 500))])
        if (aborted) return

        term.open(container)
        // Skip WebglAddon on Linux. ANGLE's Vulkan backend (enabled in
        // src/main/index.ts for dual-GPU support) can't always import the
        // Ozone DMA-BUF shared-image backing into a Vulkan texture, producing
        // silent WebGL errors (`ProduceGLTexturePassthrough: incompatible
        // backing`) that leave the glyph atlas invalid. xterm.js never sees a
        // context-loss event, so glyphs render as garbled/scattered text. The
        // canvas renderer is marginally slower but reliable across Linux GPU
        // stacks.
        const isLinux = navigator.userAgent.includes('Linux')
        if (!isLinux) {
          try {
            const addon = new WebglAddon()
            addon.onContextLoss(() => {
              try {
                addon.dispose()
              } catch {
                // Already disposed
              }
              webglAddon = null
              term.refresh(0, term.rows - 1)
            })
            term.loadAddon(addon)
            webglAddon = addon
          } catch {
            // WebGL not available, fall back to default canvas renderer
          }
        }
        termRef.current = term
        fitRef.current = fitAddon

        await syncTerminal(true)

        let sawLiveData = false

        dataCleanup = window.api.onPtyData((event) => {
          if (event.sessionId === sessionId) {
            sawLiveData = true
            term.write(event.data)
          }
        })

        await new Promise((r) => setTimeout(r, 120))
        if (aborted) return

        if (!sawLiveData) {
          await pulsePtyResize()
          await new Promise((r) => setTimeout(r, 120))
        }
        if (aborted) return

        if (!sawLiveData) {
          const scrollback = await window.api.ptyGetScrollback(sessionId)
          if (aborted) return
          if (scrollback) {
            await new Promise<void>((resolve) => term.write(scrollback, resolve))
            await syncTerminal(true)
          }
        }

        term.focus()
      })()
    })

    const observer = new ResizeObserver(() => {
      if (!termRef.current) return
      void syncTerminal()
    })
    observer.observe(container)

    const handleWindowFocus = () => {
      void syncTerminal(true)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncTerminal(true)
      }
    }

    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      aborted = true
      observer.disconnect()
      themeUnsubscribe()
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      selectionDisposable.dispose()
      inputDisposable.dispose()
      if (dataCleanup) dataCleanup()
      if (webglAddon) {
        try {
          webglAddon.dispose()
        } catch {
          // WebglAddon.dispose() can throw on _isDisposed check
        }
        webglAddon = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  return <div ref={containerRef} className="terminal-container" />
}
