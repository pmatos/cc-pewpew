export type SessionStatus = 'running' | 'needs_input' | 'idle' | 'completed' | 'error' | 'dead'
export type ConnectionState = 'connecting' | 'live' | 'offline' | 'auth-failed' | 'unreachable'

export interface Project {
  name: string
  path: string
  branches: string[]
  worktrees: Worktree[]
  setupState: 'unsetup' | 'ready'
  hostId: string | null
}

export interface Worktree {
  name: string
  path: string
  branch: string
  isMain: boolean
}

export interface Session {
  id: string
  hostId: string | null
  projectPath: string
  projectName: string
  worktreeName: string
  worktreePath: string
  branch: string
  prNumber?: number
  issueNumber?: number
  pid: number
  tmuxSession: string
  status: SessionStatus
  connectionState?: ConnectionState
  lastActivity: number
  hookEvents: HookEvent[]
  repoFingerprint?: string
}

export interface HookEvent {
  method: string
  sessionId: string
  timestamp: number
  originHostId?: string | null
  data: Record<string, unknown>
}

// --- Review / Diff types ---

export type LineType = 'addition' | 'deletion' | 'context'
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface DiffLine {
  content: string
  lineType: LineType
  oldLineNo: number | null
  newLineNo: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath: string | null
  hunks: DiffHunk[]
  status: FileStatus
}

export type DiffMode = 'uncommitted' | 'unpushed' | 'branch'

export type ReviewDecision = 'approved' | 'commented' | 'rejected'
export type RejectMode = 'propose_alternative' | 'request_possibilities'

export interface HunkAnnotation {
  id: string
  decision: ReviewDecision
  comment?: string
  rejectMode?: RejectMode
  selectedText?: string
  selectedLines?: { start: number; end: number }
}

// --- Host registry / SSH types ---

export type HostId = string

export interface Host {
  hostId: HostId
  alias: string
  label: string
}

export type SshExitReason = 'auth-failed' | 'network' | 'dep-missing' | 'unknown'

export interface TestConnectionResult {
  ok: boolean
  reason?: SshExitReason
  message?: string
}

export interface RemoteProject {
  hostId: HostId
  path: string
  name: string
  repoFingerprint?: string
}

export type ValidateRemoteRepoReason =
  | 'not-a-git-repo'
  | 'auth-failed'
  | 'network'
  | 'dep-missing'
  | 'unknown'

export interface ValidateRemoteRepoResult {
  ok: boolean
  fingerprint?: string
  reason?: ValidateRemoteRepoReason
  message?: string
}
