import type { DiffFile, DiffHunk, DiffLine, FileStatus, LineType } from '../shared/types'

const DIFF_HEADER = /^diff --git a\/(.*) b\/(.*)$/
const RENAME_FROM = /^rename from (.*)$/
const RENAME_TO = /^rename to (.*)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function parseFileStatus(lines: string[], oldPath: string, newPath: string): FileStatus {
  for (const line of lines) {
    if (line.startsWith('new file mode')) return 'added'
    if (line.startsWith('deleted file mode')) return 'deleted'
    if (line.startsWith('rename from') || line.startsWith('similarity index')) return 'renamed'
  }
  if (oldPath !== newPath) return 'renamed'
  return 'modified'
}

export function parseDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return []

  const lines = raw.split('\n')
  const files: DiffFile[] = []
  let i = 0

  while (i < lines.length) {
    const headerMatch = lines[i].match(DIFF_HEADER)
    if (!headerMatch) {
      i++
      continue
    }

    let oldPath = headerMatch[1]
    let newPath = headerMatch[2]
    i++

    // Collect metadata lines until the first hunk or next diff header
    const metaLines: string[] = []
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].match(DIFF_HEADER)) {
      metaLines.push(lines[i])

      const renameFrom = lines[i].match(RENAME_FROM)
      if (renameFrom) oldPath = renameFrom[1]
      const renameTo = lines[i].match(RENAME_TO)
      if (renameTo) newPath = renameTo[1]

      i++
    }

    const status = parseFileStatus(metaLines, oldPath, newPath)
    const hunks: DiffHunk[] = []

    while (i < lines.length && !lines[i].match(DIFF_HEADER)) {
      const hunkMatch = lines[i].match(HUNK_HEADER)
      if (!hunkMatch) {
        i++
        continue
      }

      const oldStart = parseInt(hunkMatch[1], 10)
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1
      const newStart = parseInt(hunkMatch[3], 10)
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1
      const header = `@@ -${hunkMatch[1]}${hunkMatch[2] ? `,${hunkMatch[2]}` : ''} +${hunkMatch[3]}${hunkMatch[4] ? `,${hunkMatch[4]}` : ''} @@`
      i++

      const hunkLines: DiffLine[] = []
      let oldLine = oldStart
      let newLine = newStart

      while (i < lines.length && !lines[i].match(DIFF_HEADER) && !lines[i].match(HUNK_HEADER)) {
        const line = lines[i]

        if (line === '\\ No newline at end of file') {
          i++
          continue
        }

        if (line.startsWith('+')) {
          hunkLines.push({
            content: line.slice(1),
            lineType: 'addition' as LineType,
            oldLineNo: null,
            newLineNo: newLine++,
          })
        } else if (line.startsWith('-')) {
          hunkLines.push({
            content: line.slice(1),
            lineType: 'deletion' as LineType,
            oldLineNo: oldLine++,
            newLineNo: null,
          })
        } else if (line.startsWith(' ')) {
          hunkLines.push({
            content: line.slice(1),
            lineType: 'context' as LineType,
            oldLineNo: oldLine++,
            newLineNo: newLine++,
          })
        } else if (line === '') {
          // Could be end of diff or an empty context line — peek ahead
          if (i + 1 >= lines.length || lines[i + 1].match(DIFF_HEADER)) break
          hunkLines.push({
            content: '',
            lineType: 'context' as LineType,
            oldLineNo: oldLine++,
            newLineNo: newLine++,
          })
        } else {
          break
        }

        i++
      }

      hunks.push({ header, oldStart, oldCount, newStart, newCount, lines: hunkLines })
    }

    files.push({
      path: newPath,
      oldPath: status === 'renamed' ? oldPath : null,
      hunks,
      status,
    })
  }

  return files
}

export function synthesizeUntrackedFile(filePath: string, content: string): DiffFile {
  const fileLines = content.split('\n')
  // Remove trailing empty element from split if content ends with newline
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') {
    fileLines.pop()
  }

  const lines: DiffLine[] = fileLines.map((line, idx) => ({
    content: line,
    lineType: 'addition' as LineType,
    oldLineNo: null,
    newLineNo: idx + 1,
  }))

  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: lines.length,
    lines,
  }

  return {
    path: filePath,
    oldPath: null,
    hunks: [hunk],
    status: 'added',
  }
}
