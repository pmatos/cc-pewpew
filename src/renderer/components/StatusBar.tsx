import { useSessionsStore } from '../stores/sessions'
import { useCanvasStore } from '../stores/canvas'

export default function StatusBar() {
  const { sessions } = useSessionsStore()
  const panToCluster = useCanvasStore((s) => s.panToCluster)

  const running = sessions.filter((s) => s.status === 'running').length
  const needsInput = sessions.filter((s) => s.status === 'needs_input')
  const completed = sessions.filter((s) => s.status === 'completed').length

  return (
    <footer className="statusbar">
      <div className="statusbar-counts">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        {running > 0 && <span className="status-count running"> | {running} running</span>}
        {needsInput.length > 0 && (
          <span className="status-count attention"> | {needsInput.length} needs input</span>
        )}
        {completed > 0 && <span className="status-count"> | {completed} completed</span>}
      </div>
      {needsInput.length > 0 && (
        <div className="statusbar-jumps">
          {needsInput.map((s) => (
            <button
              key={s.id}
              className="quick-jump-btn"
              onClick={() => panToCluster?.(s.projectPath)}
              title={`Jump to ${s.projectName}/${s.worktreeName}`}
            >
              {s.projectName}/{s.worktreeName}
            </button>
          ))}
        </div>
      )}
    </footer>
  )
}
