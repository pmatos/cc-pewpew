import { useEffect, useRef, useCallback, useMemo, useEffectEvent, useReducer } from 'react'
import { useReviewStore, getReviewProgress } from '../stores/review'
import { useSessionsStore } from '../stores/sessions'
import type { DiffMode, RejectMode } from '../../shared/types'
import { generatePrompt } from '../utils/prompt-generator'
import DiffViewer, { getHunkKey } from './review/DiffViewer'
import FileTree from './review/FileTree'
import ReviewTopBar from './review/ReviewTopBar'
import ReviewBottomBar from './review/ReviewBottomBar'
import FeedbackInput from './review/FeedbackInput'

interface Props {
  sessionId: string
  onClose: () => void
}

let annotationIdCounter = 0
function nextAnnotationId(): string {
  return `ann-${++annotationIdCounter}-${Date.now()}`
}

interface ReviewOverlayUiState {
  focusedHunkKey: string | null
  scrollToFile: string | undefined
  feedbackState: { hunkKey: string; mode: 'comment' | 'reject' } | null
  confirmAction: 'send' | 'copy' | null
  diffMode: DiffMode
  branches: string[]
  selectedBranch: string
  pendingModeSwitch: DiffMode | null
  pendingBranch: string | null
}

function reviewOverlayUiReducer(
  state: ReviewOverlayUiState,
  update: Partial<ReviewOverlayUiState>
): ReviewOverlayUiState {
  return { ...state, ...update }
}

export default function ReviewOverlay(props: Props) {
  return useReviewOverlayElement(props)
}

