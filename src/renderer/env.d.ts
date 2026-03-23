/// <reference types="vite/client" />

import type { Project } from '../shared/types'

declare global {
  interface Window {
    api: {
      scanProjects: () => Promise<Project[]>
    }
  }
}
