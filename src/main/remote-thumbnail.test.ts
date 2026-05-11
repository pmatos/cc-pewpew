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

  it('preserves the trailing newline without dropping a real row', () => {
    // 5 real rows + trailing newline, cap=5 — must keep all 5 rows.
    const text = ['r1', 'r2', 'r3', 'r4', 'r5'].join('\n') + '\n'
    expect(capLines(text, 5)).toBe(text)
  })

  it('caps to last N real rows when input has trailing newline and exceeds cap', () => {
    const text = Array.from({ length: 6 }, (_, i) => `r${i + 1}`).join('\n') + '\n'
    expect(capLines(text, 5)).toBe(['r2', 'r3', 'r4', 'r5', 'r6'].join('\n') + '\n')
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
        { sessionId: 's1', host, tmuxSession: 'pewpew-s1' },
        { sessionId: 's2', host, tmuxSession: 'pewpew-s2' },
      ],
      { exec }
    )

    expect(result).toEqual({ s1: 'hi\n', s2: 'hi\n' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      host,
      argv: ['tmux', 'capture-pane', '-t', 'pewpew-s1', '-p'],
    })
    expect(calls[1].argv).toEqual(['tmux', 'capture-pane', '-t', 'pewpew-s2', '-p'])
  })

  it('caps captured output to the configured row limit', async () => {
    const big = Array.from({ length: 50 }, (_, i) => `row${i + 1}`).join('\n')
    const exec = async () => ok(big)

    const result = await captureRemotePaneTexts(
      [{ sessionId: 's1', host, tmuxSession: 'pewpew-s1' }],
      { exec, maxRows: 24 }
    )

    expect(result.s1.split('\n')).toHaveLength(24)
    expect(result.s1.split('\n')[0]).toBe('row27')
    expect(result.s1.split('\n').at(-1)).toBe('row50')
  })

  it('skips a session whose exec rejects but still returns the others', async () => {
    const exec = async (_h: Host, argv: string[]) => {
      if (argv.includes('pewpew-broken')) throw new Error('boom')
      return ok('ok-out\n')
    }

    const result = await captureRemotePaneTexts(
      [
        { sessionId: 'broken', host, tmuxSession: 'pewpew-broken' },
        { sessionId: 'good', host, tmuxSession: 'pewpew-good' },
      ],
      { exec }
    )

    expect(result).toEqual({ good: 'ok-out\n' })
  })

  it('skips a session whose capture times out or fails non-zero', async () => {
    const exec = async (_h: Host, argv: string[]): Promise<ExecResult> => {
      if (argv.includes('pewpew-timeout')) {
        return { stdout: '', stderr: 'timed out', code: 1, timedOut: true }
      }
      if (argv.includes('pewpew-noexit')) {
        return { stdout: '', stderr: "can't find session", code: 1, timedOut: false }
      }
      return ok('alive\n')
    }

    const result = await captureRemotePaneTexts(
      [
        { sessionId: 'timeout', host, tmuxSession: 'pewpew-timeout' },
        { sessionId: 'noexit', host, tmuxSession: 'pewpew-noexit' },
        { sessionId: 'alive', host, tmuxSession: 'pewpew-alive' },
      ],
      { exec }
    )

    expect(result).toEqual({ alive: 'alive\n' })
  })

  it('passes a per-call timeoutMs to exec so a hung session cannot stall the batch', async () => {
    const seenTimeouts: (number | undefined)[] = []
    const exec = async (
      _h: Host,
      _argv: string[],
      opts?: { timeoutMs?: number }
    ): Promise<ExecResult> => {
      seenTimeouts.push(opts?.timeoutMs)
      return ok('hi\n')
    }

    await captureRemotePaneTexts([{ sessionId: 's1', host, tmuxSession: 'pewpew-s1' }], { exec })

    expect(seenTimeouts).toHaveLength(1)
    expect(seenTimeouts[0]).toBeDefined()
    // The local thumbnail capture path uses 3000ms; remote must match so a
    // single hung session can't push the whole tick past the 3s thumbnail
    // interval.
    expect(seenTimeouts[0]!).toBeLessThanOrEqual(3000)
  })

  it('invokes onCapture for a fast session before a slow sibling settles', async () => {
    let slowSettled = false
    const fastEmitsObservedSlowState: boolean[] = []

    const exec = async (_h: Host, argv: string[]): Promise<ExecResult> => {
      if (argv.includes('pewpew-slow')) {
        await new Promise((r) => setTimeout(r, 60))
        slowSettled = true
        return ok('slow\n')
      }
      return ok('fast\n')
    }

    await captureRemotePaneTexts(
      [
        { sessionId: 'fast', host, tmuxSession: 'pewpew-fast' },
        { sessionId: 'slow', host, tmuxSession: 'pewpew-slow' },
      ],
      {
        exec,
        onCapture: (sid) => {
          if (sid === 'fast') fastEmitsObservedSlowState.push(slowSettled)
        },
      }
    )

    expect(fastEmitsObservedSlowState).toEqual([false])
  })

  it('passes the capped per-session text to onCapture and the aggregate return', async () => {
    const calls: { sid: string; text: string }[] = []
    const exec = async (_h: Host, argv: string[]) =>
      ok(argv.includes('pewpew-s1') ? 's1-text\n' : 's2-text\n')

    const result = await captureRemotePaneTexts(
      [
        { sessionId: 's1', host, tmuxSession: 'pewpew-s1' },
        { sessionId: 's2', host, tmuxSession: 'pewpew-s2' },
      ],
      { exec, onCapture: (sid, text) => calls.push({ sid, text }) }
    )

    expect(calls).toEqual([
      { sid: 's1', text: 's1-text\n' },
      { sid: 's2', text: 's2-text\n' },
    ])
    expect(result).toEqual({ s1: 's1-text\n', s2: 's2-text\n' })
  })
})
