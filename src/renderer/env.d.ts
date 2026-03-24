/// <reference types="vite/client" />

import type { Project } from '../shared/types'

declare global {
  interface Window {
    api: {
      scanProjects: () => Promise<Project[]>
      setupProject: (path: string) => Promise<void>
      createProject: (name: string) => Promise<void>
      openInFileManager: (path: string) => Promise<void>
      onHookEvent: (callback: (event: { method: string; params: unknown }) => void) => () => void
    }
  }
}
