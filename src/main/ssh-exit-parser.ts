import type { SshExitReason } from '../shared/types'

export interface SshExitInput {
  exitCode: number | null
  stderr: string
}

export interface SshExitClassification {
  reason: SshExitReason
  message: string
}

const AUTH_MARKERS = [
  'permission denied',
  'too many authentication failures',
  'host key verification failed',
  'no matching host key',
  'no supported authentication methods',
]

const NETWORK_MARKERS = [
  'connection refused',
  'connection timed out',
  'operation timed out',
  'no route to host',
  'network is unreachable',
  'could not resolve hostname',
  'name or service not known',
  'temporary failure in name resolution',
  'connection closed by',
]

function firstNonEmptyLine(stderr: string): string {
  for (const raw of stderr.split('\n')) {
    const line = raw.trim()
    if (line) return line
  }
  return ''
}

export function classifySshExit({ exitCode, stderr }: SshExitInput): SshExitClassification {
  const haystack = stderr.toLowerCase()
  const message = firstNonEmptyLine(stderr) || `ssh failed: code ${exitCode ?? 'null'}`

  if (exitCode === 0) {
    return { reason: 'unknown', message: 'ok' }
  }

  if (AUTH_MARKERS.some((m) => haystack.includes(m))) {
    return { reason: 'auth-failed', message }
  }

  if (NETWORK_MARKERS.some((m) => haystack.includes(m))) {
    return { reason: 'network', message }
  }

  if (
    exitCode === 127 &&
    (haystack.includes('command not found') || haystack.includes('not found'))
  ) {
    return { reason: 'dep-missing', message }
  }

  return { reason: 'unknown', message }
}
