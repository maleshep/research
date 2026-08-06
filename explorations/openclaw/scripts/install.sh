#!/usr/bin/env bash
# Install OpenClaw + the official WhatsApp plugin on Windows.
#
# Security: only installs official @openclaw/whatsapp from ClawHub.
# Does NOT install any community skills — Cisco found a third-party ClawHub
# skill doing prompt injection + data exfiltration.
#
# Windows notes:
# - The bash installer at openclaw.ai/install.sh is macOS/Linux only. Use
#   the PowerShell installer at openclaw.ai/install.ps1 instead.
# - The ClawHub plugin install fails with SELF_SIGNED_CERT_IN_CHAIN on the
#   corporate proxy. Set NODE_TLS_REJECT_UNAUTHORIZED=0 to work around it.
# - After install, the WhatsApp plugin needs a peer-link junction to the
#   global openclaw install (Windows symlinks require admin/developer mode,
#   so use a junction instead).

set -euo pipefail

echo "=== Installing OpenClaw (PowerShell installer) ==="
powershell.exe -NoProfile -Command "iwr -useb https://openclaw.ai/install.ps1 | iex"

echo ""
echo "=== Verifying install ==="
if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw not on PATH after install" >&2
  echo "You may need to open a new shell, or add the install dir to PATH." >&2
  exit 1
fi
openclaw --version

echo ""
echo "=== Installing @openclaw/whatsapp plugin (official, from ClawHub) ==="
NODE_TLS_REJECT_UNAUTHORIZED=0 openclaw plugins install clawhub:@openclaw/whatsapp

echo ""
echo "=== Creating peer-link junction (Windows symlink workaround) ==="
PEER_LINK="C:\\Users\\M316235\\.openclaw\\extensions\\whatsapp\\node_modules\\openclaw"
GLOBAL_OPENCLAW="C:\\Users\\M316235\\AppData\\Local\\Node\\node_modules\\openclaw"
if [ ! -e "$PEER_LINK" ]; then
  powershell.exe -NoProfile -Command "New-Item -ItemType Junction -Path '$PEER_LINK' -Target '$GLOBAL_OPENCLAW' | Out-Null"
  echo "Junction created."
else
  echo "Peer link already exists at $PEER_LINK"
fi

echo ""
echo "=== Verifying plugin smoke check ==="
NODE_TLS_REJECT_UNAUTHORIZED=0 openclaw plugins inspect whatsapp --runtime --json | head -5

echo ""
echo "=== Done. Next steps: ==="
echo "1. scripts/fleet-port.sh    # confirm GLM-Vision port"
echo "2. scripts/tunnel.sh &       # open SSH tunnel in background"
echo "3. cp config/openclaw.json ~/.openclaw/openclaw.json  # then edit port + phone"
echo "4. openclaw channels login --channel whatsapp  # scan QR (needs NODE_TLS_REJECT_UNAUTHORIZED=0)"
echo "5. scripts/start.sh          # start gateway"
