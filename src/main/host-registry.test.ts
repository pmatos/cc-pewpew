import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Host } from '../shared/types'

let fakeHosts: Host[] = []
const saveConfigSpy = vi.fn()

vi.mock('./config', () => ({
  CONFIG_DIR: '/tmp/cc-pewpew-test',
  getConfig: () => ({
    scanDirs: [],
    pinnedPaths: [],
    followSymlinks: true,
    canvas: { zoom: 1, panX: 0, panY: 0 },
    clusterPositions: {},
    sidebarWidth: 250,
    uiScale: 1,
    hosts: fakeHosts,
  }),
  saveConfig: (cfg: { hosts: Host[] }) => {
    fakeHosts = cfg.hosts
    saveConfigSpy(cfg)
  },
}))

const fsState = { sessionsJson: null as string | null }

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) =>
      p.endsWith('sessions.json') ? fsState.sessionsJson !== null : actual.existsSync(p),
    readFileSync: (p: string, enc?: BufferEncoding) =>
      p.endsWith('sessions.json') && fsState.sessionsJson !== null
        ? fsState.sessionsJson
        : actual.readFileSync(p, enc),
  }
})

import {
  validateAlias,
  validateLabel,
  addHost,
  updateHost,
  deleteHost,
  listHosts,
  getHost,
} from './host-registry'

beforeEach(() => {
  fakeHosts = []
  fsState.sessionsJson = null
  saveConfigSpy.mockClear()
})

describe('validateAlias', () => {
  it('rejects empty and whitespace-only', () => {
    expect(() => validateAlias('')).toThrow(/required/)
    expect(() => validateAlias('   ')).toThrow(/required/)
  })

  it('rejects leading dash (argv-injection guard)', () => {
    expect(() => validateAlias('-oProxyCommand=foo')).toThrow(/start with/)
  })

  it('trims leading/trailing whitespace', () => {
    expect(validateAlias('  dev  ')).toBe('dev')
  })

  it('rejects embedded whitespace', () => {
    expect(() => validateAlias('dev box')).toThrow(/whitespace/)
    expect(() => validateAlias('dev\tbox')).toThrow(/whitespace/)
    expect(() => validateAlias('dev\nbox')).toThrow(/whitespace/)
  })

  it('rejects NUL byte', () => {
    expect(() => validateAlias('dev\x00box')).toThrow(/NUL/)
  })

  it('rejects aliases longer than 64 chars', () => {
    expect(() => validateAlias('a'.repeat(65))).toThrow(/64/)
    expect(validateAlias('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('validateLabel', () => {
  it('rejects empty', () => {
    expect(() => validateLabel('')).toThrow(/required/)
    expect(() => validateLabel('   ')).toThrow(/required/)
  })

  it('trims and accepts', () => {
    expect(validateLabel('  ok  ')).toBe('ok')
  })

  it('rejects labels longer than 40 chars', () => {
    expect(() => validateLabel('a'.repeat(41))).toThrow(/40/)
    expect(validateLabel('a'.repeat(40))).toBe('a'.repeat(40))
  })
})

describe('addHost', () => {
  it('persists a new host with a UUID', () => {
    const host = addHost({ alias: 'dev', label: 'Dev box' })
    expect(host.alias).toBe('dev')
    expect(host.label).toBe('Dev box')
    expect(host.hostId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(listHosts()).toHaveLength(1)
    expect(saveConfigSpy).toHaveBeenCalledOnce()
  })

  it('rejects duplicate alias (exact match)', () => {
    addHost({ alias: 'dev', label: 'One' })
    expect(() => addHost({ alias: 'dev', label: 'Two' })).toThrow(/already exists/)
  })

  it('accepts case-differing alias (matches OpenSSH case sensitivity)', () => {
    addHost({ alias: 'dev', label: 'lower' })
    expect(() => addHost({ alias: 'Dev', label: 'Upper' })).not.toThrow()
    expect(listHosts()).toHaveLength(2)
  })
})

describe('updateHost', () => {
  it('renames label and alias', () => {
    const h = addHost({ alias: 'dev', label: 'Old' })
    const updated = updateHost(h.hostId, { alias: 'prod', label: 'New' })
    expect(updated.alias).toBe('prod')
    expect(updated.label).toBe('New')
    expect(getHost(h.hostId)?.alias).toBe('prod')
  })

  it('allows keeping the same alias (no-op rename)', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    expect(() => updateHost(h.hostId, { alias: 'dev', label: 'y' })).not.toThrow()
  })

  it('rejects renaming onto another host alias', () => {
    addHost({ alias: 'a', label: 'A' })
    const b = addHost({ alias: 'b', label: 'B' })
    expect(() => updateHost(b.hostId, { alias: 'a', label: 'B' })).toThrow(/already exists/)
  })

  it('throws on unknown hostId', () => {
    expect(() => updateHost('nope', { alias: 'x', label: 'y' })).toThrow(/Unknown/)
  })
})

describe('deleteHost', () => {
  it('deletes when sessions.json is missing', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    deleteHost(h.hostId)
    expect(listHosts()).toHaveLength(0)
  })

  it('deletes when sessions.json is present but has no hostId binding', () => {
    fsState.sessionsJson = JSON.stringify([{ session: { id: 's1', status: 'idle' } }])
    const h = addHost({ alias: 'dev', label: 'x' })
    expect(() => deleteHost(h.hostId)).not.toThrow()
  })

  it('refuses delete when a persisted session is bound to the host', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    fsState.sessionsJson = JSON.stringify([{ session: { id: 's1', hostId: h.hostId } }])
    expect(() => deleteHost(h.hostId)).toThrow(/bound/)
  })

  it('accepts either sessions-array or wrapped-array shape', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    fsState.sessionsJson = JSON.stringify({ sessions: [{ hostId: h.hostId }] })
    expect(() => deleteHost(h.hostId)).toThrow(/bound/)
  })

  it('tolerates malformed sessions.json (treats as no bindings)', () => {
    fsState.sessionsJson = 'not json'
    const h = addHost({ alias: 'dev', label: 'x' })
    expect(() => deleteHost(h.hostId)).not.toThrow()
  })

  it('throws on unknown hostId', () => {
    expect(() => deleteHost('nope')).toThrow(/Unknown/)
  })
})
