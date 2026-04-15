import { describe, it, expect } from 'vitest'
import { generatePrompt, getHunkDiffText, getHunkKey, formatSelectedText } from './prompt-generator'
import type { DiffFile, DiffHunk, HunkAnnotation } from '../../shared/types'

function makeHunk(overrides?: Partial<DiffHunk>): DiffHunk {
  return {
    header: '@@ -1,3 +1,4 @@',
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 4,
    lines: [
      { content: '  context line', lineType: 'context', oldLineNo: 1, newLineNo: 1 },
      { content: '  old line', lineType: 'deletion', oldLineNo: 2, newLineNo: null },
      { content: '  new line', lineType: 'addition', oldLineNo: null, newLineNo: 2 },
      { content: '  another ctx', lineType: 'context', oldLineNo: 3, newLineNo: 3 },
    ],
    ...overrides,
  }
}

function makeFile(path: string, hunkCount = 1): DiffFile {
  const hunks: DiffHunk[] = []
  for (let i = 0; i < hunkCount; i++) {
    hunks.push(makeHunk({ header: `@@ -${i * 10 + 1},3 +${i * 10 + 1},4 @@` }))
  }
  return { path, oldPath: null, hunks, status: 'modified' }
}

let idCounter = 0
function ann(
  overrides: Partial<HunkAnnotation> & Pick<HunkAnnotation, 'decision'>
): HunkAnnotation {
  return {
    id: `test-${++idCounter}`,
    ...overrides,
  }
}

describe('getHunkKey', () => {
  it('generates key from path and index', () => {
    expect(getHunkKey('src/foo.ts', 2)).toBe('src/foo.ts::2')
  })
})

describe('formatSelectedText', () => {
  it('wraps text in backticks', () => {
    expect(formatSelectedText('some code')).toBe('`some code`')
  })
})

describe('getHunkDiffText', () => {
  it('reconstructs diff text with proper prefixes', () => {
    const hunk = makeHunk()
    const result = getHunkDiffText(hunk)
    expect(result).toBe('   context line\n' + '-  old line\n' + '+  new line\n' + '   another ctx')
  })
})

