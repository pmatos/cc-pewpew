import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useReviewStore, getReviewProgress } from './review'
import type { HunkAnnotation, DiffFile } from '../../shared/types'

const store = useReviewStore

function makeAnnotation(
  id: string,
  decision: HunkAnnotation['decision'],
  comment?: string
): HunkAnnotation {
  return { id, decision, comment }
}

function makeFile(path: string, hunkCount: number): DiffFile {
  return {
    path,
    oldPath: null,
    hunks: Array.from({ length: hunkCount }, (_, i) => ({
      header: `@@ -${i},1 +${i},1 @@`,
      oldStart: i,
      oldCount: 1,
      newStart: i,
      newCount: 1,
      lines: [],
    })),
    status: 'modified',
  }
}

beforeEach(() => {
  store.setState({ sessions: {} })
})

describe('addAnnotation', () => {
  it('adds annotation to empty session, creates session state', () => {
    const ann = makeAnnotation('a1', 'approved')
    store.getState().addAnnotation('s1', 'file.ts::0', ann)

    const session = store.getState().sessions['s1']
    expect(session).toBeDefined()
    expect(session.annotations['file.ts::0']).toEqual([ann])
  })

  it('adds multiple annotations to same hunk', () => {
    const ann1 = makeAnnotation('a1', 'approved')
    const ann2 = makeAnnotation('a2', 'commented', 'needs work')
    store.getState().addAnnotation('s1', 'file.ts::0', ann1)
    store.getState().addAnnotation('s1', 'file.ts::0', ann2)

    const anns = store.getState().sessions['s1'].annotations['file.ts::0']
    expect(anns).toHaveLength(2)
    expect(anns).toEqual([ann1, ann2])
  })

  it('adds annotations to different hunks', () => {
    const ann1 = makeAnnotation('a1', 'approved')
    const ann2 = makeAnnotation('a2', 'rejected')
    store.getState().addAnnotation('s1', 'file.ts::0', ann1)
    store.getState().addAnnotation('s1', 'file.ts::1', ann2)

    const { annotations } = store.getState().sessions['s1']
    expect(annotations['file.ts::0']).toEqual([ann1])
    expect(annotations['file.ts::1']).toEqual([ann2])
  })
})

describe('removeAnnotation', () => {
  it('removes specific annotation by ID', () => {
    const ann1 = makeAnnotation('a1', 'approved')
    const ann2 = makeAnnotation('a2', 'commented')
    store.getState().addAnnotation('s1', 'f::0', ann1)
    store.getState().addAnnotation('s1', 'f::0', ann2)

    store.getState().removeAnnotation('s1', 'f::0', 'a1')

    expect(store.getState().sessions['s1'].annotations['f::0']).toEqual([ann2])
  })

  it('removes hunk key when last annotation removed', () => {
    const ann = makeAnnotation('a1', 'approved')
    store.getState().addAnnotation('s1', 'f::0', ann)

    store.getState().removeAnnotation('s1', 'f::0', 'a1')

    expect(store.getState().sessions['s1'].annotations['f::0']).toBeUndefined()
  })
})

describe('clearAnnotations', () => {
  it('clears all annotations for a session', () => {
    store.getState().addAnnotation('s1', 'f::0', makeAnnotation('a1', 'approved'))
    store.getState().addAnnotation('s1', 'f::1', makeAnnotation('a2', 'rejected'))

    store.getState().clearAnnotations('s1')

    expect(store.getState().sessions['s1'].annotations).toEqual({})
  })
})

describe('setFocusedHunk', () => {
  it('sets and clears focused hunk key', () => {
    store.getState().setFocusedHunk('s1', 'file.ts::2')
    expect(store.getState().sessions['s1'].focusedHunkKey).toBe('file.ts::2')

    store.getState().setFocusedHunk('s1', null)
    expect(store.getState().sessions['s1'].focusedHunkKey).toBeNull()
  })
})

