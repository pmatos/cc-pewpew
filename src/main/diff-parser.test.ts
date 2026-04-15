import { describe, it, expect } from 'vitest'
import { parseDiff, synthesizeUntrackedFile } from './diff-parser'

describe('parseDiff', () => {
  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('   ')).toEqual([])
    expect(parseDiff('\n\n')).toEqual([])
  })

  it('parses single file with additions only', () => {
    const diff = [
      'diff --git a/newfile.ts b/newfile.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/newfile.ts',
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('newfile.ts')
    expect(result[0].status).toBe('added')
    expect(result[0].hunks).toHaveLength(1)

    const lines = result[0].hunks[0].lines
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => l.lineType === 'addition')).toBe(true)
    expect(lines[0]).toEqual({
      content: 'line one',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 1,
    })
    expect(lines[1]).toEqual({
      content: 'line two',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 2,
    })
    expect(lines[2]).toEqual({
      content: 'line three',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 3,
    })
  })

  it('parses single file with deletions only', () => {
    const diff = [
      'diff --git a/removed.ts b/removed.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/removed.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-line one',
      '-line two',
      '-line three',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('removed.ts')
    expect(result[0].status).toBe('deleted')
    expect(result[0].hunks).toHaveLength(1)

    const lines = result[0].hunks[0].lines
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => l.lineType === 'deletion')).toBe(true)
    expect(lines[0]).toEqual({
      content: 'line one',
      lineType: 'deletion',
      oldLineNo: 1,
      newLineNo: null,
    })
    expect(lines[2]).toEqual({
      content: 'line three',
      lineType: 'deletion',
      oldLineNo: 3,
      newLineNo: null,
    })
  })

  it('parses mixed additions, deletions, and context lines', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc1234..def5678 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,4 +1,4 @@',
      ' line one',
      '-line two',
      '+line two modified',
      ' line three',
      ' line four',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('modified')

    const lines = result[0].hunks[0].lines
    expect(lines).toHaveLength(5)
    expect(lines[0]).toEqual({
      content: 'line one',
      lineType: 'context',
      oldLineNo: 1,
      newLineNo: 1,
    })
    expect(lines[1]).toEqual({
      content: 'line two',
      lineType: 'deletion',
      oldLineNo: 2,
      newLineNo: null,
    })
    expect(lines[2]).toEqual({
      content: 'line two modified',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 2,
    })
    expect(lines[3]).toEqual({
      content: 'line three',
      lineType: 'context',
      oldLineNo: 3,
      newLineNo: 3,
    })
    expect(lines[4]).toEqual({
      content: 'line four',
      lineType: 'context',
      oldLineNo: 4,
      newLineNo: 4,
    })
  })

  it('parses multiple files in one diff', () => {
    const diff = [
      'diff --git a/file-a.ts b/file-a.ts',
      'index aaa1111..bbb2222 100644',
      '--- a/file-a.ts',
      '+++ b/file-a.ts',
      '@@ -1,2 +1,2 @@',
      '-old a',
      '+new a',
      ' unchanged a',
      'diff --git a/file-b.ts b/file-b.ts',
      'index ccc3333..ddd4444 100644',
      '--- a/file-b.ts',
      '+++ b/file-b.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '+added line',
      ' end',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(2)
    expect(result[0].path).toBe('file-a.ts')
    expect(result[0].hunks[0].lines).toHaveLength(3)
    expect(result[1].path).toBe('file-b.ts')
    expect(result[1].hunks[0].lines).toHaveLength(3)
  })

  it('parses multiple hunks in one file', () => {
    const diff = [
      'diff --git a/multi.ts b/multi.ts',
      'index 111..222 100644',
      '--- a/multi.ts',
      '+++ b/multi.ts',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-old second',
      '+new second',
      ' third',
      '@@ -10,3 +10,4 @@',
      ' tenth',
      ' eleventh',
      '+inserted',
      ' twelfth',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].hunks).toHaveLength(2)

    const h1 = result[0].hunks[0]
    expect(h1.oldStart).toBe(1)
    expect(h1.newStart).toBe(1)
    expect(h1.lines).toHaveLength(4)

    const h2 = result[0].hunks[1]
    expect(h2.oldStart).toBe(10)
    expect(h2.newStart).toBe(10)
    expect(h2.lines).toHaveLength(4)
    expect(h2.lines[2]).toEqual({
      content: 'inserted',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 12,
    })
  })

  it('parses file renames', () => {
    const diff = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 95%',
      'rename from old-name.ts',
      'rename to new-name.ts',
      'index aaa..bbb 100644',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+line two changed',
      ' line three',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('new-name.ts')
    expect(result[0].oldPath).toBe('old-name.ts')
    expect(result[0].status).toBe('renamed')
  })

  it('parses new file mode', () => {
    const diff = [
      'diff --git a/brand-new.ts b/brand-new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/brand-new.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('added')
    expect(result[0].oldPath).toBeNull()
  })

  it('parses deleted file mode', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-goodbye',
      '-world',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('deleted')
    expect(result[0].hunks[0].lines).toHaveLength(2)
    expect(result[0].hunks[0].lines[0].lineType).toBe('deletion')
  })

  it('skips no-newline-at-EOF marker', () => {
    const diff = [
      'diff --git a/noeol.ts b/noeol.ts',
      'index aaa..bbb 100644',
      '--- a/noeol.ts',
      '+++ b/noeol.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-no eol old',
      '\\ No newline at end of file',
      '+no eol new',
      '\\ No newline at end of file',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)

    const lines = result[0].hunks[0].lines
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => l.content !== '\\ No newline at end of file')).toBe(true)
    expect(lines.every((l) => !l.content.includes('No newline'))).toBe(true)
  })

  it('handles binary file diff with no hunks', () => {
    const diff = [
      'diff --git a/image.png b/image.png',
      'index abc1234..def5678 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('image.png')
    expect(result[0].status).toBe('modified')
    expect(result[0].hunks).toHaveLength(0)
  })

  it('parses hunk headers without counts (implicit count of 1)', () => {
    const diff = [
      'diff --git a/single.ts b/single.ts',
      'index aaa..bbb 100644',
      '--- a/single.ts',
      '+++ b/single.ts',
      '@@ -1 +1 @@',
      '-old line',
      '+new line',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result).toHaveLength(1)

    const hunk = result[0].hunks[0]
    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldCount).toBe(1)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newCount).toBe(1)
    expect(hunk.header).toBe('@@ -1 +1 @@')
  })

  it('parses hunk headers with explicit counts', () => {
    const diff = [
      'diff --git a/counts.ts b/counts.ts',
      'index aaa..bbb 100644',
      '--- a/counts.ts',
      '+++ b/counts.ts',
      '@@ -5,7 +5,9 @@',
      ' context',
      '-removed',
      '+added one',
      '+added two',
      ' more context',
    ].join('\n')

    const result = parseDiff(diff)
    const hunk = result[0].hunks[0]
    expect(hunk.oldStart).toBe(5)
    expect(hunk.oldCount).toBe(7)
    expect(hunk.newStart).toBe(5)
    expect(hunk.newCount).toBe(9)
    expect(hunk.header).toBe('@@ -5,7 +5,9 @@')
  })

  it('preserves hunk header context text after @@', () => {
    const diff = [
      'diff --git a/ctx.ts b/ctx.ts',
      'index aaa..bbb 100644',
      '--- a/ctx.ts',
      '+++ b/ctx.ts',
      '@@ -10,3 +10,3 @@ function foo() {',
      ' inside',
      '-old',
      '+new',
      ' end',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result[0].hunks[0].header).toBe('@@ -10,3 +10,3 @@')
  })

  it('sets oldPath to null for non-renamed files', () => {
    const diff = [
      'diff --git a/same.ts b/same.ts',
      'index aaa..bbb 100644',
      '--- a/same.ts',
      '+++ b/same.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')

    const result = parseDiff(diff)
    expect(result[0].oldPath).toBeNull()
    expect(result[0].status).toBe('modified')
  })
})

