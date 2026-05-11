import type { Session } from '../../shared/types'
import { STATUS_CONFIG } from '../utils/status-config'

interface Props {
  session?: Session
  focused?: boolean
}

export default function LaneHeader({ session, focused }: Props) {
  if (!session) {
    return (
      <div className="lane-header">
        <span className="lane-header-name">Loading…</span>
      </div>
    )
  }

  const { className: statusClass } = STATUS_CONFIG[session.status]

  return (
    <div className={`lane-header${focused ? ' lane-header--focused' : ''}`}>
      <span className={`status-dot ${statusClass}`} />
      <span className="lane-header-name">
        {session.projectName}/{session.worktreeName}
      </span>
    </div>
  )
}
