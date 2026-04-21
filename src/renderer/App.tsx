import { useState, useEffect, useRef, useCallback } from 'react'
import ProjectTree from './components/ProjectTree'
import SessionCanvas, { type ZoomOpenPayload } from './components/SessionCanvas'
import DetailPane from './components/DetailPane'
import StatusBar from './components/StatusBar'
import ManageHostsDialog from './components/ManageHostsDialog'
import ZoomOpenMorph from './components/ZoomOpenMorph'
import { useProjectsStore } from './stores/projects'
import { useSessionsStore } from './stores/sessions'
import { useHostsStore } from './stores/hosts'

export default function App() {
  const { scanProjects, filterReady, toggleFilterReady } = useProjectsStore()
  const { init: initSessions } = useSessionsStore()
  const hosts = useHostsStore((s) => s.hosts)
  const openHostsDialog = useHostsStore((s) => s.openDialog)
  const fetchHosts = useHostsStore((s) => s.fetchHosts)

  useEffect(() => {
    void fetchHosts()
  }, [fetchHosts])

  useEffect(() => {
    return initSessions()
  }, [initSessions])

  // Subscribe to open-detail IPC from tray/notifications
  useEffect(() => {
    return window.api.onOpenDetail((sessionId) => {
      const sessions = useSessionsStore.getState().sessions
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        setActiveSessionId(sessionId)
        setActiveSessionName(`${session.projectName}/${session.worktreeName}`)
      }
    })
  }, [])

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(250)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeSessionName, setActiveSessionName] = useState('')
  const [morphPayload, setMorphPayload] = useState<ZoomOpenPayload | null>(null)

  const handleZoomOpen = useCallback((payload: ZoomOpenPayload) => {
    // Keep canvas rendered during the morph; mount DetailPane only on morph grown.
    setMorphPayload(payload)
  }, [])
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
      } else if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault()
        scanProjects()
      } else if (e.key === 'Escape') {
        // Modals handle Escape themselves; don't run global shortcuts when
        // one is open (avoids side-effect clearing of active session /
        // selection when dismissing a modal via Escape).
        if (useHostsStore.getState().dialogOpen) return
        if (morphPayload && !activeSessionId) {
          // Cancel zoom-open mid-morph: abort the transition and stay on canvas.
          setMorphPayload(null)
        } else if (activeSessionId) {
          setActiveSessionId(null)
        } else if (useSessionsStore.getState().selectedIds.size > 0) {
          useSessionsStore.getState().clearSelection()
        } else {
          setShowCreateDialog(false)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [scanProjects, activeSessionId, morphPayload])

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
          <div className="sidebar-header-actions">
            <button
              className={`filter-btn${filterReady ? ' active' : ''}`}
              onClick={toggleFilterReady}
              title={filterReady ? 'Showing setup projects only' : 'Show only setup projects'}
            >
              ●
            </button>
            <button
              className="refresh-btn"
              onClick={scanProjects}
              title="Refresh projects (Ctrl+Shift+R)"
            >
              ⟳
            </button>
          </div>
        </div>
        <div className="sidebar-content">
          <ProjectTree
            onOpenSession={(id, name) => {
              setActiveSessionId(id)
              setActiveSessionName(name)
            }}
          />
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
          <button
            className="new-project-btn hosts-btn"
            onClick={openHostsDialog}
            title="Manage SSH hosts"
          >
            🌐 Hosts ({hosts.length})
          </button>
        </div>
      </aside>

      <div className="sidebar-resizer" onMouseDown={handleResizeStart} />

      <main className="canvas">
        {activeSessionId ? (
          <DetailPane
            sessionId={activeSessionId}
            sessionName={activeSessionName}
            onClose={() => setActiveSessionId(null)}
          />
        ) : (
          <SessionCanvas
            onOpenSession={(id, name) => {
              setActiveSessionId(id)
              setActiveSessionName(name)
            }}
            onZoomOpen={handleZoomOpen}
            morphActive={morphPayload !== null}
          />
        )}
      </main>

      <ManageHostsDialog />
      {morphPayload && (
        <ZoomOpenMorph
          startRect={morphPayload.startRect}
          onGrown={() => {
            // If the user already opened a different session during the morph
            // window (e.g. clicked another card), keep that selection.
            setActiveSessionId((prev) => prev ?? morphPayload.sessionId)
            setActiveSessionName((prev) => prev || morphPayload.sessionName)
          }}
          onDone={() => setMorphPayload(null)}
        />
      )}

      <StatusBar />
    </div>
  )
}
