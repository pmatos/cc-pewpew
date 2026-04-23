import { posix } from 'path'
import type { ExecResult } from './host-connection'

export const NOTIFY_SCRIPT_VERSION = 1

const REQUIRED_DEPS = ['tmux', 'git', 'jq', 'socat', 'claude'] as const

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

export interface HostBootstrapResult {
  notifyScriptPath: string
  remoteSocketPath: string
}

const bootstrapped = new Map<string, HostBootstrapResult>()

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

  const depProbe =
    'missing=""; for dep in "$@"; do command -v "$dep" >/dev/null 2>&1 || missing="$missing $dep"; done; printf "%s\\n" "$missing"'
  const deps = await connection.exec(['sh', '-c', depProbe, '_', ...REQUIRED_DEPS], {
    timeoutMs: 15000,
  })
  await expectOk(deps, 'missing-deps', 'Dependency probe failed')
  const missingDeps = deps.stdout.trim().split(/\s+/).filter(Boolean)
  if (missingDeps.length > 0) {
    throw new HostBootstrapError(
      'missing-deps',
      `Remote host is missing required tools: ${missingDeps.join(', ')}`,
      missingDeps
    )
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

  const home = await connection.exec(['sh', '-c', 'printf "%s" "$HOME"'], { timeoutMs: 5000 })
  await expectOk(home, 'install-failed', 'Unable to resolve remote HOME')
  const remoteHome = home.stdout.trim()
  if (!remoteHome.startsWith('/')) {
    throw new HostBootstrapError('install-failed', 'Remote HOME is not an absolute path')
  }

  const hooksDir = posix.join(remoteHome, '.config', 'cc-pewpew', 'hooks')
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

  const result = { notifyScriptPath, remoteSocketPath }
  bootstrapped.set(hostId, result)
  return result
}
