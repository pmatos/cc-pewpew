import type { DiffFile, DiffHunk, HunkAnnotation } from '../../shared/types'

export function formatSelectedText(text: string): string {
  return `\`${text}\``
}

export function getHunkDiffText(
  hunk: DiffHunk,
  selectedLines?: { start: number; end: number }
): string {
  const lines = selectedLines
    ? hunk.lines.filter((line) => {
        const lineNo = line.newLineNo ?? line.oldLineNo
        return lineNo != null && lineNo >= selectedLines.start && lineNo <= selectedLines.end
      })
    : hunk.lines
  return lines
    .map((line) => {
      switch (line.lineType) {
        case 'addition':
          return `+${line.content}`
        case 'deletion':
          return `-${line.content}`
        case 'context':
          return ` ${line.content}`
      }
    })
    .join('\n')
}

export function getHunkKey(filePath: string, hunkIndex: number): string {
  return `${filePath}::${hunkIndex}`
}

export function generatePrompt(
  files: DiffFile[],
  annotations: Record<string, HunkAnnotation[]>
): string {
  if (files.length === 0) return ''

  let approvedHunks = 0
  const actionableItems: string[] = []

  for (const file of files) {
    for (let i = 0; i < file.hunks.length; i++) {
      const hunk = file.hunks[i]
      const key = getHunkKey(file.path, i)
      const anns = annotations[key]

      if (!anns || anns.length === 0) {
        // Unreviewed hunks are omitted — not counted
        continue
      }

      const allApproved = anns.every((a) => a.decision === 'approved')
      if (allApproved) {
        approvedHunks++
        continue
      }

      const heading = `## ${file.path} — Hunk ${hunk.header}`
      const items: string[] = []

      const hunkApprovals = anns.filter((a) => a.decision === 'approved' && !a.selectedLines)
      const lineApprovals = anns.filter((a) => a.decision === 'approved' && a.selectedLines)

      if (hunkApprovals.length > 0) {
        items.push('Hunk approved as-is.')
      }

      for (const ann of lineApprovals) {
        const selectedLines = ann.selectedLines!
        const linePart =
          selectedLines.start === selectedLines.end
            ? ` on line ${selectedLines.start}`
            : ` on lines ${selectedLines.start}-${selectedLines.end}`
        const textPart = ann.selectedText ? ` (\`${ann.selectedText}\`)` : ''
        items.push(`**Approved**${linePart}${textPart}`)
      }

      for (const ann of anns.filter((a) => a.decision === 'commented')) {
        const selectedLines = ann.selectedLines
        const linePart = selectedLines
          ? selectedLines.start === selectedLines.end
            ? ` on line ${selectedLines.start}`
            : ` on lines ${selectedLines.start}-${selectedLines.end}`
          : ''
        const textPart = ann.selectedText ? ` (\`${ann.selectedText}\`)` : ''
        items.push(`**Comment**${linePart}${textPart}:\n${ann.comment ?? ''}`)
      }

      for (const ann of anns.filter((a) => a.decision === 'rejected')) {
        const diffBlock = '```diff\n' + getHunkDiffText(hunk, ann.selectedLines) + '\n```'
        const textPart = ann.selectedText ? ` (\`${ann.selectedText}\`)` : ''

        if (ann.rejectMode === 'propose_alternative') {
          items.push(
            `**Rejected** (propose alternative)${textPart}:\n${diffBlock}\n${ann.comment ?? ''}`
          )
        } else {
          items.push(
            `**Rejected** (request other possibilities)${textPart}:\n${diffBlock}\n${ann.comment ?? ''}`
          )
        }
      }

      actionableItems.push(`${heading}\n${items.join('\n\n')}`)
    }
  }

  if (actionableItems.length === 0 && approvedHunks > 0) {
    return `I've reviewed your changes. All ${approvedHunks} hunks approved as-is. Looks good!`
  }

  if (actionableItems.length === 0 && approvedHunks === 0) {
    return ''
  }

  const parts = [
    `I've reviewed your changes. ${approvedHunks} hunks approved as-is.`,
    '',
    'The following need attention:',
    '',
    actionableItems.join('\n\n'),
  ]

  return parts.join('\n')
}
