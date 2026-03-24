import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  scanProjects: () => ipcRenderer.invoke('projects:scan'),
  setupProject: (path: string) => ipcRenderer.invoke('projects:setup', path),
  createProject: (name: string) => ipcRenderer.invoke('projects:create', name),
  openInFileManager: (path: string) => ipcRenderer.invoke('projects:open-file-manager', path),
  onHookEvent: (callback: (event: { method: string; params: unknown }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { method: string; params: unknown }
    ) => callback(data)
    ipcRenderer.on('hook:event', handler)
    return () => ipcRenderer.removeListener('hook:event', handler)
  },
  createSession: (projectPath: string, name?: string) =>
    ipcRenderer.invoke('sessions:create', projectPath, name),
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  killSession: (id: string) => ipcRenderer.invoke('sessions:kill', id),
  removeWorktree: (id: string) => ipcRenderer.invoke('sessions:remove-worktree', id),
  removeSession: (id: string) => ipcRenderer.invoke('sessions:remove', id),
  onSessionsUpdated: (callback: (sessions: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown[]) => callback(data)
    ipcRenderer.on('sessions:updated', handler)
    return () => ipcRenderer.removeListener('sessions:updated', handler)
  },
  onOpenDetail: (callback: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('sessions:open-detail', handler)
    return () => ipcRenderer.removeListener('sessions:open-detail', handler)
  },
  getCanvasState: () => ipcRenderer.invoke('config:get-canvas'),
  saveCanvasState: (state: { zoom: number; panX: number; panY: number }) =>
    ipcRenderer.invoke('config:save-canvas', state),
  getClusterPositions: () => ipcRenderer.invoke('config:get-clusters'),
  saveClusterPositions: (positions: Record<string, { x: number; y: number }>) =>
    ipcRenderer.invoke('config:save-clusters', positions),
  getSidebarWidth: () => ipcRenderer.invoke('config:get-sidebar-width'),
  saveSidebarWidth: (width: number) => ipcRenderer.invoke('config:save-sidebar-width', width),
  onTextThumbnails: (callback: (data: Record<string, string>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, string>) =>
      callback(data)
    ipcRenderer.on('thumbnails:text-updated', handler)
    return () => ipcRenderer.removeListener('thumbnails:text-updated', handler)
  },
  ptyWrite: (sessionId: string, data: string) => ipcRenderer.invoke('pty:write', sessionId, data),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
  ptyDestroy: (sessionId: string) => ipcRenderer.invoke('pty:destroy', sessionId),
  ptyGetScrollback: (sessionId: string) => ipcRenderer.invoke('pty:scrollback', sessionId),
  onPtyData: (callback: (data: { sessionId: string; data: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; data: string }
    ) => callback(data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
})
