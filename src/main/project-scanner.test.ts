import { describe, it, expect } from 'vitest'
import { parseWorktreeList } from './project-scanner'

describe('parseWorktreeList', () => {
  it('returns empty array for empty input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  it('flags the first worktree as main and others as not main', () => {
    const stdout = [
      'worktree /home/user/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo/.claude/worktrees/feat-a',
      'HEAD def456',
      'branch refs/heads/cc-pewpew/feat-a',
      '',
      'worktree /tmp/external-wt',
      'HEAD 789abc',
      'branch refs/heads/external/feature',
      '',
    ].join('\n')

    const result = parseWorktreeList(stdout)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      name: 'repo',
      path: '/home/user/repo',
      branch: 'main',
      isMain: true,
    })
    expect(result[1]).toEqual({
      name: 'feat-a',
      path: '/home/user/repo/.claude/worktrees/feat-a',
      branch: 'cc-pewpew/feat-a',
      isMain: false,
    })
    expect(result[2]).toEqual({
      name: 'external-wt',
      path: '/tmp/external-wt',
      branch: 'external/feature',
      isMain: false,
    })
  })

  it('falls back to HEAD when no branch line is present (detached HEAD)', () => {
    const stdout = ['worktree /home/user/repo', 'HEAD abc123', 'detached', ''].join('\n')

    const result = parseWorktreeList(stdout)
    expect(result).toHaveLength(1)
    expect(result[0].branch).toBe('HEAD')
    expect(result[0].isMain).toBe(true)
  })

  it('handles a single-worktree repository', () => {
    const stdout = ['worktree /home/user/solo', 'HEAD abc123', 'branch refs/heads/main', ''].join(
      '\n'
    )

    const result = parseWorktreeList(stdout)
    expect(result).toHaveLength(1)
    expect(result[0].isMain).toBe(true)
  })
})
