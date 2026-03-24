import { create } from 'zustand'

interface CanvasStore {
  panToCluster: ((projectPath: string) => void) | null
  setPanToCluster: (fn: (projectPath: string) => void) => void
}

export const useCanvasStore = create<CanvasStore>((set) => ({
  panToCluster: null,
  setPanToCluster: (fn) => set({ panToCluster: fn }),
}))
