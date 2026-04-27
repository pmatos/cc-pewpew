import { describe, it, expect, beforeEach } from 'vitest'
import { recordSshInvocation, getSshLog, clearSshLog, _resetSshLogForTests } from './ssh-log-buffer'
import type { SshLogEntry } from '../shared/types'

function makeEntry(overrides: Partial<SshLogEntry> = {}): SshLogEntry {
  return {
    ts: Date.now(),
    hostId: 'host-a',
    kind: 'exec',
    argv: ['ssh', 'alias', 'true'],
    exitCode: 0,
    stderrSnippet: '',
    ...overrides,
  }
}

describe('ssh-log-buffer', () => {
  beforeEach(() => {
    _resetSshLogForTests()
  })

  it('records entries in chronological order', () => {
    recordSshInvocation(makeEntry({ ts: 1, kind: 'control' }))
    recordSshInvocation(makeEntry({ ts: 2, kind: 'exec' }))
    recordSshInvocation(makeEntry({ ts: 3, kind: 'attach' }))
    const log = getSshLog('host-a')
    expect(log.map((e) => e.kind)).toEqual(['control', 'exec', 'attach'])
  })

  it('caps the per-host buffer at 200 entries, retaining the latest', () => {
    for (let i = 0; i < 250; i++) {
      recordSshInvocation(makeEntry({ ts: i, exitCode: i }))
    }
    const log = getSshLog('host-a')
    expect(log).toHaveLength(200)
    expect(log[0].exitCode).toBe(50)
    expect(log[199].exitCode).toBe(249)
  })

  it('isolates entries per hostId', () => {
    recordSshInvocation(makeEntry({ hostId: 'host-a', kind: 'exec' }))
    recordSshInvocation(makeEntry({ hostId: 'host-b', kind: 'control' }))
    expect(getSshLog('host-a').map((e) => e.kind)).toEqual(['exec'])
    expect(getSshLog('host-b').map((e) => e.kind)).toEqual(['control'])
  })

  it('truncates oversized argv elements to 256 chars with an ellipsis', () => {
    const giant = 'x'.repeat(500)
    recordSshInvocation(makeEntry({ argv: ['ssh', giant] }))
    const stored = getSshLog('host-a')[0]
    expect(stored.argv[1]).toHaveLength(256)
    expect(stored.argv[1].endsWith('…')).toBe(true)
    expect(stored.argv[0]).toBe('ssh')
  })

  it('truncates oversized stderr snippets to 1024 chars with an ellipsis', () => {
    const giant = 'e'.repeat(2000)
    recordSshInvocation(makeEntry({ stderrSnippet: giant }))
    const stored = getSshLog('host-a')[0]
    expect(stored.stderrSnippet).toHaveLength(1024)
    expect(stored.stderrSnippet.endsWith('…')).toBe(true)
  })

  it('returns a defensive copy from getSshLog', () => {
    recordSshInvocation(makeEntry({ kind: 'exec' }))
    const log = getSshLog('host-a')
    log.length = 0
    expect(getSshLog('host-a')).toHaveLength(1)
  })

  it('returns an empty array for an unknown host', () => {
    expect(getSshLog('host-zzz')).toEqual([])
  })

  it('clears only the targeted host', () => {
    recordSshInvocation(makeEntry({ hostId: 'host-a' }))
    recordSshInvocation(makeEntry({ hostId: 'host-b' }))
    clearSshLog('host-a')
    expect(getSshLog('host-a')).toEqual([])
    expect(getSshLog('host-b')).toHaveLength(1)
  })
})
