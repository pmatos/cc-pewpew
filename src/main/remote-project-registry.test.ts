import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Host, RemoteProject } from '../shared/types'

let fakeHosts: Host[] = []
let fakeRemoteProjects: RemoteProject[] = []
const saveConfigSpy = vi.fn()

vi.mock('./config', () => ({
  CONFIG_DIR: '/tmp/pewpew-test',
  getConfig: () => ({
    scanDirs: [],
    pinnedPaths: [],
    followSymlinks: true,
    canvas: { zoom: 1, panX: 0, panY: 0 },
    clusterPositions: {},
    sidebarWidth: 250,
    uiScale: 1,
    hosts: fakeHosts,
    remoteProjects: fakeRemoteProjects,
  }),
  saveConfig: (cfg: { hosts: Host[]; remoteProjects: RemoteProject[] }) => {
    fakeHosts = cfg.hosts
    fakeRemoteProjects = cfg.remoteProjects
    saveConfigSpy(cfg)
  },
}))

vi.mock('./host-registry', () => ({
  getHost: (hostId: string) => fakeHosts.find((h) => h.hostId === hostId),
}))

import {
  validateRemotePath,
  listRemoteProjects,
  addRemoteProject,
  removeRemoteProject,
  removeRemoteProjectsForHost,
  hasRemoteProjectsBoundTo,
  toProject,
} from './remote-project-registry'

function seedHost(hostId = 'h1', alias = 'dev', label = 'Dev'): Host {
  const host: Host = { hostId, alias, label }
  fakeHosts = [...fakeHosts, host]
  return host
}

beforeEach(() => {
  fakeHosts = []
  fakeRemoteProjects = []
  saveConfigSpy.mockClear()
})

describe('validateRemotePath', () => {
  it('rejects empty and whitespace-only', () => {
    expect(() => validateRemotePath('')).toThrow(/required/)
    expect(() => validateRemotePath('   ')).toThrow(/required/)
  })

  it('requires absolute path', () => {
    expect(() => validateRemotePath('relative/path')).toThrow(/absolute/)
  })

  it('rejects leading dash (argv-injection guard)', () => {
    expect(() => validateRemotePath('-oProxyCommand=foo')).toThrow(/start with/)
  })

  it('rejects NUL', () => {
    expect(() => validateRemotePath('/foo\x00bar')).toThrow(/NUL/)
  })

  it('trims whitespace', () => {
    expect(validateRemotePath('  /repo  ')).toBe('/repo')
  })

  it('strips a trailing slash but preserves the root "/"', () => {
    expect(validateRemotePath('/srv/repo/')).toBe('/srv/repo')
    expect(validateRemotePath('/')).toBe('/')
  })

  it('collapses duplicate slashes and resolves "." / ".."', () => {
    expect(validateRemotePath('/srv//repo')).toBe('/srv/repo')
    expect(validateRemotePath('/srv/./repo')).toBe('/srv/repo')
    expect(validateRemotePath('/srv/a/../repo')).toBe('/srv/repo')
  })
})

