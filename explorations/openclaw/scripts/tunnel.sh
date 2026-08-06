#!/usr/bin/env bash
# Open an SSH tunnel to the current GLM-Vision port on HPC.
# Reads the port from scripts/fleet-port.sh — no hardcoded port.
# Run in background:   scripts/tunnel.sh &
# Or foreground:        scripts/tunnel.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=$("$SCRIPT_DIR/fleet-port.sh")

SSH_HOST="M316235@onehpc.merckgroup.com"

# Read the node from the serve-state file so we tunnel to the right host
NODE=$(ssh "$SSH_HOST" "cat /shared/project/tdr-mmm-hpc/llm/.serve-state-glm-vision.json" \
       | grep -oE '"node":"[^"]+"' | head -1 | cut -d: -f2 | tr -d '"')

echo "Opening tunnel: localhost:$PORT -> $NODE:$PORT via $SSH_HOST" >&2
echo "Test with: curl -s http://localhost:$PORT/v1/models" >&2
echo "Ctrl+C to close." >&2

exec ssh -L "$PORT:$NODE:$PORT" -N "$SSH_HOST"
