import { useEffect, useState } from 'react'
import { useProjectsStore } from '../stores/projects'
import { useSessionsStore } from '../stores/sessions'
import { useHostsStore } from '../stores/hosts'
import ContextMenu, { type MenuItem } from './ContextMenu'
import type { AgentTool } from '../../shared/types'

interface MenuState {
  x: number
  y: number
  projectPath: string
  setupState: 'unsetup' | 'ready'
  hostId: string | null
}

interface TreeProps {
  onOpenSession?: (id: string, name: string) => void
}

export default function ProjectTree({ onOpenSession }: TreeProps) {
  const { projects, loading, scanProjects, filterReady } = useProjectsStore()
  const removeRemoteProject = useProjectsStore((s) => s.removeRemoteProject)
  const { sessions } = useSessionsStore()
  const hosts = useHostsStore((s) => s.hosts)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [pendingSessionPath, setPendingSessionPath] = useState<string | null>(null)
  const [pendingSessionHostId, setPendingSessionHostId] = useState<string | null>(null)
  const [sessionNameInput, setSessionNameInput] = useState('')
  const [defaultTool, setDefaultTool] = useState<AgentTool>('claude')
  const [pendingTool, setPendingTool] = useState<AgentTool>('claude')
  const [creating, setCreating] = useState(false)
  const [baseFromOrigin, setBaseFromOrigin] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pendingPrPath, setPendingPrPath] = useState<string | null>(null)
  const [prNumberInput, setPrNumberInput] = useState('')
  const [prError, setPrError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 5000)
  }

  useEffect(() => {
    scanProjects()
  }, [scanProjects])

  useEffect(() => {
    let cancelled = false
    window.api.getDefaultTool().then((tool) => {
      if (cancelled) return
      setDefaultTool(tool)
      // Don't touch pendingTool here — the New Session menu-item handler is
      // the only path that opens the dialog and it re-seeds pendingTool from
      // defaultTool at click time. Mutating pendingTool from this async
      // callback would race against any user toggle made between the click
      // and getDefaultTool resolving.
    })
    return () => {
      cancelled = true
    }
  }, [])

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
    setupState: 'unsetup' | 'ready',
    hostId: string | null
  ) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, projectPath, setupState, hostId })
  }

  const openNewSessionDialog = async (projectPath: string, hostId: string | null) => {
    setCreateError(null)
    setSessionNameInput('')
    setPendingTool(defaultTool)
    try {
      const worktreeBase = await window.api.getWorktreeBase()
      setBaseFromOrigin(worktreeBase === 'origin-default')
    } catch {
      setBaseFromOrigin(false)
    }
    setPendingSessionPath(projectPath)
    setPendingSessionHostId(hostId)
  }

  const describeCreateError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('no-origin-remote')) return 'This project has no origin remote.'
    if (message.includes('no-origin-default-branch')) {
      return "Could not determine origin's default branch."
    }
    return message.replace(/^Error:\s*/, '') || 'Failed to create session.'
  }

  const getMenuItems = (): MenuItem[] => {
    if (!menu) return []
    const items: MenuItem[] = []

    if (menu.hostId !== null) {
      const hostId = menu.hostId
      items.push({
        label: 'New session...',
        onClick: async () => {
          await openNewSessionDialog(menu.projectPath, hostId)
        },
      })
      items.push({ label: '', separator: true, onClick: () => {} })
      items.push({
        label: 'Remove remote project',
        onClick: () => void removeRemoteProject(hostId, menu.projectPath),
      })
      items.push({ label: '', separator: true, onClick: () => {} })
      items.push({ label: 'Rescan', onClick: () => scanProjects() })
      return items
    }

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
          await openNewSessionDialog(menu.projectPath, null)
        },
      })
      items.push({
        label: 'New PR session...',
        onClick: () => {
          setPendingPrPath(menu.projectPath)
          setPrNumberInput('')
          setPrError(null)
        },
      })

      const project = projects.find((p) => p.path === menu.projectPath)
      const unmirroredCount =
        project?.worktrees.filter(
          (wt) => !wt.isMain && !sessions.some((s) => s.worktreePath === wt.path)
        ).length ?? 0
      items.push({
        label:
          unmirroredCount > 0
            ? `Mirror all worktrees (${unmirroredCount})`
            : 'Mirror all worktrees',
        disabled: unmirroredCount === 0,
        onClick: async () => {
          const { result, warning } = await window.api.mirrorAllWorktrees(menu.projectPath)
          const { mirrored, failed } = result
          const parts: string[] = []
          if (mirrored.length > 0) parts.push(`Mirrored ${mirrored.length}`)
          if (failed.length > 0) parts.push(`${failed.length} failed`)
          if (parts.length > 0) showToast(parts.join(', '))
          if (warning === 'gitignore') {
            showToast(
              'Note: .claude/settings.local.json is not gitignored in this project — consider ignoring it.'
            )
          }
        },
      })
      items.push({
        label: 'Re-setup for cc-pewpew',
        onClick: async () => {
          await window.api.setupProject(menu.projectPath)
          scanProjects()
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
    setCreateError(null)
    try {
      const name = sessionNameInput.trim() || undefined
      await window.api.createSession(pendingSessionPath, name, pendingSessionHostId, {
        tool: pendingTool,
        baseRef: baseFromOrigin ? 'origin-default' : 'local',
      })
      setPendingSessionPath(null)
      setPendingSessionHostId(null)
      setSessionNameInput('')
    } catch (err) {
      setCreateError(describeCreateError(err))
    } finally {
      setCreating(false)
    }
  }

  const handleCreatePrSession = async () => {
    if (!pendingPrPath || creating) return
    const num = parseInt(prNumberInput.trim(), 10)
    if (isNaN(num) || num <= 0) {
      setPrError('Enter a valid PR number.')
      return
    }
    setCreating(true)
    setPrError(null)
    try {
      const result = await window.api.createPrSession(pendingPrPath, num)
      if (typeof result === 'string') {
        setPrError(result)
      } else {
        setPendingPrPath(null)
        setPrNumberInput('')
      }
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
              if (e.key === 'Escape') {
                setPendingSessionPath(null)
                setPendingSessionHostId(null)
                setCreateError(null)
              }
            }}
            autoFocus
          />
          <div className="session-name-label">Tool:</div>
          <div className="tool-picker">
            <label>
              <input
                type="radio"
                name="tool"
                value="claude"
                checked={pendingTool === 'claude'}
                onChange={() => setPendingTool('claude')}
              />
              Claude
            </label>
            <label>
              <input
                type="radio"
                name="tool"
                value="codex"
                checked={pendingTool === 'codex'}
                onChange={() => setPendingTool('codex')}
              />
              Codex
            </label>
          </div>
          <label className="session-base-checkbox">
            <input
              type="checkbox"
              checked={baseFromOrigin}
              onChange={(e) => {
                setBaseFromOrigin(e.target.checked)
                setCreateError(null)
              }}
            />
            <span>Branch from origin/&lt;default&gt;</span>
          </label>
          {createError && <div className="pr-error">{createError}</div>}
          <div className="create-actions">
            <button className="create-btn" onClick={handleCreateSession} disabled={creating}>
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              className="create-btn cancel"
              onClick={() => {
                setPendingSessionPath(null)
                setPendingSessionHostId(null)
                setCreateError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {pendingPrPath && (
        <div className="session-name-dialog">
          <div className="session-name-label">PR number:</div>
          <input
            type="text"
            className="create-input"
            placeholder="e.g. 42"
            value={prNumberInput}
            onChange={(e) => setPrNumberInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreatePrSession()
              if (e.key === 'Escape') {
                setPendingPrPath(null)
                setPrError(null)
              }
            }}
            autoFocus
          />
          {prError && <div className="pr-error">{prError}</div>}
          <div className="create-actions">
            <button className="create-btn" onClick={handleCreatePrSession} disabled={creating}>
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              className="create-btn cancel"
              onClick={() => {
                setPendingPrPath(null)
                setPrError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {displayProjects.map((project) => {
        const isExpanded = expanded.has(project.path)
        const hasWorktrees = project.worktrees.length > 1
        const host = project.hostId ? hosts.find((h) => h.hostId === project.hostId) : null

        return (
          <div key={`${project.hostId ?? 'local'}:${project.path}`} className="project-node">
            <div
              className="project-row"
              onClick={() => hasWorktrees && toggle(project.path)}
              onContextMenu={(e) =>
                handleContextMenu(e, project.path, project.setupState, project.hostId)
              }
            >
              <span className="project-toggle">
                {hasWorktrees ? (isExpanded ? '▼' : '▶') : ' '}
              </span>
              <span className="project-name">{project.name}</span>
              {host && (
                <span className="host-pill" title={`Remote on ${host.alias}`}>
                  {host.label}
                </span>
              )}
              {project.hostId === null &&
                (project.setupState === 'ready' ? (
                  <span className="badge-ready" title="cc-pewpew hooks installed">
                    ●
                  </span>
                ) : (
                  <span className="badge-unsetup" title="Not set up">
                    [Setup]
                  </span>
                ))}
            </div>

            {isExpanded && (
              <div className="worktree-list">
                {project.worktrees.map((wt) => {
                  const matchingSession = sessions.find((s) => s.worktreePath === wt.path)
                  const canMirror = !matchingSession && !wt.isMain
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
                      <span className="worktree-label">
                        {wt.name}
                        {wt.branch && <span className="worktree-branch"> ({wt.branch})</span>}
                      </span>
                      {canMirror && (
                        <button
                          className="worktree-mirror-btn"
                          title="Mirror this worktree as a cc-pewpew session"
                          onClick={async (e) => {
                            e.stopPropagation()
                            try {
                              const { warning } = await window.api.mirrorWorktree(
                                project.path,
                                wt.path
                              )
                              if (warning === 'gitignore') {
                                showToast(
                                  'Note: .claude/settings.local.json is not gitignored in this project — consider ignoring it.'
                                )
                              }
                            } catch (err) {
                              showToast(`Mirror failed: ${String(err)}`)
                            }
                          }}
                        >
                          + Mirror
                        </button>
                      )}
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

      {toast && <div className="project-tree-toast">{toast}</div>}
    </div>
  )
}
