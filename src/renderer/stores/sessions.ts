import { create } from 'zustand'
import type { Session } from '../../shared/types'

interface SessionsState {
  sessions: Session[]
  thumbnails: Record<string, string>
  fetchSessions: () => Promise<void>
  setThumbnail: (sessionId: string, dataUrl: string) => void
  init: () => () => void
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  thumbnails: {},
  fetchSessions: async () => {
    const sessions = await window.api.getSessions()
    set({ sessions })
  },
  setThumbnail: (sessionId, dataUrl) => {
    set((state) => ({
      thumbnails: { ...state.thumbnails, [sessionId]: dataUrl },
    }))
  },
  init: () => {
    window.api.getSessions().then((sessions) => set({ sessions }))

    const cleanupSessions = window.api.onSessionsUpdated((sessions) => {
      set({ sessions })
    })

    return cleanupSessions
  },
}))
