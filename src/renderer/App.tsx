import { useState, useEffect, useRef, useCallback } from 'react'
import ProjectTree from './components/ProjectTree'
import SessionCanvas from './components/SessionCanvas'
import StatusBar from './components/StatusBar'
import { useProjectsStore } from './stores/projects'
import { useSessionsStore } from './stores/sessions'

export default function App() {
  const { scanProjects } = useProjectsStore()
  const { init: initSessions } = useSessionsStore()

  useEffect(() => {
    return initSessions()
  }, [initSessions])

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(250)
  const resizing = useRef(false)
  const resizeStart = useRef({ x: 0, width: 0 })

  // Load sidebar width
  useEffect(() => {
    window.api.getSidebarWidth().then((w) => setSidebarWidth(w))
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        setShowCreateDialog(true)
      } else if (e.ctrlKey && e.key === 'r') {
        e.preventDefault()
        scanProjects()
      } else if (e.key === 'Escape') {
        setShowCreateDialog(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [scanProjects])

  const handleCreate = async () => {
    const name = newProjectName.trim()
    if (!name) return
    await window.api.createProject(name)
    setNewProjectName('')
    setShowCreateDialog(false)
    scanProjects()
  }

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizing.current = true
      resizeStart.current = { x: e.clientX, width: sidebarWidth }
    },
    [sidebarWidth]
  )

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!resizing.current) return
      const dx = e.clientX - resizeStart.current.x
      const newWidth = Math.max(150, Math.min(500, resizeStart.current.width + dx))
      setSidebarWidth(newWidth)
    }

    const handleUp = () => {
      if (resizing.current) {
        resizing.current = false
        window.api.saveSidebarWidth(sidebarWidth)
      }
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [sidebarWidth])

  return (
    <div className="app-layout" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Projects</span>
          <button className="refresh-btn" onClick={scanProjects} title="Refresh projects (Ctrl+R)">
            ⟳
          </button>
        </div>
        <div className="sidebar-content">
          <ProjectTree />
        </div>
        <div className="sidebar-footer">
          {showCreateDialog ? (
            <div className="create-dialog">
              <input
                type="text"
                className="create-input"
                placeholder="Project name..."
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') setShowCreateDialog(false)
                }}
                autoFocus
              />
              <div className="create-actions">
                <button className="create-btn" onClick={handleCreate}>
                  Create
                </button>
                <button className="create-btn cancel" onClick={() => setShowCreateDialog(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="new-project-btn"
              onClick={() => setShowCreateDialog(true)}
              title="Ctrl+N"
            >
              + New project
            </button>
          )}
        </div>
      </aside>

      <div className="sidebar-resizer" onMouseDown={handleResizeStart} />

      <main className="canvas">
        <SessionCanvas />
      </main>

      <StatusBar />
    </div>
  )
}
