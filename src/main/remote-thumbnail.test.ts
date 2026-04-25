import { describe, it, expect } from 'vitest'
import { capLines, captureRemotePaneTexts } from './remote-thumbnail'
import type { ExecResult } from './host-connection'
import type { Host } from '../shared/types'

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false }
}

const host: Host = { hostId: 'h1', alias: 'devbox', label: 'devbox' }

describe('capLines', () => {
  it('keeps only the last N lines when input exceeds N rows', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
    expect(capLines(text, 3)).toBe(['l3', 'l4', 'l5'].join('\n'))
  })

  it('returns input unchanged when it has fewer than N lines', () => {
    const text = ['only', 'two'].join('\n')
    expect(capLines(text, 24)).toBe(text)
  })
})

describe('captureRemotePaneTexts', () => {
  it('issues tmux capture-pane through the injected exec for each remote session', async () => {
    const calls: { host: Host; argv: string[] }[] = []
    const exec = async (h: Host, argv: string[]) => {
      calls.push({ host: h, argv })
      return ok('hi\n')
    }

    const result = await captureRemotePaneTexts(
      [
        { sessionId: 's1', host, tmuxSession: 'cc-pewpew-s1' },
        { sessionId: 's2', host, tmuxSession: 'cc-pewpew-s2' },
      ],
      { exec }
    )

    expect(result).toEqual({ s1: 'hi\n', s2: 'hi\n' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      host,
      argv: ['tmux', 'capture-pane', '-t', 'cc-pewpew-s1', '-p'],
    })
    expect(calls[1].argv).toEqual(['tmux', 'capture-pane', '-t', 'cc-pewpew-s2', '-p'])
  })

  it('caps captured output to the configured row limit', async () => {
    const big = Array.from({ length: 50 }, (_, i) => `row${i + 1}`).join('\n')
    const exec = async () => ok(big)

    const result = await captureRemotePaneTexts(
      [{ sessionId: 's1', host, tmuxSession: 'cc-pewpew-s1' }],
      { exec, maxRows: 24 }
    )

    expect(result.s1.split('\n')).toHaveLength(24)
    expect(result.s1.split('\n')[0]).toBe('row27')
    expect(result.s1.split('\n').at(-1)).toBe('row50')
  })

  it('skips a session whose exec rejects but still returns the others', async () => {
    const exec = async (_h: Host, argv: string[]) => {
      if (argv.includes('cc-pewpew-broken')) throw new Error('boom')
      return ok('ok-out\n')
    }

    const result = await captureRemotePaneTexts(
      [
        { sessionId: 'broken', host, tmuxSession: 'cc-pewpew-broken' },
        { sessionId: 'good', host, tmuxSession: 'cc-pewpew-good' },
      ],
      { exec }
    )

    expect(result).toEqual({ good: 'ok-out\n' })
  })

  it('skips a session whose capture times out or fails non-zero', async () => {
    const exec = async (_h: Host, argv: string[]): Promise<ExecResult> => {
      if (argv.includes('cc-pewpew-timeout')) {
        return { stdout: '', stderr: 'timed out', code: 1, timedOut: true }
      }
      if (argv.includes('cc-pewpew-noexit')) {
        return { stdout: '', stderr: "can't find session", code: 1, timedOut: false }
      }
      return ok('alive\n')
    }

    const result = await captureRemotePaneTexts(
      [
        { sessionId: 'timeout', host, tmuxSession: 'cc-pewpew-timeout' },
        { sessionId: 'noexit', host, tmuxSession: 'cc-pewpew-noexit' },
        { sessionId: 'alive', host, tmuxSession: 'cc-pewpew-alive' },
      ],
      { exec }
    )

    expect(result).toEqual({ alive: 'alive\n' })
  })
})
