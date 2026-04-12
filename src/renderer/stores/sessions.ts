import { create } from 'zustand'
import type { Session } from '../../shared/types'

interface SessionsState {
  sessions: Session[]
  thumbnails: Record<string, string>
  selectedIds: Set<string>
  lastSelectedId: string | null
  fetchSessions: () => Promise<void>
  init: () => () => void
  toggleSelect: (id: string, multi: boolean) => void
  rangeSelect: (id: string, orderedIds: string[]) => void
  selectAll: (projectPath: string) => void
  clearSelection: () => void
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  thumbnails: {},
  selectedIds: new Set<string>(),
  lastSelectedId: null,
  fetchSessions: async () => {
    const sessions = await window.api.getSessions()
    set({ sessions })
  },
  init: () => {
    window.api.getSessions().then((sessions) => set({ sessions }))

    const cleanupSessions = window.api.onSessionsUpdated((sessions) => {
      const { selectedIds } = get()
      const validIds = new Set(sessions.map((s) => s.id))
      const pruned = new Set([...selectedIds].filter((id) => validIds.has(id)))
      set({
        sessions,
        selectedIds: pruned.size !== selectedIds.size ? pruned : selectedIds,
      })
    })

    const cleanupThumbnails = window.api.onTextThumbnails((thumbnails) => {
      set({ thumbnails })
    })

    return () => {
      cleanupSessions()
      cleanupThumbnails()
    }
  },
  toggleSelect: (id, multi) => {
    if (multi) {
      const { selectedIds } = get()
      const next = new Set(selectedIds)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      set({ selectedIds: next, lastSelectedId: id })
    } else {
      set({ selectedIds: new Set([id]), lastSelectedId: id })
    }
  },
  rangeSelect: (id, orderedIds) => {
    const { lastSelectedId, selectedIds } = get()
    if (!lastSelectedId) {
      set({ selectedIds: new Set([id]), lastSelectedId: id })
      return
    }
    const startIdx = orderedIds.indexOf(lastSelectedId)
    const endIdx = orderedIds.indexOf(id)
    if (startIdx === -1 || endIdx === -1) {
      set({ selectedIds: new Set([id]), lastSelectedId: id })
      return
    }
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    const rangeIds = orderedIds.slice(lo, hi + 1)
    const next = new Set([...selectedIds, ...rangeIds])
    set({ selectedIds: next })
  },
  selectAll: (projectPath) => {
    const { sessions } = get()
    const ids = sessions.filter((s) => s.projectPath === projectPath).map((s) => s.id)
    set({ selectedIds: new Set(ids), lastSelectedId: ids[ids.length - 1] ?? null })
  },
  clearSelection: () => {
    set({ selectedIds: new Set(), lastSelectedId: null })
  },
}))
