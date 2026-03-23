import { create } from 'zustand'
import type { Project } from '../../shared/types'

interface ProjectsState {
  projects: Project[]
  loading: boolean
  scanProjects: () => Promise<void>
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  loading: false,
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
