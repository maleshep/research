#!/usr/bin/env bash
# Start the OpenClaw gateway in the foreground.
#
# Preconditions:
# 1. SSH tunnel to GLM-Vision is open (run `scripts/tunnel.sh &` in another terminal).
# 2. Config is at ~/.openclaw/openclaw.json (with port substituted in from config/openclaw.json template).
# 3. WhatsApp pairing is done (creds at ~/.openclaw/credentials/whatsapp/default/).
#
# The gateway needs NODE_TLS_REJECT_UNAUTHORIZED=0 set so baileys can fetch
# the latest WhatsApp Web version through the corporate proxy (which uses a
# self-signed cert that breaks TLS verification).

set -euo pipefail

export NODE_TLS_REJECT_UNAUTHORIZED=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Precondition: is the tunnel up?
PORT=$("$SCRIPT_DIR/fleet-port.sh" 2>/dev/null || true)
if [ -n "$PORT" ]; then
  if curl -s --max-time 2 "http://localhost:$PORT/v1/models" >/dev/null 2>&1; then
    echo "✓ GLM-Vision reachable on localhost:$PORT"
  else
    echo "⚠ GLM-Vision not reachable on localhost:$PORT — is scripts/tunnel.sh running?" >&2
    echo "  Open it in another terminal: scripts/tunnel.sh &" >&2
    read -p "Continue anyway? [y/N] " confirm
    [ "$confirm" = "y" ] || exit 1
  fi
fi

# Precondition: is the config in place?
if [ ! -f ~/.openclaw/openclaw.json ]; then
  echo "✗ ~/.openclaw/openclaw.json not found." >&2
  echo "  Copy config/openclaw.json there first (with port substituted in)." >&2
  exit 1
fi

# Precondition: is the peer-link junction present? (gets invalidated by npm install in plugin dir)
PEER_LINK="C:\\Users\\M316235\\.openclaw\\extensions\\whatsapp\\node_modules\\openclaw"
if [ ! -e "$PEER_LINK" ]; then
  echo "⚠ Peer-link junction missing. Recreating..." >&2
  powershell.exe -NoProfile -Command "New-Item -ItemType Junction -Path '$PEER_LINK' -Target 'C:\\Users\\M316235\\AppData\\Local\\Node\\node_modules\\openclaw' | Out-Null"
fi

echo "Starting OpenClaw gateway (Ctrl+C to stop)..."
exec openclaw gateway
