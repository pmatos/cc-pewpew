import type { HostId, SshLogEntry } from '../shared/types'

const MAX_ENTRIES_PER_HOST = 200
const MAX_ARGV_ELEMENT_LEN = 256
const MAX_STDERR_SNIPPET_LEN = 1024

const buffers = new Map<HostId, SshLogEntry[]>()

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + '…'
}

export function recordSshInvocation(entry: SshLogEntry): void {
  const argv = entry.argv.map((a) => truncate(a, MAX_ARGV_ELEMENT_LEN))
  const stderrSnippet = truncate(entry.stderrSnippet, MAX_STDERR_SNIPPET_LEN)
  const sanitized: SshLogEntry = { ...entry, argv, stderrSnippet }

  const list = buffers.get(entry.hostId) ?? []
  list.push(sanitized)
  if (list.length > MAX_ENTRIES_PER_HOST) {
    list.splice(0, list.length - MAX_ENTRIES_PER_HOST)
  }
  buffers.set(entry.hostId, list)
}

export function getSshLog(hostId: HostId): SshLogEntry[] {
  const list = buffers.get(hostId)
  return list ? list.slice() : []
}

export function clearSshLog(hostId: HostId): void {
  buffers.delete(hostId)
}

// Test-only helper. Not exported to consumers but reachable via the module.
export function _resetSshLogForTests(): void {
  buffers.clear()
}
