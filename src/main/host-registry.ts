import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR, getConfig, saveConfig } from './config'
import type { Host, HostId } from '../shared/types'

const SESSIONS_PATH = join(CONFIG_DIR, 'sessions.json')

const MAX_ALIAS_LEN = 64
const MAX_LABEL_LEN = 40

export function validateAlias(raw: string): string {
  const alias = raw.trim()
  if (!alias) throw new Error('Alias is required')
  if (alias.length > MAX_ALIAS_LEN)
    throw new Error(`Alias must be ${MAX_ALIAS_LEN} characters or fewer`)
  if (alias.startsWith('-')) throw new Error('Alias must not start with "-"')
  if (/\s/.test(alias)) throw new Error('Alias must not contain whitespace')
  if (alias.includes('\x00')) throw new Error('Alias must not contain NUL')
  return alias
}

export function validateLabel(raw: string): string {
  const label = raw.trim()
  if (!label) throw new Error('Label is required')
  if (label.length > MAX_LABEL_LEN)
    throw new Error(`Label must be ${MAX_LABEL_LEN} characters or fewer`)
  return label
}

export function listHosts(): Host[] {
  return getConfig().hosts
}

export function getHost(hostId: HostId): Host | undefined {
  return listHosts().find((h) => h.hostId === hostId)
}

export function addHost(input: { alias: string; label: string }): Host {
  const alias = validateAlias(input.alias)
  const label = validateLabel(input.label)
  const config = getConfig()
  if (config.hosts.some((h) => h.alias === alias)) {
    throw new Error('Alias already exists')
  }
  const host: Host = { hostId: randomUUID(), alias, label }
  config.hosts = [...config.hosts, host]
  saveConfig(config)
  return host
}

export function updateHost(hostId: HostId, input: { alias: string; label: string }): Host {
  const alias = validateAlias(input.alias)
  const label = validateLabel(input.label)
  const config = getConfig()
  const idx = config.hosts.findIndex((h) => h.hostId === hostId)
  if (idx === -1) throw new Error('Unknown host')
  if (config.hosts.some((h) => h.hostId !== hostId && h.alias === alias)) {
    throw new Error('Alias already exists')
  }
  const updated: Host = { hostId, alias, label }
  config.hosts = [...config.hosts.slice(0, idx), updated, ...config.hosts.slice(idx + 1)]
  saveConfig(config)
  return updated
}

// Forward-compat: checks persisted sessions for any binding to this host. In
// slice 1, Session has no hostId field yet, so this guard is inert. Slice 2 will
// activate it automatically once sessions start carrying a hostId.
function hasSessionsBoundTo(hostId: HostId): boolean {
  if (!existsSync(SESSIONS_PATH)) return false
  try {
    const raw = readFileSync(SESSIONS_PATH, 'utf-8')
    const data = JSON.parse(raw) as unknown
    const entries: unknown[] = Array.isArray(data)
      ? data
      : data &&
          typeof data === 'object' &&
          Array.isArray((data as { sessions?: unknown[] }).sessions)
        ? (data as { sessions: unknown[] }).sessions
        : []
    return entries.some((entry) => {
      const session =
        entry && typeof entry === 'object' && 'session' in entry
          ? (entry as { session: unknown }).session
          : entry
      return (
        session !== null &&
        typeof session === 'object' &&
        'hostId' in session &&
        (session as { hostId: unknown }).hostId === hostId
      )
    })
  } catch {
    return false
  }
}

export function deleteHost(hostId: HostId): void {
  if (hasSessionsBoundTo(hostId)) {
    throw new Error('Cannot delete host: sessions are still bound to it')
  }
  const config = getConfig()
  const next = config.hosts.filter((h) => h.hostId !== hostId)
  if (next.length === config.hosts.length) throw new Error('Unknown host')
  config.hosts = next
  saveConfig(config)
}
