#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/home/james/satellite-oracle-svelte/logs"
LOG_FILE="$LOG_DIR/docker-stats-$(date +%F).log"

mkdir -p "$LOG_DIR"

{
  echo "=== $(date -Is) ==="
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}" \
    satellite-oracle-svelte-app-1 \
    satellite-oracle-svelte-nginx-1 \
    satellite-oracle-svelte-cloudflared-1
  echo
} >> "$LOG_FILE"
