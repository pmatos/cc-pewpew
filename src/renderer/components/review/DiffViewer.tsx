import { useEffect, useRef, useState } from 'react'
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  FileStatus,
  HunkAnnotation,
} from '../../../shared/types'
import HunkToolbar from './HunkToolbar'

export function getHunkKey(filePath: string, hunkIndex: number): string {
  return `${filePath}::${hunkIndex}`
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const modifier =
    line.lineType === 'addition'
      ? ' rv-diff-line--addition'
      : line.lineType === 'deletion'
        ? ' rv-diff-line--deletion'
        : ''

  const prefix = line.lineType === 'addition' ? '+' : line.lineType === 'deletion' ? '-' : ' '

  return (
    <div className={`rv-diff-line${modifier}`}>
      <div className="rv-line-gutter">{line.oldLineNo ?? ''}</div>
      <div className="rv-line-gutter">{line.newLineNo ?? ''}</div>
      <div className="rv-line-content">
        {prefix}
        {line.content}
      </div>
    </div>
  )
}

function AnnotationBadge({
  annotation,
  onRemove,
}: {
  annotation: HunkAnnotation
  onRemove: () => void
}) {
  const label =
    annotation.decision === 'approved'
      ? 'Approved'
      : annotation.decision === 'commented'
        ? (annotation.comment ?? 'Comment')
        : (annotation.comment ?? 'Rejected')

  const displayLabel = label.length > 60 ? label.slice(0, 60) + '...' : label

  return (
    <div
      className={`rv-annotation-badge rv-annotation-badge--${annotation.decision}`}
      title={label}
    >
      <span className="rv-annotation-text">{displayLabel}</span>
      <button
        className="rv-annotation-remove"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        title="Remove"
      >
        &times;
      </button>
    </div>
  )
}

function DiffHunkView({
  hunk,
  hunkIndex,
  filePath,
  annotations,
  isFocused,
  onHunkAction,
  onRemoveAnnotation,
}: {
  hunk: DiffHunk
  hunkIndex: number
  filePath: string
  annotations: HunkAnnotation[]
  isFocused: boolean
  onHunkAction: (action: 'approve' | 'comment' | 'reject') => void
  onRemoveAnnotation: (annotationId: string) => void
}) {
  const [headerHovered, setHeaderHovered] = useState(false)

  const classes = ['rv-diff-hunk']
  if (annotations.length > 0) {
    const hasRejected = annotations.some((a) => a.decision === 'rejected')
    const hasCommented = annotations.some((a) => a.decision === 'commented')
    if (hasRejected) classes.push('rv-diff-hunk--rejected')
    else if (hasCommented) classes.push('rv-diff-hunk--commented')
    else classes.push('rv-diff-hunk--approved')
  }
  if (isFocused) classes.push('rv-diff-hunk--focused')

  return (
    <div className={classes.join(' ')} data-hunk-key={getHunkKey(filePath, hunkIndex)}>
      <div
        className="rv-hunk-header"
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
      >
        <span>{hunk.header}</span>
        {headerHovered && (
          <HunkToolbar
            onApprove={() => onHunkAction('approve')}
            onComment={() => onHunkAction('comment')}
            onReject={() => onHunkAction('reject')}
          />
        )}
      </div>
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
      {annotations.map((ann) => (
        <AnnotationBadge
          key={ann.id}
          annotation={ann}
          onRemove={() => onRemoveAnnotation(ann.id)}
        />
      ))}
    </div>
  )
}

function statusBadgeClass(status: FileStatus): string {
  return `rv-file-status rv-file-status--${status}`
}

interface DiffViewerProps {
  files: DiffFile[]
  annotations: Record<string, HunkAnnotation[]>
  focusedHunkKey: string | null
  scrollToFile?: string
  onHunkAction: (
    filePath: string,
    hunkIndex: number,
    action: 'approve' | 'comment' | 'reject'
  ) => void
  onRemoveAnnotation: (hunkKey: string, annotationId: string) => void
}

function DiffViewer({
  files,
  annotations,
  focusedHunkKey,
  scrollToFile,
  onHunkAction,
  onRemoveAnnotation,
}: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollToFile && containerRef.current) {
      const el = containerRef.current.querySelector(`#file-${CSS.escape(scrollToFile)}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [scrollToFile])

  useEffect(() => {
    if (focusedHunkKey && containerRef.current) {
      const el = containerRef.current.querySelector(
        `[data-hunk-key="${CSS.escape(focusedHunkKey)}"]`
      )
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [focusedHunkKey])

  return (
    <div className="rv-diff-viewer" ref={containerRef}>
      {files.map((file) => (
        <div key={file.path} className="rv-file-section" id={`file-${file.path}`}>
          <div className="rv-file-header">
            <span className={statusBadgeClass(file.status)}>{file.status}</span>
            <span>{file.path}</span>
          </div>
          {file.hunks.map((hunk, hunkIndex) => {
            const key = getHunkKey(file.path, hunkIndex)
            return (
              <DiffHunkView
                key={key}
                hunk={hunk}
                hunkIndex={hunkIndex}
                filePath={file.path}
                annotations={annotations[key] ?? []}
                isFocused={focusedHunkKey === key}
                onHunkAction={(action) => onHunkAction(file.path, hunkIndex, action)}
                onRemoveAnnotation={(annId) => onRemoveAnnotation(key, annId)}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default DiffViewer
