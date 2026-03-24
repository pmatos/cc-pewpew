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
})