describe('addRemoteProject', () => {
  it('persists a new remote project with derived name', () => {
    const host = seedHost()
    const project = addRemoteProject({ hostId: host.hostId, path: '/srv/repo' })
    expect(project).toEqual({ hostId: host.hostId, path: '/srv/repo', name: 'repo' })
    expect(listRemoteProjects()).toHaveLength(1)
    expect(saveConfigSpy).toHaveBeenCalledOnce()
  })

  it('uses provided name when given', () => {
    const host = seedHost()
    const project = addRemoteProject({ hostId: host.hostId, path: '/srv/repo', name: 'My Repo' })
    expect(project.name).toBe('My Repo')
  })

  it('stores repoFingerprint when provided', () => {
    const host = seedHost()
    const project = addRemoteProject({
      hostId: host.hostId,
      path: '/srv/repo',
      repoFingerprint: 'abc123',
    })
    expect(project.repoFingerprint).toBe('abc123')
  })

  it('rejects unknown hostId', () => {
    expect(() => addRemoteProject({ hostId: 'nope', path: '/srv/repo' })).toThrow(/Unknown host/)
  })

  it('rejects duplicate (hostId, path)', () => {
    const host = seedHost()
    addRemoteProject({ hostId: host.hostId, path: '/srv/repo' })
    expect(() => addRemoteProject({ hostId: host.hostId, path: '/srv/repo' })).toThrow(
      /already registered/
    )
  })

  it('rejects duplicates that differ only by trailing slash or "." segments', () => {
    const host = seedHost()
    addRemoteProject({ hostId: host.hostId, path: '/srv/repo' })
    expect(() => addRemoteProject({ hostId: host.hostId, path: '/srv/repo/' })).toThrow(
      /already registered/
    )
    expect(() => addRemoteProject({ hostId: host.hostId, path: '/srv/./repo' })).toThrow(
      /already registered/
    )
    expect(() => addRemoteProject({ hostId: host.hostId, path: '/srv/a/../repo' })).toThrow(
      /already registered/
    )
  })

  it('allows the same path on a different host', () => {
    const h1 = seedHost('h1', 'a', 'A')
    const h2 = seedHost('h2', 'b', 'B')
    addRemoteProject({ hostId: h1.hostId, path: '/srv/repo' })
    expect(() => addRemoteProject({ hostId: h2.hostId, path: '/srv/repo' })).not.toThrow()
  })

  it('rejects non-absolute path before checking host', () => {
    expect(() => addRemoteProject({ hostId: 'nope', path: 'relative' })).toThrow(/absolute/)
  })
})

describe('removeRemoteProject', () => {
  it('removes the matching entry', () => {
    const host = seedHost()
    addRemoteProject({ hostId: host.hostId, path: '/a' })
    addRemoteProject({ hostId: host.hostId, path: '/b' })
    removeRemoteProject(host.hostId, '/a')
    expect(listRemoteProjects().map((p) => p.path)).toEqual(['/b'])
  })

  it('is idempotent on missing entry', () => {
    const host = seedHost()
    expect(() => removeRemoteProject(host.hostId, '/nope')).not.toThrow()
    expect(saveConfigSpy).not.toHaveBeenCalled()
  })
})

describe('removeRemoteProjectsForHost', () => {
  it('removes every project for the given host while preserving others', () => {
    const a = seedHost('a', 'a', 'A')
    const b = seedHost('b', 'b', 'B')
    addRemoteProject({ hostId: a.hostId, path: '/x' })
    addRemoteProject({ hostId: a.hostId, path: '/y' })
    addRemoteProject({ hostId: b.hostId, path: '/z' })
    removeRemoteProjectsForHost(a.hostId)
    expect(listRemoteProjects()).toEqual([{ hostId: 'b', path: '/z', name: 'z' }])
  })

  it('is a no-op when no projects match (does not call saveConfig)', () => {
    seedHost('a')
    saveConfigSpy.mockClear()
    removeRemoteProjectsForHost('a')
    expect(saveConfigSpy).not.toHaveBeenCalled()
  })
})

describe('hasRemoteProjectsBoundTo', () => {
  it('returns false when no projects reference the host', () => {
    seedHost('h1')
    expect(hasRemoteProjectsBoundTo('h1')).toBe(false)
  })

  it('returns true when at least one project references the host', () => {
    const host = seedHost('h1')
    addRemoteProject({ hostId: host.hostId, path: '/x' })
    expect(hasRemoteProjectsBoundTo('h1')).toBe(true)
    expect(hasRemoteProjectsBoundTo('h2')).toBe(false)
  })
})

describe('toProject', () => {
  it('maps RemoteProject to a Project with empty worktrees/branches and ready setup', () => {
    const p = toProject({ hostId: 'h1', path: '/x', name: 'x' })
    expect(p).toEqual({
      name: 'x',
      path: '/x',
      branches: [],
      worktrees: [],
      setupState: 'ready',
      hostId: 'h1',
    })
  })
})
