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
  echo "CMD: docker stats --no-stream --format \"$DOCKER_STATS_FORMAT\""
  mapfile -t targets < <(get_targets)
  if [[ "${#targets[@]}" -eq 0 ]]; then
    docker stats --no-stream --format "$DOCKER_STATS_FORMAT"
  else
    docker stats --no-stream --format "$DOCKER_STATS_FORMAT" "${targets[@]}"
  fi
  if command -v uptime >/dev/null 2>&1; then
    echo "CMD: uptime"
    echo "Host uptime: $(uptime)"
  fi
  if command -v uname >/dev/null 2>&1; then
    echo "CMD: uname -a"
    echo "Host kernel: $(uname -a)"
  fi
  if command -v df >/dev/null 2>&1; then
    echo "CMD: df -h"
    echo "Host disk usage:"
    df -h
  fi
  if command -v docker >/dev/null 2>&1; then
    echo "CMD: docker system df"
    echo "Docker disk usage:"
    docker system df
  fi
  if command -v docker >/dev/null 2>&1 && [[ -f "$COMPOSE_FILE" ]]; then
    echo "CMD: docker compose -f \"$COMPOSE_FILE\" ps"
    echo "Compose services:"
    docker compose -f "$COMPOSE_FILE" ps
  fi
  if command -v free >/dev/null 2>&1; then
    echo "CMD: free -h"
    echo "Host memory:"
    free -h
  fi
  if command -v ps >/dev/null 2>&1; then
    echo "CMD: ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 6"
    echo "Top processes by CPU:"
    ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 6
    echo "CMD: ps -eo pid,comm,%cpu,%mem --sort=-%mem | head -n 6"
    echo "Top processes by memory:"
    ps -eo pid,comm,%cpu,%mem --sort=-%mem | head -n 6
  fi
  if command -v ss >/dev/null 2>&1; then
    echo "CMD: ss -s"
    echo "Network summary:"
    ss -s
  fi
  if command -v systemctl >/dev/null 2>&1; then
    echo "CMD: systemctl is-system-running"
    echo "Systemd health: $(systemctl is-system-running || true)"
  fi
  echo
} >> "$LOG_FILE" 2>&1
