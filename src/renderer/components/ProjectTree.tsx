import { useEffect, useState } from 'react'
import { useProjectsStore } from '../stores/projects'

export default function ProjectTree() {
  const { projects, loading, scanProjects } = useProjectsStore()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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

  if (loading) {
    return <div className="project-loading">Scanning...</div>
  }

  if (projects.length === 0) {
    return <div className="project-empty">No git repos found</div>
  }

  return (
    <div className="project-tree">
      {projects.map((project) => {
        const isExpanded = expanded.has(project.path)
        const hasWorktrees = project.worktrees.length > 1

        return (
          <div key={project.path} className="project-node">
            <div className="project-row" onClick={() => hasWorktrees && toggle(project.path)}>
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
    </div>
  )
}