describe('synthesizeUntrackedFile', () => {
  it('creates correct DiffFile with all addition lines', () => {
    const result = synthesizeUntrackedFile('src/new.ts', 'alpha\nbeta\ngamma\n')

    expect(result.path).toBe('src/new.ts')
    expect(result.oldPath).toBeNull()
    expect(result.status).toBe('added')
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]
    expect(hunk.oldStart).toBe(0)
    expect(hunk.oldCount).toBe(0)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newCount).toBe(3)
    expect(hunk.header).toBe('@@ -0,0 +1,3 @@')

    expect(hunk.lines).toHaveLength(3)
    expect(hunk.lines[0]).toEqual({
      content: 'alpha',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 1,
    })
    expect(hunk.lines[1]).toEqual({
      content: 'beta',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 2,
    })
    expect(hunk.lines[2]).toEqual({
      content: 'gamma',
      lineType: 'addition',
      oldLineNo: null,
      newLineNo: 3,
    })
  })

  it('handles content without trailing newline', () => {
    const result = synthesizeUntrackedFile('notrail.ts', 'one\ntwo')

    expect(result.hunks[0].lines).toHaveLength(2)
    expect(result.hunks[0].newCount).toBe(2)
  })

  it('handles single-line content', () => {
    const result = synthesizeUntrackedFile('single.ts', 'only line\n')

    expect(result.hunks[0].lines).toHaveLength(1)
    expect(result.hunks[0].lines[0].content).toBe('only line')
    expect(result.hunks[0].header).toBe('@@ -0,0 +1,1 @@')
  })

  it('handles empty content', () => {
    const result = synthesizeUntrackedFile('empty.ts', '')

    expect(result.hunks[0].lines).toHaveLength(0)
    expect(result.hunks[0].newCount).toBe(0)
  })
})
