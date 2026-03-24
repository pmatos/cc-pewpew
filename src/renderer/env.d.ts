/// <reference types="vite/client" />

import type { Project, Session } from '../shared/types'

declare global {
  interface Window {
    api: {
      scanProjects: () => Promise<Project[]>
      setupProject: (path: string) => Promise<void>
      createProject: (name: string) => Promise<void>
      openInFileManager: (path: string) => Promise<void>
      onHookEvent: (callback: (event: { method: string; params: unknown }) => void) => () => void
      createSession: (projectPath: string, name?: string) => Promise<Session>
      getSessions: () => Promise<Session[]>
      killSession: (id: string) => Promise<void>
      removeWorktree: (id: string) => Promise<void>
      removeSession: (id: string) => Promise<void>
      focusSession: (ghosttyClass: string, pid: number) => Promise<void>
      onSessionsUpdated: (callback: (sessions: Session[]) => void) => () => void
      getCanvasState: () => Promise<{ zoom: number; panX: number; panY: number }>
      saveCanvasState: (state: { zoom: number; panX: number; panY: number }) => Promise<void>
      getClusterPositions: () => Promise<Record<string, { x: number; y: number }>>
      saveClusterPositions: (positions: Record<string, { x: number; y: number }>) => Promise<void>
      getSidebarWidth: () => Promise<number>
      saveSidebarWidth: (width: number) => Promise<void>
      onThumbnailsUpdated: (callback: (thumbnails: Record<string, string>) => void) => () => void
    }
  }
}