describe('getReviewProgress', () => {
  it('returns correct counts for mixed decisions', () => {
    store.setState({
      sessions: {
        s1: {
          files: [makeFile('a.ts', 3)],
          loading: false,
          error: null,
          annotations: {
            'a.ts::0': [makeAnnotation('a1', 'approved')],
            'a.ts::1': [makeAnnotation('a2', 'commented')],
            'a.ts::2': [makeAnnotation('a3', 'rejected')],
          },
          focusedHunkKey: null,
          cachedMode: null,
          diffUpdated: false,
          remoteUnsupported: false,
        },
      },
    })

    const progress = getReviewProgress(store.getState().sessions['s1'])
    expect(progress).toEqual({ total: 3, reviewed: 3, approved: 1, commented: 1, rejected: 1 })
  })

  it('severity hierarchy: rejected > commented > approved', () => {
    store.setState({
      sessions: {
        s1: {
          files: [makeFile('a.ts', 1)],
          loading: false,
          error: null,
          annotations: {
            'a.ts::0': [
              makeAnnotation('a1', 'approved'),
              makeAnnotation('a2', 'commented'),
              makeAnnotation('a3', 'rejected'),
            ],
          },
          focusedHunkKey: null,
          cachedMode: null,
          diffUpdated: false,
          remoteUnsupported: false,
        },
      },
    })

    const progress = getReviewProgress(store.getState().sessions['s1'])
    expect(progress.rejected).toBe(1)
    expect(progress.commented).toBe(0)
    expect(progress.approved).toBe(0)
    expect(progress.reviewed).toBe(1)
  })

  it('empty annotations = 0 reviewed', () => {
    store.setState({
      sessions: {
        s1: {
          files: [makeFile('a.ts', 3)],
          loading: false,
          error: null,
          annotations: {},
          focusedHunkKey: null,
          cachedMode: null,
          diffUpdated: false,
          remoteUnsupported: false,
        },
      },
    })

    const progress = getReviewProgress(store.getState().sessions['s1'])
    expect(progress).toEqual({ total: 3, reviewed: 0, approved: 0, commented: 0, rejected: 0 })
  })
})

describe('multiple sessions isolation', () => {
  it('annotations in one session do not affect another', () => {
    store.getState().addAnnotation('s1', 'f::0', makeAnnotation('a1', 'approved'))
    store.getState().addAnnotation('s2', 'f::0', makeAnnotation('a2', 'rejected'))

    const s1 = store.getState().sessions['s1']
    const s2 = store.getState().sessions['s2']

    expect(s1.annotations['f::0']).toEqual([makeAnnotation('a1', 'approved')])
    expect(s2.annotations['f::0']).toEqual([makeAnnotation('a2', 'rejected')])
  })
})

describe('fetchDiff envelope handling', () => {
  const getReviewDiff = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('window', { api: { getReviewDiff } })
    getReviewDiff.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks session remoteUnsupported when handler returns the gated envelope', async () => {
    getReviewDiff.mockResolvedValueOnce({ ok: false, reason: 'remote-unsupported' })

    await store.getState().fetchDiff('s1', 'uncommitted')

    const session = store.getState().sessions['s1']
    expect(session).toBeDefined()
    expect(session.remoteUnsupported).toBe(true)
    expect(session.files).toEqual([])
    expect(session.loading).toBe(false)
    expect(session.error).toBeNull()
  })

  it('populates files from a successful envelope and leaves remoteUnsupported false', async () => {
    const file = makeFile('a.ts', 1)
    getReviewDiff.mockResolvedValueOnce({ ok: true, files: [file] })

    await store.getState().fetchDiff('s1', 'uncommitted')

    const session = store.getState().sessions['s1']
    expect(session.files).toEqual([file])
    expect(session.remoteUnsupported).toBe(false)
    expect(session.loading).toBe(false)
    expect(session.cachedMode).toBe('uncommitted')
  })
})
