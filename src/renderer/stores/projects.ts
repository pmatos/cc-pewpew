import { create } from 'zustand'
import type { Project } from '../../shared/types'

interface ProjectsState {
  projects: Project[]
  loading: boolean
  filterReady: boolean
  scanProjects: () => Promise<void>
  toggleFilterReady: () => void
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  loading: false,
  filterReady: false,
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
}))