function useReviewOverlayElement({ sessionId, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reviewState = useReviewStore((s) => s.sessions[sessionId])
  const fetchDiff = useReviewStore((s) => s.fetchDiff)
  const addAnnotation = useReviewStore((s) => s.addAnnotation)
  const removeAnnotation = useReviewStore((s) => s.removeAnnotation)
  const clearAnnotations = useReviewStore((s) => s.clearAnnotations)
  const session = useSessionsStore((s) => s.sessions.find((s) => s.id === sessionId))
  const isRemote = session?.hostId != null

  const [ui, setUi] = useReducer(reviewOverlayUiReducer, {
    focusedHunkKey: null,
    scrollToFile: undefined,
    feedbackState: null,
    confirmAction: null,
    diffMode: 'uncommitted',
    branches: [],
    selectedBranch: 'main',
    pendingModeSwitch: null,
    pendingBranch: null,
  })
  const {
    focusedHunkKey,
    scrollToFile,
    feedbackState,
    confirmAction,
    diffMode,
    branches,
    selectedBranch,
    pendingModeSwitch,
    pendingBranch,
  } = ui

  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (isRemote) return
    fetchDiff(sessionId, 'uncommitted')
    window.api
      .getReviewBranches(sessionId)
      .then((r) => {
        if (r.ok && r.branches) setUi({ branches: r.branches })
      })
      .catch(() => {})
    window.api
      .getReviewDefaultBranch(sessionId)
      .then((r) => {
        if (r.ok && r.branch) setUi({ selectedBranch: r.branch })
      })
      .catch(() => {})
  }, [sessionId, fetchDiff, isRemote])

  const files = useMemo(() => reviewState?.files ?? [], [reviewState?.files])
  const annotations = useMemo(() => reviewState?.annotations ?? {}, [reviewState?.annotations])

  const allHunkKeys = files.flatMap((file) => file.hunks.map((_, i) => getHunkKey(file.path, i)))
  const progress = reviewState
    ? getReviewProgress(reviewState)
    : { total: 0, reviewed: 0, approved: 0, commented: 0, rejected: 0 }
  const unreviewedCount = progress.total - progress.reviewed
  const hasAnnotations = progress.reviewed > 0

  const switchMode = useCallback(
    (newMode: DiffMode, branch?: string) => {
      if (isRemote) return
      setUi({ diffMode: newMode, focusedHunkKey: null })
      clearAnnotations(sessionId)
      fetchDiff(sessionId, newMode, newMode === 'branch' ? (branch ?? selectedBranch) : undefined)
    },
    [sessionId, selectedBranch, fetchDiff, clearAnnotations, isRemote]
  )

  const handleModeChange = useCallback(
    (newMode: DiffMode) => {
      if (newMode === diffMode) return
      if (hasAnnotations) {
        setUi({ pendingModeSwitch: newMode })
      } else {
        switchMode(newMode)
      }
    },
    [diffMode, hasAnnotations, switchMode]
  )

  const handleBranchChange = useCallback(
    (branch: string) => {
      if (hasAnnotations) {
        setUi({ pendingBranch: branch, pendingModeSwitch: 'branch' })
      } else {
        setUi({ selectedBranch: branch })
        switchMode('branch', branch)
      }
    },
    [hasAnnotations, switchMode]
  )

  const navigateHunk = useCallback(
    (direction: 1 | -1) => {
      if (allHunkKeys.length === 0) return
      if (!focusedHunkKey) {
        setUi({
          focusedHunkKey: direction === 1 ? allHunkKeys[0] : allHunkKeys[allHunkKeys.length - 1],
        })
        return
      }
      const idx = allHunkKeys.indexOf(focusedHunkKey)
      const next = (idx + direction + allHunkKeys.length) % allHunkKeys.length
      setUi({ focusedHunkKey: allHunkKeys[next] })
    },
    [allHunkKeys, focusedHunkKey]
  )

  const handleHunkAction = useCallback(
    (filePath: string, hunkIndex: number, action: 'approve' | 'comment' | 'reject') => {
      const key = getHunkKey(filePath, hunkIndex)
      setUi({ focusedHunkKey: key })
      if (action === 'approve') {
        addAnnotation(sessionId, key, {
          id: nextAnnotationId(),
          decision: 'approved',
        })
      } else {
        setUi({ feedbackState: { hunkKey: key, mode: action } })
      }
    },
    [sessionId, addAnnotation]
  )

  const handleFeedbackSubmit = useCallback(
    (comment: string, rejectMode?: RejectMode) => {
      if (!feedbackState) return
      addAnnotation(sessionId, feedbackState.hunkKey, {
        id: nextAnnotationId(),
        decision: feedbackState.mode === 'comment' ? 'commented' : 'rejected',
        comment: comment || undefined,
        rejectMode,
      })
      setUi({ feedbackState: null })
      containerRef.current?.focus()
    },
    [sessionId, feedbackState, addAnnotation]
  )

  const handleRemoveAnnotation = useCallback(
    (hunkKey: string, annotationId: string) => {
      removeAnnotation(sessionId, hunkKey, annotationId)
    },
    [sessionId, removeAnnotation]
  )

  const executeAction = useCallback(
    (action: 'send' | 'copy') => {
      const prompt = generatePrompt(files, annotations)
      if (!prompt) return

      if (action === 'send') {
        window.api.ptyWrite(sessionId, prompt)
        setTimeout(() => onClose(), 500)
      } else {
        navigator.clipboard.writeText(prompt)
      }
    },
    [files, annotations, sessionId, onClose]
  )

  const handleSendOrCopy = useCallback(
    (action: 'send' | 'copy') => {
      if (unreviewedCount > 0) {
        setUi({ confirmAction: action })
      } else {
        executeAction(action)
      }
    },
    [unreviewedCount, executeAction]
  )

  const handleReviewKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // Scope shortcuts to this overlay instance (prevents cross-lane actions in swim lanes)
    if (!containerRef.current?.contains(e.target as Node)) return

    if (feedbackState) return
    if (confirmAction) return
    if (pendingModeSwitch) return

    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }

    const noMod = !e.ctrlKey && !e.altKey && !e.metaKey
    if (e.key === 'j' && noMod) {
      e.preventDefault()
      navigateHunk(1)
      return
    }
    if (e.key === 'k' && noMod) {
      e.preventDefault()
      navigateHunk(-1)
      return
    }

    if (focusedHunkKey && noMod) {
      if (e.key === 'a') {
        e.preventDefault()
        addAnnotation(sessionId, focusedHunkKey, {
          id: nextAnnotationId(),
          decision: 'approved',
        })
        return
      }
      if (e.key === 'c') {
        e.preventDefault()
        setUi({ feedbackState: { hunkKey: focusedHunkKey, mode: 'comment' } })
        return
      }
      if (e.key === 'r') {
        e.preventDefault()
        setUi({ feedbackState: { hunkKey: focusedHunkKey, mode: 'reject' } })
        return
      }
    }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      handleReviewKeyDown(e)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [])

  const handleFileClick = useCallback((filePath: string) => {
    setUi({ scrollToFile: filePath })
    setTimeout(() => setUi({ scrollToFile: undefined }), 100)
  }, [])

  const loading = !reviewState || reviewState.loading
  const error = reviewState?.error
  const focusedFile = focusedHunkKey ? focusedHunkKey.split('::')[0] : undefined

  if (isRemote || reviewState?.remoteUnsupported) {
    return (
      <div ref={containerRef} className="review-overlay" tabIndex={-1}>
        <div className="review-remote-unsupported">
          <div className="review-remote-unsupported-headline">
            Review not yet available on remote sessions
          </div>
          <div className="review-remote-unsupported-body">
            Diff and branch tools require local git access. Remote review support is planned for a
            future release.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="review-overlay" tabIndex={-1}>
      {loading ? (
        <div className="review-loading">
          <div className="review-loading-bar" />
          <div className="review-loading-bar" />
          <div className="review-loading-bar" />
        </div>
      ) : error ? (
        <div className="review-error-container">
          <div className="review-error-icon">!</div>
          <div className="review-error">{error}</div>
          <button
            className="rv-feedback-btn rv-feedback-btn--submit"
            onClick={() =>
              fetchDiff(sessionId, diffMode, diffMode === 'branch' ? selectedBranch : undefined)
            }
          >
            Retry
          </button>
        </div>
      ) : files.length === 0 ? (
        <div className="review-placeholder">No changes</div>
      ) : (
        <div className="review-layout">
          <ReviewTopBar
            repoName={session?.projectName ?? ''}
            branch={session?.worktreeName ?? ''}
            fileCount={files.length}
            mode={diffMode}
            onModeChange={handleModeChange}
            branches={branches}
            selectedBranch={selectedBranch}
            onBranchChange={handleBranchChange}
          />
          <div className="review-body">
            <div className="review-sidebar">
              <FileTree files={files} focusedFile={focusedFile} onFileClick={handleFileClick} />
            </div>
            <div className="review-main">
              <DiffViewer
                files={files}
                annotations={annotations}
                focusedHunkKey={focusedHunkKey}
                scrollToFile={scrollToFile}
                onHunkAction={handleHunkAction}
                onRemoveAnnotation={handleRemoveAnnotation}
              />
              {feedbackState && (
                <FeedbackInput
                  mode={feedbackState.mode}
                  onSubmit={handleFeedbackSubmit}
                  onCancel={() => {
                    setUi({ feedbackState: null })
                    containerRef.current?.focus()
                  }}
                />
              )}
            </div>
          </div>
          <ReviewBottomBar
            approved={progress.approved}
            commented={progress.commented}
            rejected={progress.rejected}
            total={progress.total}
            onSendToSession={() => handleSendOrCopy('send')}
            onCopyToClipboard={() => handleSendOrCopy('copy')}
          />
          {confirmAction && (
            <div className="rv-confirm-overlay">
              <div className="rv-confirm-dialog">
                <p>
                  {unreviewedCount} hunk{unreviewedCount !== 1 ? 's' : ''} unreviewed. They will be
                  omitted from the prompt.
                </p>
                <div className="rv-confirm-actions">
                  <button
                    className="rv-feedback-btn rv-feedback-btn--cancel"
                    onClick={() => setUi({ confirmAction: null })}
                  >
                    Cancel
                  </button>
                  <button
                    className="rv-feedback-btn rv-feedback-btn--submit"
                    onClick={() => {
                      executeAction(confirmAction)
                      setUi({ confirmAction: null })
                    }}
                  >
                    Omit unreviewed
                  </button>
                </div>
              </div>
            </div>
          )}
          {pendingModeSwitch && (
            <div className="rv-confirm-overlay">
              <div className="rv-confirm-dialog">
                <p>Switching mode will clear all annotations. Continue?</p>
                <div className="rv-confirm-actions">
                  <button
                    className="rv-feedback-btn rv-feedback-btn--cancel"
                    onClick={() => {
                      setUi({ pendingModeSwitch: null, pendingBranch: null })
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="rv-feedback-btn rv-feedback-btn--submit"
                    onClick={() => {
                      if (pendingBranch) setUi({ selectedBranch: pendingBranch })
                      switchMode(pendingModeSwitch, pendingBranch ?? undefined)
                      setUi({ pendingModeSwitch: null, pendingBranch: null })
                    }}
                  >
                    Switch mode
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
