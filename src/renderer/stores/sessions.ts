import { create } from 'zustand'
import type { Session } from '../../shared/types'

interface SessionsState {
  sessions: Session[]
  fetchSessions: () => Promise<void>
  init: () => () => void
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  fetchSessions: async () => {
    const sessions = await window.api.getSessions()
    set({ sessions })
  },
  init: () => {
    // Fetch initial state
    window.api.getSessions().then((sessions) => set({ sessions }))

    // Subscribe to updates from main process
    const cleanup = window.api.onSessionsUpdated((sessions) => {
      set({ sessions })
    })

    return cleanup
  },
}))
