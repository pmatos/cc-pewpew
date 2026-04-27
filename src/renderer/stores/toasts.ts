import { create } from 'zustand'
import type { ToastEvent } from '../../shared/types'

interface ToastsState {
  toasts: ToastEvent[]
  enqueue: (event: ToastEvent) => void
  dismiss: (id: string) => void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const useToastsStore = create<ToastsState>((set, get) => ({
  toasts: [],
  enqueue: (event) => {
    const ttlMs = event.ttlMs ?? 6000
    // Dedup on (severity, title, hostLabel): refresh ttl rather than stack
    // identical errors during a backoff or retry loop.
    const existing = get().toasts.find(
      (t) =>
        t.severity === event.severity && t.title === event.title && t.hostLabel === event.hostLabel
    )
    if (existing) {
      const timer = timers.get(existing.id)
      if (timer) clearTimeout(timer)
      const refreshed: ToastEvent = { ...existing, detail: event.detail, ttlMs }
      set({
        toasts: get().toasts.map((t) => (t.id === existing.id ? refreshed : t)),
      })
      timers.set(
        existing.id,
        setTimeout(() => get().dismiss(existing.id), ttlMs)
      )
      return
    }
    set({ toasts: [...get().toasts, event] })
    timers.set(
      event.id,
      setTimeout(() => get().dismiss(event.id), ttlMs)
    )
  },
  dismiss: (id) => {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
}))
