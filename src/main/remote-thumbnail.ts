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
}

export const DEFAULT_REMOTE_THUMBNAIL_ROWS = 24

export function capLines(text: string, maxRows: number): string {
  const lines = text.split('\n')
  return lines.slice(-maxRows).join('\n')
}

export async function captureRemotePaneTexts(
  entries: ReadonlyArray<RemoteSessionEntry>,
  options: CaptureOptions
): Promise<Record<string, string>> {
  const maxRows = options.maxRows ?? DEFAULT_REMOTE_THUMBNAIL_ROWS
  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      const result = await options.exec(entry.host, [
        'tmux',
        'capture-pane',
        '-t',
        entry.tmuxSession,
        '-p',
      ])
      return { entry, result }
    })
  )
  const out: Record<string, string> = {}
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue
    const { entry, result } = item.value
    if (result.timedOut || result.code !== 0) continue
    out[entry.sessionId] = capLines(result.stdout, maxRows)
  }
  return out
}
