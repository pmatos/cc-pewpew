import { create } from 'zustand'
import type { Project } from '../../shared/types'

interface ProjectsState {
  projects: Project[]
  loading: boolean
  filterReady: boolean
  addRemoteDialogOpen: boolean
  addRemoteError: string | null
  addRemoteSubmitting: boolean
  scanProjects: () => Promise<void>
  toggleFilterReady: () => void
  openAddRemoteDialog: () => void
  closeAddRemoteDialog: () => void
  clearAddRemoteError: () => void
  addRemoteProject: (input: { hostId: string; path: string }) => Promise<void>
  removeRemoteProject: (hostId: string, path: string) => Promise<void>
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,
  filterReady: false,
  addRemoteDialogOpen: false,
  addRemoteError: null,
  addRemoteSubmitting: false,
  toggleFilterReady: () => set((state) => ({ filterReady: !state.filterReady })),
  scanProjects: async () => {
    set({ loading: true })
    try {
      const projects = await window.api.scanProjects()
      set({ projects, loading: false })
    } catch (err) {
      console.error('scanProjects failed:', err)
      set({ loading: false })
    }
  },
  openAddRemoteDialog: () =>
    set({ addRemoteDialogOpen: true, addRemoteError: null, addRemoteSubmitting: false }),
  closeAddRemoteDialog: () =>
    set({ addRemoteDialogOpen: false, addRemoteError: null, addRemoteSubmitting: false }),
  clearAddRemoteError: () => set({ addRemoteError: null }),
  addRemoteProject: async (input) => {
    set({ addRemoteSubmitting: true, addRemoteError: null })
    try {
      await window.api.addRemoteProject(input)
      set({ addRemoteSubmitting: false, addRemoteDialogOpen: false, addRemoteError: null })
      await get().scanProjects()
    } catch (e) {
      set({ addRemoteSubmitting: false, addRemoteError: errorMessage(e) })
    }
  },
  removeRemoteProject: async (hostId, path) => {
    try {
      await window.api.removeRemoteProject(hostId, path)
      await get().scanProjects()
    } catch (e) {
      console.error('removeRemoteProject failed:', e)
    }
  },
}))
