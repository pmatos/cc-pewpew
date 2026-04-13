import type { SessionStatus } from '../../shared/types'

export const STATUS_CONFIG: Record<SessionStatus, { className: string; label: string }> = {
  running: { className: 'status-running', label: 'Running' },
  needs_input: { className: 'status-needs-input', label: 'Needs input' },
  completed: { className: 'status-completed', label: 'Completed' },
  idle: { className: 'status-idle', label: 'Idle' },
  dead: { className: 'status-dead', label: 'Dead' },
  error: { className: 'status-dead', label: 'Error' },
}
