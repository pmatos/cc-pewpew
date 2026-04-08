#!/usr/bin/env bash
# Called by Claude Code hooks — reads event JSON from stdin,
# forwards to cc-pewpew orchestrator via Unix socket.

set -euo pipefail

INPUT=$(cat)
CC_PEWPEW_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cc-pewpew"
SOCKET=$(cat "$CC_PEWPEW_DIR/socket-path" 2>/dev/null || echo "")
if [ -z "$SOCKET" ] || [ ! -S "$SOCKET" ]; then
  exit 0  # cc-pewpew not running, silently ignore
fi

EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Map CC hook events to our RPC methods
case "$EVENT_NAME" in
  SessionStart)   METHOD="session.start" ;;
  Stop)           METHOD="session.stop" ;;
  PostToolUse)    METHOD="session.activity" ;;
  SessionEnd)     METHOD="session.end" ;;
  Notification)   METHOD="session.notification" ;;
  *)              exit 0 ;;
esac

PAYLOAD=$(jq -cn \
  --arg method "$METHOD" \
  --argjson params "$INPUT" \
  '{"jsonrpc":"2.0","method":$method,"params":$params,"id":null}')

echo "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" >/dev/null 2>/dev/null || true
