import { useEffect, useState } from 'react'
import { useProjectsStore } from '../stores/projects'
import { useSessionsStore } from '../stores/sessions'
import ContextMenu, { type MenuItem } from './ContextMenu'

interface MenuState {
  x: number
  y: number
  projectPath: string
  setupState: 'unsetup' | 'ready'
}

interface TreeProps {
  onOpenSession?: (id: string, name: string) => void
}

export default function ProjectTree({ onOpenSession }: TreeProps) {
  const { projects, loading, scanProjects, filterReady } = useProjectsStore()
  const { sessions } = useSessionsStore()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [pendingSessionPath, setPendingSessionPath] = useState<string | null>(null)
  const [sessionNameInput, setSessionNameInput] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    scanProjects()
  }, [scanProjects])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const handleContextMenu = (
    e: React.MouseEvent,
    projectPath: string,
    setupState: 'unsetup' | 'ready'
  ) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, projectPath, setupState })
  }

  const getMenuItems = (): MenuItem[] => {
    if (!menu) return []
    const items: MenuItem[] = []

    if (menu.setupState === 'unsetup') {
      items.push({
        label: 'Setup for cc-pewpew',
        onClick: async () => {
          await window.api.setupProject(menu.projectPath)
          scanProjects()
        },
      })
    } else {
      items.push({
        label: 'New session...',
        onClick: () => {
          setPendingSessionPath(menu.projectPath)
          setSessionNameInput('')
        },
      })
    }

    items.push({ label: '', separator: true, onClick: () => {} })

    items.push({
      label: 'Open in file manager',
      onClick: () => window.api.openInFileManager(menu.projectPath),
    })

    items.push({
      label: 'Rescan',
      onClick: () => scanProjects(),
    })

    return items
  }

  if (loading) {
    return <div className="project-loading">Scanning...</div>
  }

  const displayProjects = filterReady ? projects.filter((p) => p.setupState === 'ready') : projects

  if (displayProjects.length === 0) {
    return (
      <div className="project-empty">
        {filterReady
          ? 'No setup projects. Right-click a project to set it up, or disable the filter.'
          : 'No git repos found in scan directories. Use "+ New project" below to create one.'}
      </div>
    )
  }

  const handleCreateSession = async () => {
    if (!pendingSessionPath || creating) return
    setCreating(true)
    try {
      const name = sessionNameInput.trim() || undefined
      await window.api.createSession(pendingSessionPath, name)
      setPendingSessionPath(null)
      setSessionNameInput('')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="project-tree">
      {pendingSessionPath && (
        <div className="session-name-dialog">
          <div className="session-name-label">Session name (optional):</div>
          <input
            type="text"
            className="create-input"
            placeholder="Leave empty for auto-name..."
            value={sessionNameInput}
            onChange={(e) => setSessionNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateSession()
              if (e.key === 'Escape') setPendingSessionPath(null)
            }}
            autoFocus
          />
          <div className="create-actions">
            <button className="create-btn" onClick={handleCreateSession} disabled={creating}>
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button className="create-btn cancel" onClick={() => setPendingSessionPath(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {displayProjects.map((project) => {
        const isExpanded = expanded.has(project.path)
        const hasWorktrees = project.worktrees.length > 1

        return (
          <div key={project.path} className="project-node">
            <div
              className="project-row"
              onClick={() => hasWorktrees && toggle(project.path)}
              onContextMenu={(e) => handleContextMenu(e, project.path, project.setupState)}
            >
              <span className="project-toggle">
                {hasWorktrees ? (isExpanded ? '▼' : '▶') : ' '}
              </span>
              <span className="project-name">{project.name}</span>
              {project.setupState === 'ready' ? (
                <span className="badge-ready" title="cc-pewpew hooks installed">
                  ●
                </span>
              ) : (
                <span className="badge-unsetup" title="Not set up">
                  [Setup]
                </span>
              )}
            </div>

            {isExpanded && (
              <div className="worktree-list">
                {project.worktrees.map((wt) => {
                  const matchingSession = sessions.find(
                    (s) => s.worktreeName === wt.name && s.projectPath === project.path
                  )
                  return (
                    <div
                      key={wt.path}
                      className={`worktree-item${matchingSession ? ' clickable' : ''}`}
                      onClick={() => {
                        if (matchingSession && onOpenSession) {
                          onOpenSession(
                            matchingSession.id,
                            `${matchingSession.projectName}/${matchingSession.worktreeName}`
                          )
                        }
                      }}
                    >
                      {wt.name}
                      {wt.branch && <span className="worktree-branch"> ({wt.branch})</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={getMenuItems()} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
