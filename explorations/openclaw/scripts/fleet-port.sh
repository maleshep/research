#!/usr/bin/env bash
# Print the current GLM-5.2-Vision port from oneHPC fleet state.
# Reads /shared/project/tdr-mmm-hpc/llm/.serve-state-glm-vision.json over SSH.
# Usage:   PORT=$(scripts/fleet-port.sh)
#          echo "GLM-Vision is on port $PORT"

set -euo pipefail

SSH_HOST="M316235@onehpc.merckgroup.com"
STATE_FILE="/shared/project/tdr-mmm-hpc/llm/.serve-state-glm-vision.json"

raw=$(ssh "$SSH_HOST" "cat $STATE_FILE 2>/dev/null")

if [ -z "$raw" ]; then
  echo "ERROR: could not read $STATE_FILE from $SSH_HOST" >&2
  echo "GLM-Vision may not be running. Check:" >&2
  echo "  ssh $SSH_HOST 'squeue -u M316235 | grep glm52v'" >&2
  exit 1
fi

# Extract port (jq if available, else grep)
if command -v jq >/dev/null 2>&1; then
  port=$(echo "$raw" | jq -r '.port')
  node=$(echo "$raw" | jq -r '.node')
  status=$(echo "$raw" | jq -r '.status')
else
  port=$(echo "$raw" | grep -oE '"port":[0-9]+' | head -1 | cut -d: -f2)
  node=$(echo "$raw" | grep -oE '"node":"[^"]+"' | head -1 | cut -d: -f2 | tr -d '"')
  status=$(echo "$raw" | grep -oE '"status":"[^"]+"' | head -1 | cut -d: -f2 | tr -d '"')
fi

if [ -z "$port" ]; then
  echo "ERROR: could not parse port from fleet state" >&2
  echo "Raw: $raw" >&2
  exit 1
fi

# Print port + node + status to stderr for visibility, port only to stdout
echo "GLM-Vision: port=$port node=$node status=$status" >&2
echo "$port"
