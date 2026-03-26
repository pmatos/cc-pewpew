import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
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

  return (
    <div className="context-menu" ref={ref} role="menu" style={{ left: x, top: y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={i}
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
    </div>
  )
}