describe('generatePrompt', () => {
  it('returns empty string for no files', () => {
    expect(generatePrompt([], {})).toBe('')
  })

  it('returns all-approved message when all hunks explicitly approved', () => {
    const files = [makeFile('src/a.ts', 2), makeFile('src/b.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/a.ts::0': [ann({ decision: 'approved' })],
      'src/a.ts::1': [ann({ decision: 'approved' })],
      'src/b.ts::0': [ann({ decision: 'approved' })],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toBe("I've reviewed your changes. All 3 hunks approved as-is. Looks good!")
  })

  it('omits unreviewed hunks', () => {
    const files = [makeFile('src/a.ts', 1)]
    const result = generatePrompt(files, {})
    expect(result).toBe('')
  })

  it('generates comment with selected text', () => {
    const files = [makeFile('src/auth.ts', 2)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/auth.ts::0': [ann({ decision: 'approved' })],
      'src/auth.ts::1': [
        ann({
          decision: 'commented',
          comment: 'This looks suspicious',
          selectedText: 'doAuth()',
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('1 hunks approved as-is.')
    expect(result).toContain('The following need attention:')
    expect(result).toContain('## src/auth.ts — Hunk @@ -11,3 +11,4 @@')
    expect(result).toContain('**Comment** (`doAuth()`):')
    expect(result).toContain('This looks suspicious')
  })

  it('generates comment without selected text', () => {
    const files = [makeFile('src/auth.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/auth.ts::0': [
        ann({
          decision: 'commented',
          comment: 'General remark',
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('**Comment**:')
    expect(result).toContain('General remark')
    expect(result).not.toContain('**Comment** on')
  })

  it('generates rejection with propose alternative', () => {
    const files = [makeFile('src/db.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/db.ts::0': [
        ann({
          decision: 'rejected',
          rejectMode: 'propose_alternative',
          comment: 'Use a connection pool instead',
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('**Rejected** (propose alternative):')
    expect(result).toContain('```diff')
    expect(result).toContain('Use a connection pool instead')
  })

  it('generates rejection with request other possibilities', () => {
    const files = [makeFile('src/db.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/db.ts::0': [
        ann({
          decision: 'rejected',
          rejectMode: 'request_possibilities',
          comment: 'Show me other approaches',
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('**Rejected** (request other possibilities):')
    expect(result).toContain('```diff')
    expect(result).toContain('Show me other approaches')
  })

  it('produces mixed output with approved count and actionable items', () => {
    const files = [makeFile('src/a.ts', 3), makeFile('src/b.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/a.ts::0': [ann({ decision: 'approved' })],
      'src/a.ts::1': [
        ann({
          decision: 'commented',
          comment: 'Needs docs',
        }),
      ],
      'src/a.ts::2': [
        ann({
          decision: 'rejected',
          rejectMode: 'propose_alternative',
          comment: 'Try X instead',
        }),
      ],
      'src/b.ts::0': [ann({ decision: 'approved' })],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toMatch(/^I've reviewed your changes\. 2 hunks approved as-is\./)
    expect(result).toContain('The following need attention:')
    expect(result).toContain('## src/a.ts — Hunk')
    expect(result).toContain('**Comment**:')
    expect(result).toContain('**Rejected** (propose alternative):')
    expect(result).not.toContain('src/b.ts')
  })

  it('generates comment with selected lines range', () => {
    const files = [makeFile('src/auth.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/auth.ts::0': [
        ann({
          decision: 'commented',
          comment: 'This logic is wrong',
          selectedText: 'doAuth()',
          selectedLines: { start: 1, end: 3 },
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('**Comment** on lines 1-3 (`doAuth()`):')
    expect(result).toContain('This logic is wrong')
  })

  it('generates comment with single selected line', () => {
    const files = [makeFile('src/auth.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/auth.ts::0': [
        ann({
          decision: 'commented',
          comment: 'Bad name',
          selectedLines: { start: 2, end: 2 },
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('**Comment** on line 2:')
    expect(result).toContain('Bad name')
  })

  it('generates rejection with selectedText shown', () => {
    const files = [makeFile('src/db.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/db.ts::0': [
        ann({
          decision: 'rejected',
          rejectMode: 'propose_alternative',
          comment: 'Use pool',
          selectedText: 'createConnection()',
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('**Rejected** (propose alternative) (`createConnection()`):')
    expect(result).toContain('Use pool')
  })

  it('generates rejection with selectedLines filtering diff', () => {
    const files = [makeFile('src/db.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/db.ts::0': [
        ann({
          decision: 'rejected',
          rejectMode: 'propose_alternative',
          comment: 'Change this',
          selectedLines: { start: 2, end: 2 },
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('```diff')
    expect(result).not.toContain('context line')
  })

  it('handles multiple annotations on same hunk', () => {
    const files = [makeFile('src/foo.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/foo.ts::0': [
        ann({ decision: 'approved', selectedLines: { start: 1, end: 1 } }),
        ann({
          decision: 'commented',
          comment: 'Rename this',
          selectedLines: { start: 2, end: 2 },
        }),
        ann({
          decision: 'rejected',
          rejectMode: 'propose_alternative',
          comment: 'Wrong approach',
          selectedLines: { start: 3, end: 3 },
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('0 hunks approved as-is.')
    expect(result).toContain('**Approved** on line 1')
    expect(result).toContain('**Comment** on line 2:')
    expect(result).toContain('Rename this')
    expect(result).toContain('**Rejected** (propose alternative):')
    expect(result).toContain('Wrong approach')
  })

  it('hunk with only line-level approvals counts as approved', () => {
    const files = [makeFile('src/foo.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/foo.ts::0': [ann({ decision: 'approved', selectedLines: { start: 1, end: 3 } })],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toBe("I've reviewed your changes. All 1 hunks approved as-is. Looks good!")
  })

  it('mixes hunk-level and line-level annotations', () => {
    const files = [makeFile('src/foo.ts', 1)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/foo.ts::0': [
        ann({ decision: 'approved' }),
        ann({
          decision: 'commented',
          comment: 'But fix this line',
          selectedLines: { start: 2, end: 2 },
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('Hunk approved as-is.')
    expect(result).toContain('**Comment** on line 2:')
    expect(result).toContain('But fix this line')
  })

  it('counts only explicitly approved hunks in partial review', () => {
    const files = [makeFile('src/a.ts', 3)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/a.ts::0': [ann({ decision: 'approved' })],
      'src/a.ts::2': [
        ann({
          decision: 'commented',
          comment: 'Fix this',
        }),
      ],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toContain('1 hunks approved as-is.')
    expect(result).toContain('The following need attention:')
    expect(result).not.toContain('src/a.ts — Hunk @@ -11,3 +11,4 @@')
  })

  it('returns empty string when no annotations at all', () => {
    const files = [makeFile('src/a.ts', 2), makeFile('src/b.ts', 3)]
    const result = generatePrompt(files, {})
    expect(result).toBe('')
  })

  it('omits unreviewed hunks from output in mixed review', () => {
    const files = [makeFile('src/a.ts', 3)]
    const annotations: Record<string, HunkAnnotation[]> = {
      'src/a.ts::0': [ann({ decision: 'approved' })],
      'src/a.ts::2': [ann({ decision: 'approved' })],
    }

    const result = generatePrompt(files, annotations)
    expect(result).toBe("I've reviewed your changes. All 2 hunks approved as-is. Looks good!")
  })
})
