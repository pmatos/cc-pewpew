import type { Session } from '../shared/types'

export type SessionsState = ReadonlyMap<string, Session>

export interface HookEventInput {
  method: string
  params: Record<string, unknown>
  originHostId: string | null
}

export type SideEffectIntent =
  | { kind: 'notifyNeedsInput'; sessionId: string }
  | { kind: 'promptCleanup'; sessionId: string }

export interface ApplyResult {
  state: SessionsState
  intents: SideEffectIntent[]
  matched: boolean
}

function findSession(state: SessionsState, event: HookEventInput): Session | undefined {
  const cwd = event.params.cwd as string | undefined
  const ccSessionId = (event.params.session_id ?? event.params.sessionId) as string | undefined
  for (const s of state.values()) {
    if ((s.hostId ?? null) !== event.originHostId) continue
    if (cwd && s.worktreePath && cwd.startsWith(s.worktreePath)) return s
    if (ccSessionId && s.id === ccSessionId) return s
  }
  return undefined
}

export function applyHookEvent(
  state: SessionsState,
  event: HookEventInput,
  now: number
): ApplyResult {
  const target = findSession(state, event)
  if (!target) return { state, intents: [], matched: false }

  const intents: SideEffectIntent[] = []
  const next: Session = { ...target }

  switch (event.method) {
    case 'session.start': {
      next.status = 'running'
      next.lastActivity = now
      if (event.originHostId) next.connectionState = 'live'
      const incoming = (event.params.session_id ?? event.params.sessionId) as string | undefined
      if (next.tool === 'codex' && incoming && !next.agentSessionId) {
        next.agentSessionId = incoming
      }
      break
    }
    case 'session.stop':
      next.status = 'needs_input'
      next.lastActivity = now
      if (event.originHostId) next.connectionState = 'live'
      intents.push({ kind: 'notifyNeedsInput', sessionId: target.id })
      break
    case 'session.activity':
      next.status = 'running'
      next.lastActivity = now
      if (event.originHostId) next.connectionState = 'live'
      break
    case 'session.end': {
      // Claude Code fires SessionEnd for several reasons, not all of which mean
      // the user is done with the worktree. /clear, --continue/--resume, and
      // bypass_permissions_disabled all fire SessionEnd while the session
      // remains alive — treating them as "user wants cleanup" produces a
      // disruptive false-positive dialog. Only fire on reasons that genuinely
      // mean the agent process is gone.
      // https://code.claude.com/docs/en/hooks (SessionEnd matcher values).
      const reason = typeof event.params.reason === 'string' ? event.params.reason : undefined
      // JSON.stringify escapes control characters and the slice caps length so a
      // misbehaving (or hostile) hook payload cannot forge log lines or flood
      // the console with megabytes of attacker-chosen text. CodeQL flagged the
      // raw interpolation as log-injection — this is the minimal sanitisation
      // that keeps the diagnostic value of seeing the actual reason string.
      const safeReason = reason === undefined ? '<absent>' : JSON.stringify(reason).slice(0, 64)
      console.info(`[session.end] sessionId=${target.id} reason=${safeReason}`)
      const triggersCleanup = reason === 'prompt_input_exit' || reason === 'logout'
      if (!triggersCleanup) {
        return { state, intents: [], matched: true }
      }
      return {
        state,
        intents: [{ kind: 'promptCleanup', sessionId: target.id }],
        matched: true,
      }
    }
    case 'session.notification': {
      const incoming = (event.params.session_id ?? event.params.sessionId) as string | undefined
      next.hookEvents = [
        ...next.hookEvents,
        {
          method: event.method,
          sessionId: incoming || target.id,
          timestamp: now,
          originHostId: event.originHostId,
          data: event.params,
        },
      ]
      next.lastActivity = now
      break
    }
    default:
      return { state, intents: [], matched: false }
  }

  const nextState = new Map(state)
  nextState.set(target.id, next)
  return { state: nextState, intents, matched: true }
}
