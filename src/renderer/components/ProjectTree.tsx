import { useEffect, useState } from 'react'
import { useProjectsStore } from '../stores/projects'
import ContextMenu, { type MenuItem } from './ContextMenu'

interface MenuState {
  x: number
  y: number
  projectPath: string
  setupState: 'unsetup' | 'ready'
}

export default function ProjectTree() {
  const { projects, loading, scanProjects } = useProjectsStore()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)

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
        onClick: async () => {
          await window.api.createSession(menu.projectPath)
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

  if (projects.length === 0) {
    return (
      <div className="project-empty">
        No git repos found in scan directories. Use &quot;+ New project&quot; below to create one.
      </div>
    )
  }

  return (
    <div className="project-tree">
      {projects.map((project) => {
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
                {project.worktrees.map((wt) => (
                  <div key={wt.path} className="worktree-item">
                    {wt.name}
                    {wt.branch && <span className="worktree-branch"> ({wt.branch})</span>}
                  </div>
                ))}
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
