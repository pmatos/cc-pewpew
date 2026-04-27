import { create } from 'zustand'
import type { DiffFile, DiffMode, HunkAnnotation } from '../../shared/types'

interface SessionReviewState {
  files: DiffFile[]
  loading: boolean
  error: string | null
  annotations: Record<string, HunkAnnotation[]>
  focusedHunkKey: string | null
  cachedMode: DiffMode | null
  diffUpdated: boolean
  remoteUnsupported: boolean
}

export function getReviewProgress(state: SessionReviewState): {
  total: number
  reviewed: number
  approved: number
  commented: number
  rejected: number
} {
  let total = 0
  for (const file of state.files) {
    total += file.hunks.length
  }
  let approved = 0
  let commented = 0
  let rejected = 0
  for (const file of state.files) {
    for (let i = 0; i < file.hunks.length; i++) {
      const key = `${file.path}::${i}`
      const anns = state.annotations[key]
      if (anns && anns.length > 0) {
        const hasRejected = anns.some((a) => a.decision === 'rejected')
        const hasCommented = anns.some((a) => a.decision === 'commented')
        if (hasRejected) rejected++
        else if (hasCommented) commented++
        else approved++
      }
    }
  }
  return { total, reviewed: approved + commented + rejected, approved, commented, rejected }
}

interface ReviewStore {
  sessions: Record<string, SessionReviewState>
  fetchDiff: (sessionId: string, mode: DiffMode, baseBranch?: string) => Promise<void>
  clearDiff: (sessionId: string) => void
  addAnnotation: (sessionId: string, hunkKey: string, annotation: HunkAnnotation) => void
  removeAnnotation: (sessionId: string, hunkKey: string, annotationId: string) => void
  clearAnnotations: (sessionId: string) => void
  setFocusedHunk: (sessionId: string, key: string | null) => void
}

function emptySession(): SessionReviewState {
  return {
    files: [],
    loading: false,
    error: null,
    annotations: {},
    focusedHunkKey: null,
    cachedMode: null,
    diffUpdated: false,
    remoteUnsupported: false,
  }
}

function getSession(
  state: Record<string, SessionReviewState>,
  sessionId: string
): SessionReviewState {
  return state[sessionId] ?? emptySession()
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  sessions: {},
  fetchDiff: async (sessionId, mode, baseBranch) => {
    const existing = useReviewStore.getState().sessions[sessionId]
    const hasCachedData = existing && existing.cachedMode === mode && existing.files.length > 0

    if (!hasCachedData) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...emptySession(),
            ...state.sessions[sessionId],
            loading: true,
            error: null,
          },
        },
      }))
    }

    try {
      const result = await window.api.getReviewDiff(sessionId, mode, baseBranch)

      if (!result.ok && result.reason === 'remote-unsupported') {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: { ...emptySession(), remoteUnsupported: true },
          },
        }))
        return
      }

      const files = result.files ?? []

      // Guard against stale async responses: if mode changed while awaiting, discard
      const currentSession = get().sessions[sessionId]
      if (
        currentSession &&
        currentSession.cachedMode !== null &&
        currentSession.cachedMode !== mode
      ) {
        return
      }

      if (hasCachedData) {
        const oldFiles = existing.files
        const unchanged =
          oldFiles.length === files.length &&
          oldFiles.every(
            (f, i) =>
              f.path === files[i].path &&
              f.hunks.length === files[i].hunks.length &&
              f.hunks.every(
                (h, j) =>
                  h.lines.length === files[i].hunks[j].lines.length &&
                  h.header === files[i].hunks[j].header &&
                  h.lines.every((l, k) => l.content === files[i].hunks[j].lines[k].content)
              )
          )
        if (unchanged) {
          // Clear any stale error even when diff hasn't changed
          set((state) => {
            const session = state.sessions[sessionId]
            if (!session || !session.error) return state
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: { ...session, error: null },
              },
            }
          })
          return
        }

        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...getSession(state.sessions, sessionId),
              files,
              annotations: {},
              cachedMode: mode,
              diffUpdated: true,
            },
          },
        }))
        setTimeout(() => {
          set((state) => {
            const session = state.sessions[sessionId]
            if (!session) return state
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: { ...session, diffUpdated: false },
              },
            }
          })
        }, 3000)
      } else {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...getSession(state.sessions, sessionId),
              files,
              loading: false,
              cachedMode: mode,
            },
          },
        }))
      }
    } catch (err) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...getSession(state.sessions, sessionId),
            files: hasCachedData ? getSession(state.sessions, sessionId).files : [],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      }))
    }
  },
  clearDiff: (sessionId) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.sessions
      void _removed
      return { sessions: rest }
    })
  },
  addAnnotation: (sessionId, hunkKey, annotation) => {
    set((state) => {
      const session = getSession(state.sessions, sessionId)
      const existing = session.annotations[hunkKey] ?? []
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            annotations: { ...session.annotations, [hunkKey]: [...existing, annotation] },
          },
        },
      }
    })
  },
  removeAnnotation: (sessionId, hunkKey, annotationId) => {
    set((state) => {
      const session = getSession(state.sessions, sessionId)
      const list = session.annotations[hunkKey]
      if (!list) return state
      const filtered = list.filter((a) => a.id !== annotationId)
      const newAnnotations = { ...session.annotations }
      if (filtered.length === 0) {
        delete newAnnotations[hunkKey]
      } else {
        newAnnotations[hunkKey] = filtered
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, annotations: newAnnotations },
        },
      }
    })
  },
  clearAnnotations: (sessionId) => {
    set((state) => {
      const session = getSession(state.sessions, sessionId)
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, annotations: {} },
        },
      }
    })
  },
  setFocusedHunk: (sessionId, key) => {
    set((state) => {
      const session = getSession(state.sessions, sessionId)
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, focusedHunkKey: key },
        },
      }
    })
  },
}))
