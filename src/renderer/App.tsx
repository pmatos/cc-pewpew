import ProjectTree from './components/ProjectTree'
import { useProjectsStore } from './stores/projects'

export default function App() {
  const { scanProjects } = useProjectsStore()

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
      </aside>

      <main className="canvas">
        <span className="canvas-placeholder">No sessions</span>
      </main>

      <footer className="statusbar">0 sessions</footer>
    </div>
  )
}
