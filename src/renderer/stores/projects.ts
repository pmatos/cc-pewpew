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
    // Will be wired to window.api.scanProjects() in Phase 3
    set({ loading: false })
  },
}))
