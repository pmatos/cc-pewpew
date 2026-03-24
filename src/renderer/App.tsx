import { useState } from 'react'
import ProjectTree from './components/ProjectTree'
import { useProjectsStore } from './stores/projects'

export default function App() {
  const { scanProjects } = useProjectsStore()
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
        <span className="canvas-placeholder">No sessions</span>
      </main>

      <footer className="statusbar">0 sessions</footer>
    </div>
  )
}
