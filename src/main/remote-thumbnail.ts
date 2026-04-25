import type { ExecResult } from './host-connection'
import type { Host } from '../shared/types'

export interface RemoteSessionEntry {
  sessionId: string
  host: Host
  tmuxSession: string
}

export interface CaptureOptions {
  exec: (host: Host, argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>
  maxRows?: number
  timeoutMs?: number
  // Fired as soon as an individual session's capture settles successfully.
  // Lets callers broadcast / persist per-session results without waiting for
  // the slowest sibling in the batch — without this, one timed-out session
  // would gate the whole tick and halve the effective update rate of every
  // healthy thumbnail.
  onCapture?: (sessionId: string, text: string) => void
}

export const DEFAULT_REMOTE_THUMBNAIL_ROWS = 24
// Matches the local `tmux capture-pane` timeout in pty-manager.captureThumbnails.
// Bounds a hung remote so it can't stall the 3 s thumbnail interval — the
// in-flight guard in index.ts skips overlapping ticks, so without this cap a
// single dead session would freeze every other session's thumbnail too.
export const DEFAULT_REMOTE_THUMBNAIL_TIMEOUT_MS = 3000

export function capLines(text: string, maxRows: number): string {
  // `tmux capture-pane -p` emits a trailing newline. A naive split + slice would
  // count the resulting empty tail element as a "row" and drop a real one when
  // the visible pane exactly fills `maxRows`. Strip the terminator before the
  // cap and re-attach it so the output round-trips for already-bounded input.
  const trailing = text.endsWith('\n')
  const body = trailing ? text.slice(0, -1) : text
  const lines = body.split('\n')
  if (lines.length <= maxRows) return text
  return lines.slice(-maxRows).join('\n') + (trailing ? '\n' : '')
}

export async function captureRemotePaneTexts(
  entries: ReadonlyArray<RemoteSessionEntry>,
  options: CaptureOptions
): Promise<Record<string, string>> {
  const maxRows = options.maxRows ?? DEFAULT_REMOTE_THUMBNAIL_ROWS
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_THUMBNAIL_TIMEOUT_MS
  const out: Record<string, string> = {}
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const result = await options.exec(
          entry.host,
          ['tmux', 'capture-pane', '-t', entry.tmuxSession, '-p'],
          { timeoutMs }
        )
        if (result.timedOut || result.code !== 0) return
        const text = capLines(result.stdout, maxRows)
        out[entry.sessionId] = text
        // Fire inside the per-entry async function so a fast session's result
        // surfaces before a slow sibling has even resolved its exec promise.
        options.onCapture?.(entry.sessionId, text)
      } catch {
        // Swallow per-session errors so one rejection can't poison the batch.
      }
    })
  )
  return out
}
