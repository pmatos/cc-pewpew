import { create } from 'zustand'
import type { Session } from '../../shared/types'

interface SessionsState {
  sessions: Session[]
  thumbnails: Record<string, string>
  selectedIds: Set<string>
  lastSelectedId: string | null
  broadcastDialogOpen: boolean
  fetchSessions: () => Promise<void>
  init: () => () => void
  // Merge a partial thumbnail update into the existing map. The main process
  // emits one entry at a time so a slow remote capture can't gate healthy
  // siblings, so this MUST merge, not replace — otherwise each event would
  // wipe every other live session's thumbnail.
  applyThumbnailPatch: (patch: Record<string, string>) => void
  // Replace the sessions list and prune any thumbnail entries whose session
  // no longer exists, so dead sessions don't leak stale entries forever.
  syncSessions: (sessions: Session[]) => void
  toggleSelect: (id: string, multi: boolean) => void
  rangeSelect: (id: string, orderedIds: string[]) => void
  selectAll: (projectPath: string) => void
  clearSelection: () => void
  openBroadcastDialog: () => void
  closeBroadcastDialog: () => void
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  thumbnails: {},
  selectedIds: new Set<string>(),
  lastSelectedId: null,
  broadcastDialogOpen: false,
  fetchSessions: async () => {
    const sessions = await window.api.getSessions()
    set({ sessions })
  },
  init: () => {
    window.api.getSessions().then((sessions) => set({ sessions }))

    const cleanupSessions = window.api.onSessionsUpdated(get().syncSessions)
    const cleanupThumbnails = window.api.onTextThumbnails(get().applyThumbnailPatch)

    return () => {
      cleanupSessions()
      cleanupThumbnails()
    }
  },
  applyThumbnailPatch: (patch) => {
    set((s) => ({ thumbnails: { ...s.thumbnails, ...patch } }))
  },
  syncSessions: (sessions) => {
    const { selectedIds, thumbnails } = get()
    const validIds = new Set(sessions.map((s) => s.id))
    const prunedSel = new Set([...selectedIds].filter((id) => validIds.has(id)))
    const hasStaleThumb = Object.keys(thumbnails).some((id) => !validIds.has(id))
    set({
      sessions,
      selectedIds: prunedSel.size !== selectedIds.size ? prunedSel : selectedIds,
      thumbnails: hasStaleThumb
        ? Object.fromEntries(Object.entries(thumbnails).filter(([id]) => validIds.has(id)))
        : thumbnails,
    })
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
    set({ selectedIds: new Set(), lastSelectedId: null, broadcastDialogOpen: false })
  },
  openBroadcastDialog: () => {
    set({ broadcastDialogOpen: true })
  },
  closeBroadcastDialog: () => {
    set({ broadcastDialogOpen: false })
  },
}))
