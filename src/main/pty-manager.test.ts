import { describe, it, expect } from 'vitest'
import { buildAgentArgs } from './pty-manager'

describe('buildAgentArgs', () => {
  it('defaults to claude with --dangerously-skip-permissions', () => {
    expect(buildAgentArgs()).toEqual(['claude', '--dangerously-skip-permissions'])
  })

  it('claude with continueSession appends --continue', () => {
    expect(buildAgentArgs({ tool: 'claude', continueSession: true })).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--continue',
    ])
  })

  it('codex without resume uses bypass flag only', () => {
    expect(buildAgentArgs({ tool: 'codex' })).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('codex with continueSession + agentSessionId emits resume <id>', () => {
    expect(
      buildAgentArgs({
        tool: 'codex',
        continueSession: true,
        agentSessionId: 'abc-123',
      })
    ).toEqual(['codex', 'resume', 'abc-123', '--dangerously-bypass-approvals-and-sandbox'])
  })

  it('codex with continueSession but no agentSessionId falls back to fresh spawn', () => {
    expect(buildAgentArgs({ tool: 'codex', continueSession: true })).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('uses agentPath as argv[0] when provided (claude)', () => {
    expect(buildAgentArgs({ agentPath: '/u/.local/bin/claude' })).toEqual([
      '/u/.local/bin/claude',
      '--dangerously-skip-permissions',
    ])
  })

  it('uses agentPath as argv[0] when provided (codex resume)', () => {
    expect(
      buildAgentArgs({
        tool: 'codex',
        continueSession: true,
        agentSessionId: 'abc-123',
        agentPath: '/u/.npm/codex',
      })
    ).toEqual(['/u/.npm/codex', 'resume', 'abc-123', '--dangerously-bypass-approvals-and-sandbox'])
  })
})
