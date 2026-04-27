import { posix } from 'path'
import type { ExecResult } from './host-connection'
import type { AgentTool } from '../shared/types'

export const NOTIFY_SCRIPT_VERSION = 1

const STRICT_DEPS = ['tmux', 'git', 'jq', 'socat'] as const
const AGENT_DEPS: readonly AgentTool[] = ['claude', 'codex'] as const

const notifyScript = `#!/usr/bin/env bash
# cc-pewpew notify script v${NOTIFY_SCRIPT_VERSION}
CC_PEWPEW_NOTIFY_VERSION=${NOTIFY_SCRIPT_VERSION}
set -euo pipefail

INPUT=$(cat)
CC_PEWPEW_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/cc-pewpew"
SOCKET=$(cat "$CC_PEWPEW_DIR/hooks/socket-path" 2>/dev/null || echo "")
if [ -z "$SOCKET" ] || [ ! -S "$SOCKET" ]; then
  exit 0
fi

EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty')

case "$EVENT_NAME" in
  SessionStart)   METHOD="session.start" ;;
  Stop)           METHOD="session.stop" ;;
  PostToolUse)    METHOD="session.activity" ;;
  SessionEnd)     METHOD="session.end" ;;
  Notification)   METHOD="session.notification" ;;
  *)              exit 0 ;;
esac

PAYLOAD=$(printf '%s' "$INPUT" | jq -c \\
  --arg method "$METHOD" \\
  '{jsonrpc:"2.0",method:$method,params:.,id:null}')

echo "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" >/dev/null 2>/dev/null || true
`

export type HostBootstrapErrorKind = 'missing-deps' | 'stream-local-bind' | 'install-failed'

export class HostBootstrapError extends Error {
  kind: HostBootstrapErrorKind
  missingDeps: string[]

  constructor(kind: HostBootstrapErrorKind, message: string, missingDeps: string[] = []) {
    super(message)
    this.name = 'HostBootstrapError'
    this.kind = kind
    this.missingDeps = missingDeps
  }
}

export interface HostBootstrapConnection {
  exec(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
}

export type AgentAvailability = Record<AgentTool, boolean>

export interface HostBootstrapResult {
  notifyScriptPath: string
  remoteSocketPath: string
  availableAgents: AgentAvailability
}

const bootstrapped = new Map<string, HostBootstrapResult>()

// Called when the SSH target for a host changes (alias edit). Drops the cached
// bootstrap result so the next session re-probes dependencies and reinstalls
// notify hooks on the new endpoint.
export function invalidateBootstrap(hostId: string): void {
  bootstrapped.delete(hostId)
}

async function expectOk(
  result: ExecResult,
  kind: HostBootstrapErrorKind,
  message: string
): Promise<void> {
  if (result.timedOut) throw new HostBootstrapError(kind, `${message}: timed out`)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new HostBootstrapError(kind, `${message}: ${detail}`)
  }
}

export async function bootstrapHost(
  hostId: string,
  connection: HostBootstrapConnection,
  remoteSocketPath: string
): Promise<HostBootstrapResult> {
  const cached = bootstrapped.get(hostId)
  if (cached && cached.remoteSocketPath === remoteSocketPath) return cached

  const allDeps = [...STRICT_DEPS, ...AGENT_DEPS]
  const depProbe =
    'missing=""; for dep in "$@"; do command -v "$dep" >/dev/null 2>&1 || missing="$missing $dep"; done; printf "%s\\n" "$missing"'
  const deps = await connection.exec(['sh', '-c', depProbe, '_', ...allDeps], {
    timeoutMs: 15000,
  })
  await expectOk(deps, 'missing-deps', 'Dependency probe failed')
  const missing = new Set(deps.stdout.trim().split(/\s+/).filter(Boolean))
  const missingStrict = STRICT_DEPS.filter((d) => missing.has(d))
  if (missingStrict.length > 0) {
    throw new HostBootstrapError(
      'missing-deps',
      `Remote host is missing required tools: ${missingStrict.join(', ')}`,
      missingStrict
    )
  }
  const availableAgents: AgentAvailability = {
    claude: !missing.has('claude'),
    codex: !missing.has('codex'),
  }

  const socketProbe = await connection.exec(['sh', '-c', 'test -S "$1"', '_', remoteSocketPath], {
    timeoutMs: 5000,
  })
  if (socketProbe.code !== 0 || socketProbe.timedOut) {
    throw new HostBootstrapError(
      'stream-local-bind',
      `Remote hook socket ${remoteSocketPath} is not available; check StreamLocalBindUnlink and reverse Unix-socket forwarding`
    )
  }

  // Resolve the remote config root the same way notifyScript does
  // (`${XDG_CONFIG_HOME:-$HOME/.config}`), so the breadcrumb we write here is
  // the one the script reads at hook time. Hardcoding $HOME/.config would
  // silently drop events on remotes with XDG_CONFIG_HOME set.
  const configRootProbe = await connection.exec(
    ['sh', '-c', 'printf "%s" "${XDG_CONFIG_HOME:-$HOME/.config}"'],
    { timeoutMs: 5000 }
  )
  await expectOk(configRootProbe, 'install-failed', 'Unable to resolve remote config root')
  const configRoot = configRootProbe.stdout.trim()
  if (!configRoot.startsWith('/')) {
    throw new HostBootstrapError('install-failed', 'Remote config root is not an absolute path')
  }

  const hooksDir = posix.join(configRoot, 'cc-pewpew', 'hooks')
  const notifyScriptPath = posix.join(hooksDir, `notify-v${NOTIFY_SCRIPT_VERSION}.sh`)
  const breadcrumbPath = posix.join(hooksDir, 'socket-path')
  const installScript =
    'set -e\n' +
    'mkdir -p "$1"\n' +
    'if [ ! -f "$2" ] || ! grep -q "CC_PEWPEW_NOTIFY_VERSION=$5" "$2"; then\n' +
    '  printf "%s" "$4" > "$2"\n' +
    '  chmod 700 "$2"\n' +
    'fi\n' +
    'printf "%s\\n" "$3" > "$6"\n'
  const install = await connection.exec(
    [
      'sh',
      '-c',
      installScript,
      '_',
      hooksDir,
      notifyScriptPath,
      remoteSocketPath,
      notifyScript,
      String(NOTIFY_SCRIPT_VERSION),
      breadcrumbPath,
    ],
    { timeoutMs: 15000 }
  )
  await expectOk(install, 'install-failed', 'Unable to install remote notify hook')

  const result: HostBootstrapResult = { notifyScriptPath, remoteSocketPath, availableAgents }
  bootstrapped.set(hostId, result)
  return result
}
