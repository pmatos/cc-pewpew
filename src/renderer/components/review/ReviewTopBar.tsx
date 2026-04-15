import type { DiffMode } from '../../../shared/types'

interface Props {
  repoName: string
  branch: string
  fileCount: number
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  branches: string[]
  selectedBranch: string
  onBranchChange: (branch: string) => void
}

const MODES: { value: DiffMode; label: string }[] = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'unpushed', label: 'Unpushed' },
  { value: 'branch', label: 'Branch' },
]

export default function ReviewTopBar({
  repoName,
  branch,
  fileCount,
  mode,
  onModeChange,
  branches,
  selectedBranch,
  onBranchChange,
}: Props) {
  return (
    <div className="rv-top-bar">
      <span className="rv-top-bar-label">Review</span>
      <span className="rv-top-bar-sep">&mdash;</span>
      <span className="rv-top-bar-repo">{repoName}</span>
      <span className="rv-top-bar-branch">{branch}</span>
      <div className="rv-mode-control">
        {MODES.map((m) => (
          <button
            key={m.value}
            className={`rv-mode-btn${mode === m.value ? ' rv-mode-btn--active' : ''}`}
            onClick={() => onModeChange(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'branch' && branches.length > 0 && (
        <select
          className="rv-branch-dropdown"
          value={selectedBranch}
          onChange={(e) => onBranchChange(e.target.value)}
        >
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      )}
      <span className="rv-top-bar-files">
        {fileCount} file{fileCount !== 1 ? 's' : ''}
      </span>
    </div>
  )
}
