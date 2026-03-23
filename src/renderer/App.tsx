export default function App() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">Projects</div>
        <div className="sidebar-content" />
      </aside>

      <main className="canvas">
        <span className="canvas-placeholder">No sessions</span>
      </main>

      <footer className="statusbar">0 sessions</footer>
    </div>
  )
}
