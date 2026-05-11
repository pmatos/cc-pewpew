import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  id?: string
  disabled?: boolean
  separator?: boolean
  onClick: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (!ref.current) return
      const buttons = Array.from(ref.current.querySelectorAll('button:not(:disabled)'))
      const current = document.activeElement
      const idx = buttons.indexOf(current as Element)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = idx < buttons.length - 1 ? idx + 1 : 0
        ;(buttons[next] as HTMLElement).focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = idx > 0 ? idx - 1 : buttons.length - 1
        ;(buttons[prev] as HTMLElement).focus()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)

    // Focus first item
    requestAnimationFrame(() => {
      const first = ref.current?.querySelector('button:not(:disabled)') as HTMLElement
      first?.focus()
    })

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  let separatorCount = 0

  return createPortal(
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) =>
        item.separator ? (
          <div
            key={item.id ?? `separator-${separatorCount++}`}
            className="context-menu-separator"
            role="separator"
          />
        ) : (
          <button
            key={item.id ?? item.label}
            role="menuitem"
            className={`context-menu-item${item.disabled ? ' disabled' : ''}`}
            disabled={item.disabled}
            onClick={(e) => {
              e.stopPropagation()
              item.onClick()
              onClose()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
