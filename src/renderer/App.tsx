import { useState, useEffect } from 'react'
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

  const handleCreate = async () => {
    const name = newProjectName.trim()
    if (!name) return
    await window.api.createProject(name)
    setNewProjectName('')
    setShowCreateDialog(false)
    scanProjects()
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Projects</span>
          <button className="refresh-btn" onClick={scanProjects} title="Refresh projects">
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
            <button className="new-project-btn" onClick={() => setShowCreateDialog(true)}>
              + New project
            </button>
          )}
        </div>
      </aside>

      <main className="canvas">
        <SessionCanvas />
      </main>

      <StatusBar />
    </div>
  )
}
