#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${LOG_DIR:-${ROOT_DIR}/logs}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/docker-stats-$(date +%F).log}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.yml}"

if [[ -z "${DOCKER_STATS_FORMAT:-}" ]]; then
  DOCKER_STATS_FORMAT=$'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}'
fi

get_targets() {
  if [[ -f "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" ps -q || true
  fi
}

mkdir -p "$LOG_DIR"

{
  echo "=== $(date -Is) ==="
  mapfile -t targets < <(get_targets)
  if [[ "${#targets[@]}" -eq 0 ]]; then
    docker stats --no-stream --format "$DOCKER_STATS_FORMAT"
  else
    docker stats --no-stream --format "$DOCKER_STATS_FORMAT" "${targets[@]}"
  fi
  if command -v uptime >/dev/null 2>&1; then
    echo "Host uptime: $(uptime)"
  fi
  if command -v free >/dev/null 2>&1; then
    echo "Host memory:"
    free -h
  fi
  echo
} >> "$LOG_FILE" 2>&1
