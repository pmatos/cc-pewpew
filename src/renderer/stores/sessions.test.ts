import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionsStore } from './sessions'
import type { Session } from '../../shared/types'

const store = useSessionsStore

function makeSession(id: string): Session {
  return {
    id,
    projectPath: '/p',
    projectName: 'p',
    worktreeName: 'w',
    worktreePath: '/p/w',
    branch: 'main',
    pid: 0,
    tmuxSession: `cc-pewpew-${id}`,
    status: 'idle',
    lastActivity: 0,
    hookEvents: [],
    hostId: null,
  }
}

beforeEach(() => {
  store.setState({
    sessions: [],
    thumbnails: {},
    selectedIds: new Set<string>(),
    lastSelectedId: null,
    broadcastDialogOpen: false,
  })
})

describe('applyThumbnailPatch', () => {
  it('merges incoming entries with existing thumbnails instead of replacing them', () => {
    store.setState({ thumbnails: { s1: 'one\n', s2: 'two\n' } })

    store.getState().applyThumbnailPatch({ s1: 'one-updated\n' })

    expect(store.getState().thumbnails).toEqual({
      s1: 'one-updated\n',
      s2: 'two\n',
    })
  })
})

describe('syncSessions', () => {
  it('drops thumbnails for sessions that no longer exist', () => {
    store.setState({
      sessions: [makeSession('s1'), makeSession('s2')],
      thumbnails: { s1: 'one\n', s2: 'two\n' },
    })

    store.getState().syncSessions([makeSession('s1')])

    expect(store.getState().thumbnails).toEqual({ s1: 'one\n' })
  })

  it('preserves thumbnails for sessions still present', () => {
    store.setState({
      sessions: [makeSession('s1')],
      thumbnails: { s1: 'one\n' },
    })

    store.getState().syncSessions([makeSession('s1'), makeSession('s2')])

    expect(store.getState().thumbnails).toEqual({ s1: 'one\n' })
  })
})
