import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  scanProjects: () => ipcRenderer.invoke('projects:scan'),
})
