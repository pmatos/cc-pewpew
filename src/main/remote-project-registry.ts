import { posix } from 'path'
import { getConfig, saveConfig } from './config'
import { getHost } from './host-registry'
import type { HostId, Project, RemoteProject } from '../shared/types'

const MAX_PATH_LEN = 4096

export function validateRemotePath(raw: string): string {
  const path = raw.trim()
  if (!path) throw new Error('Path is required')
  if (path.length > MAX_PATH_LEN)
    throw new Error(`Path must be ${MAX_PATH_LEN} characters or fewer`)
  if (!path.startsWith('/')) throw new Error('Path must be absolute (start with "/")')
  if (path.startsWith('-')) throw new Error('Path must not start with "-"')
  if (path.includes('\x00')) throw new Error('Path must not contain NUL')
  // Collapse `.`, `..`, and duplicate slashes, then strip any trailing slash
  // (preserving the root `/`). Keeps duplicate-detection robust against
  // equivalent forms like `/srv/repo` vs `/srv/repo/` vs `/srv/a/../repo`.
  const normalized = posix.normalize(path)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

export function listRemoteProjects(): RemoteProject[] {
  return getConfig().remoteProjects
}

export function addRemoteProject(input: {
  hostId: HostId
  path: string
  name?: string
  repoFingerprint?: string
}): RemoteProject {
  const path = validateRemotePath(input.path)
  if (!getHost(input.hostId)) throw new Error('Unknown host')
  const config = getConfig()
  if (config.remoteProjects.some((p) => p.hostId === input.hostId && p.path === path)) {
    throw new Error('Remote project already registered')
  }
  const name = (input.name ?? posix.basename(path)).trim() || posix.basename(path)
  const project: RemoteProject = {
    hostId: input.hostId,
    path,
    name,
    ...(input.repoFingerprint ? { repoFingerprint: input.repoFingerprint } : {}),
  }
  config.remoteProjects = [...config.remoteProjects, project]
  saveConfig(config)
  return project
}

export function removeRemoteProject(hostId: HostId, path: string): void {
  const config = getConfig()
  const next = config.remoteProjects.filter((p) => !(p.hostId === hostId && p.path === path))
  if (next.length === config.remoteProjects.length) return
  config.remoteProjects = next
  saveConfig(config)
}

export function hasRemoteProjectsBoundTo(hostId: HostId): boolean {
  return listRemoteProjects().some((p) => p.hostId === hostId)
}

export function toProject(rp: RemoteProject): Project {
  return {
    name: rp.name,
    path: rp.path,
    branches: [],
    worktrees: [],
    setupState: 'ready',
    hostId: rp.hostId,
  }
}
