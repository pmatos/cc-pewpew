import { useEffect, useState } from 'react'
import type { Host } from '../../shared/types'
import { useProjectsStore } from '../stores/projects'
import { useHostsStore } from '../stores/hosts'

export default function AddRemoteProjectDialog() {
  const dialogOpen = useProjectsStore((s) => s.addRemoteDialogOpen)
  const error = useProjectsStore((s) => s.addRemoteError)
  const submitting = useProjectsStore((s) => s.addRemoteSubmitting)
  const closeDialog = useProjectsStore((s) => s.closeAddRemoteDialog)
  const addRemoteProject = useProjectsStore((s) => s.addRemoteProject)
  const clearError = useProjectsStore((s) => s.clearAddRemoteError)

  const hosts = useHostsStore((s) => s.hosts)
  const openHostsDialog = useHostsStore((s) => s.openDialog)

  // Escape handling mirrors ManageHostsDialog: bubble-phase listener with a
  // DOM-topology guard so the form's own input Escape wins.
  useEffect(() => {
    if (!dialogOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && target.closest('.add-remote-form')) return
      closeDialog()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dialogOpen, closeDialog])

  if (!dialogOpen) return null

  return (
    <AddRemoteProjectDialogContent
      hosts={hosts}
      error={error}
      submitting={submitting}
      closeDialog={closeDialog}
      addRemoteProject={addRemoteProject}
      clearError={clearError}
      openHostsDialog={openHostsDialog}
    />
  )
}

interface AddRemoteProjectDialogContentProps {
  hosts: Host[]
  error: string | null
  submitting: boolean
  closeDialog: () => void
  addRemoteProject: (input: { hostId: string; path: string }) => Promise<void>
  clearError: () => void
  openHostsDialog: () => void
}

function AddRemoteProjectDialogContent({
  hosts,
  error,
  submitting,
  closeDialog,
  addRemoteProject,
  clearError,
  openHostsDialog,
}: AddRemoteProjectDialogContentProps) {
  const [selectedHostId, setSelectedHostId] = useState(() => hosts[0]?.hostId ?? '')
  const [remotePath, setRemotePath] = useState('')

  const selectedHostAvailable = hosts.some((h) => h.hostId === selectedHostId)
  const activeHostId = selectedHostAvailable ? selectedHostId : (hosts[0]?.hostId ?? '')
  const canSubmit = activeHostId !== '' && remotePath.trim().length > 0 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    await addRemoteProject({ hostId: activeHostId, path: remotePath.trim() })
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    } else if (e.key === 'Escape') {
      closeDialog()
    }
  }

  return (
    <div
      className="hosts-dialog-overlay"
      onClick={closeDialog}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="hosts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="hosts-dialog-header">
          <div className="session-name-label">Add remote project</div>
          <button className="create-btn cancel" onClick={closeDialog}>
            Close
          </button>
        </div>

        {error && (
          <div className="hosts-error" onClick={clearError}>
            {error}
          </div>
        )}

        {hosts.length === 0 ? (
          <div className="add-remote-empty">
            <p>No hosts configured. Add a host first.</p>
            <button
              className="create-btn"
              onClick={() => {
                closeDialog()
                openHostsDialog()
              }}
            >
              Manage hosts
            </button>
          </div>
        ) : (
          <div className="add-remote-form hosts-form">
            <select
              autoFocus
              className="create-input"
              value={activeHostId}
              onChange={(e) => setSelectedHostId(e.target.value)}
              onKeyDown={handleKey}
            >
              {hosts.map((h) => (
                <option key={h.hostId} value={h.hostId}>
                  {h.label} ({h.alias})
                </option>
              ))}
            </select>
            <input
              type="text"
              className="create-input"
              placeholder="/absolute/path/on/remote"
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              onKeyDown={handleKey}
            />
            <div className="create-actions">
              <button className="create-btn" disabled={!canSubmit} onClick={handleSubmit}>
                {submitting ? 'Validating…' : 'Add'}
              </button>
              <button className="create-btn cancel" onClick={closeDialog} disabled={submitting}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
