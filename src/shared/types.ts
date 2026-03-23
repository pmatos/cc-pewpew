export type SessionStatus = 'running' | 'needs_input' | 'idle' | 'completed' | 'error' | 'dead'

export interface Project {
  name: string
  path: string
  branches: string[]
  worktrees: Worktree[]
  setupState: 'unsetup' | 'ready'
}

export interface Worktree {
  name: string
  path: string
  branch: string
}

export interface Session {
  id: string
  projectPath: string
  projectName: string
  worktreeName: string
  worktreePath: string
  pid: number
  ghosttyClass: string
  status: SessionStatus
  lastActivity: number
  hookEvents: HookEvent[]
}

export interface HookEvent {
  method: string
  sessionId: string
  timestamp: number
  data: Record<string, unknown>
}
