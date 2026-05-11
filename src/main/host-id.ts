import type { HostId } from '../shared/types'

// Strip any character that could let a hand-edited/corrupted hostId traverse
// out of the intended directory when used in a filesystem path. UUIDs pass
// through unchanged.
export function sanitizeHostIdForPath(hostId: HostId): string {
  return hostId.replace(/[^A-Za-z0-9_.-]/g, '_')
}
