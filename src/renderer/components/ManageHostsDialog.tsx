import { useEffect, useState } from 'react'
import { useHostsStore } from '../stores/hosts'
import type { Host, HostId, TestConnectionResult } from '../../shared/types'

function reasonToLabel(reason: TestConnectionResult['reason']): string {
  switch (reason) {
    case 'auth-failed':
      return 'Auth failed'
    case 'network':
      return 'Network error'
    case 'dep-missing':
      return 'Missing dep'
    default:
      return 'Failed'
  }
}

interface HostFormProps {
  initialAlias?: string
  initialLabel?: string
  submitLabel: string
  onSubmit: (alias: string, label: string) => Promise<void>
  onCancel: () => void
}

function HostForm({
  initialAlias = '',
  initialLabel = '',
  submitLabel,
  onSubmit,
  onCancel,
}: HostFormProps) {
  const [alias, setAlias] = useState(initialAlias)
  const [label, setLabel] = useState(initialLabel)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = alias.trim().length > 0 && label.trim().length > 0 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(alias.trim(), label.trim())
    } catch {
      // Error shown via store.error; keep the form open so the user can retry.
    } finally {
      setSubmitting(false)
    }
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="hosts-form">
      <input
        autoFocus
        type="text"
        className="create-input"
        placeholder="ssh alias (e.g. devbox)"
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        onKeyDown={handleKey}
      />
      <input
        type="text"
        className="create-input"
        placeholder="Short label (e.g. Dev box)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={handleKey}
      />
      <div className="create-actions">
        <button className="create-btn" disabled={!canSubmit} onClick={handleSubmit}>
          {submitLabel}
        </button>
        <button className="create-btn cancel" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </div>
  )
}

interface HostRowProps {
  host: Host
  testing: boolean
  result?: TestConnectionResult
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}

function HostRow({ host, testing, result, onTest, onEdit, onDelete }: HostRowProps) {
  return (
    <div className="hosts-row">
      <div className="hosts-row-main">
        <div className="host-label">{host.label}</div>
        <div className="host-alias">{host.alias}</div>
        {result && (
          <div className={`host-test-result ${result.ok ? 'ok' : 'err'}`}>
            {result.ok
              ? 'OK'
              : `${reasonToLabel(result.reason)}${result.message ? `: ${result.message}` : ''}`}
          </div>
        )}
      </div>
      <div className="host-actions">
        <button className="create-btn" onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button className="create-btn" onClick={onEdit}>
          Edit
        </button>
        <button className="create-btn cancel" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}

export default function ManageHostsDialog() {
  const dialogOpen = useHostsStore((s) => s.dialogOpen)
  const hosts = useHostsStore((s) => s.hosts)
  const editingHostId = useHostsStore((s) => s.editingHostId)
  const addingNew = useHostsStore((s) => s.addingNew)
  const testing = useHostsStore((s) => s.testing)
  const testResults = useHostsStore((s) => s.testResults)
  const error = useHostsStore((s) => s.error)
  const closeDialog = useHostsStore((s) => s.closeDialog)
  const startEdit = useHostsStore((s) => s.startEdit)
  const startAdd = useHostsStore((s) => s.startAdd)
  const cancelEdit = useHostsStore((s) => s.cancelEdit)
  const addHost = useHostsStore((s) => s.addHost)
  const updateHost = useHostsStore((s) => s.updateHost)
  const deleteHost = useHostsStore((s) => s.deleteHost)
  const testHost = useHostsStore((s) => s.testHost)

  useEffect(() => {
    if (!dialogOpen) return
    // App.tsx's global Escape handler respects useHostsStore.dialogOpen and
    // returns early while this modal is open, so a plain bubble-phase listener
    // is enough.
    //
    // We guard on the DOM event target rather than store state: the form's
    // React onKeyDown handler fires before this native listener and calls
    // cancelEdit synchronously, so by the time we'd check store state it
    // would already be cleared. `target.closest('.hosts-form')` is stable
    // across that race — if Escape originated inside a form, the form owns
    // it; otherwise we close the dialog.
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && target.closest('.hosts-form')) return
      closeDialog()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dialogOpen, closeDialog])

  if (!dialogOpen) return null

  const editingHost = editingHostId ? hosts.find((h) => h.hostId === editingHostId) : undefined

  const handleDelete = async (hostId: HostId) => {
    await deleteHost(hostId)
  }

  return (
    <div
      className="hosts-dialog-overlay"
      onClick={closeDialog}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="hosts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="hosts-dialog-header">
          <div className="session-name-label">Manage hosts</div>
          <button className="create-btn cancel" onClick={closeDialog}>
            Close
          </button>
        </div>

        {error && <div className="hosts-error">{error}</div>}

        <div className="hosts-list">
          {hosts.length === 0 && !addingNew && (
            <div className="hosts-empty">No hosts yet. Add one to get started.</div>
          )}
          {hosts.map((host) =>
            editingHostId === host.hostId ? (
              <HostForm
                key={host.hostId}
                initialAlias={host.alias}
                initialLabel={host.label}
                submitLabel="Save"
                onSubmit={(alias, label) => updateHost(host.hostId, alias, label)}
                onCancel={cancelEdit}
              />
            ) : (
              <HostRow
                key={host.hostId}
                host={host}
                testing={Boolean(testing[host.hostId])}
                result={testResults[host.hostId]}
                onTest={() => void testHost(host.hostId)}
                onEdit={() => startEdit(host.hostId)}
                onDelete={() => void handleDelete(host.hostId)}
              />
            )
          )}
        </div>

        {addingNew ? (
          <HostForm
            submitLabel="Add"
            onSubmit={(alias, label) => addHost(alias, label)}
            onCancel={cancelEdit}
          />
        ) : (
          !editingHost && (
            <div className="hosts-dialog-footer">
              <button className="create-btn" onClick={startAdd}>
                + Add host
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
