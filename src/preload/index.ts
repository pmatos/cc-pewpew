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
  onSessionsUpdated: (callback: (sessions: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown[]) => callback(data)
    ipcRenderer.on('sessions:updated', handler)
    return () => ipcRenderer.removeListener('sessions:updated', handler)
  },
  focusSession: (ghosttyClass: string, pid: number) =>
    ipcRenderer.invoke('sessions:focus', ghosttyClass, pid),
  getCanvasState: () => ipcRenderer.invoke('config:get-canvas'),
  saveCanvasState: (state: { zoom: number; panX: number; panY: number }) =>
    ipcRenderer.invoke('config:save-canvas', state),
  getClusterPositions: () => ipcRenderer.invoke('config:get-clusters'),
  saveClusterPositions: (positions: Record<string, { x: number; y: number }>) =>
    ipcRenderer.invoke('config:save-clusters', positions),
  onThumbnailsUpdated: (callback: (thumbnails: Record<string, string>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, string>) =>
      callback(data)
    ipcRenderer.on('thumbnails:updated', handler)
    return () => ipcRenderer.removeListener('thumbnails:updated', handler)
  },
})
