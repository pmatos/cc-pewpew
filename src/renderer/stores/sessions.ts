import { create } from 'zustand'
import type { Session } from '../../shared/types'
import { useProjectsStore } from './projects'

interface SessionsState {
  sessions: Session[]
  thumbnails: Record<string, string>
  fetchSessions: () => Promise<void>
  init: () => () => void
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  thumbnails: {},
  fetchSessions: async () => {
    const sessions = await window.api.getSessions()
    set({ sessions })
  },
  init: () => {
    window.api.getSessions().then((sessions) => set({ sessions }))

    const cleanupSessions = window.api.onSessionsUpdated((sessions) => {
      set({ sessions })
      useProjectsStore.getState().scanProjects()
    })

    const cleanupThumbnails = window.api.onTextThumbnails((thumbnails) => {
      set({ thumbnails })
    })

    return () => {
      cleanupSessions()
      cleanupThumbnails()
    }
  },
}))
