import { create } from 'zustand'
import type { Session } from '../../shared/types'

interface SessionsState {
  sessions: Session[]
}

export const useSessionsStore = create<SessionsState>(() => ({
  sessions: [],
}))
