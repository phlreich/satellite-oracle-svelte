#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.yml}"
CLOUDFLARED_SERVICE="${CLOUDFLARED_SERVICE:-cloudflared}"
NGINX_SERVICE="${NGINX_SERVICE:-nginx}"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:20241/metrics}"
MIN_HA_CONNECTIONS="${MIN_HA_CONNECTIONS:-1}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-5}"
STATE_DIR="${STATE_DIR:-/var/lib/satellite-oracle}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/cloudflared-watchdog.state}"

log() {
  echo "[$(date -Is)] cloudflared-watchdog: $*"
}

load_fail_count() {
  FAIL_COUNT=0
  if [[ -f "${STATE_FILE}" ]]; then
    local value
    value="$(awk -F= '/^fail_count=/{print $2; exit}' "${STATE_FILE}" 2>/dev/null || true)"
    if [[ "${value:-}" =~ ^[0-9]+$ ]]; then
      FAIL_COUNT="${value}"
    fi
  fi
}

save_state() {
  local result="$1"
  mkdir -p "${STATE_DIR}"
  printf 'fail_count=%s\nlast_check=%s\nlast_result=%s\n' \
    "${FAIL_COUNT}" "$(date -Is)" "${result}" > "${STATE_FILE}"
}

container_id_for_service() {
  local service="$1"
  docker compose -f "${COMPOSE_FILE}" ps -q "${service}" 2>/dev/null || true
}

is_running() {
  local container_id="$1"
  [[ -n "${container_id}" ]] || return 1
  [[ "$(docker inspect -f '{{.State.Running}}' "${container_id}" 2>/dev/null || true)" == "true" ]]
}

restart_stack() {
  log "restarting services: ${NGINX_SERVICE} ${CLOUDFLARED_SERVICE}"
  docker compose -f "${COMPOSE_FILE}" up -d "${NGINX_SERVICE}" "${CLOUDFLARED_SERVICE}" >/dev/null
}

record_success() {
  local ha_connections="$1"
  if (( FAIL_COUNT > 0 )); then
    log "healthy again (ha_connections=${ha_connections}); clearing fail_count=${FAIL_COUNT}"
  fi
  FAIL_COUNT=0
  save_state "ok"
}

record_failure() {
  local reason="$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  log "failure ${FAIL_COUNT}/${FAIL_THRESHOLD}: ${reason}"
  if (( FAIL_COUNT >= FAIL_THRESHOLD )); then
    restart_stack
    FAIL_COUNT=0
    save_state "restarted"
    log "restart completed after repeated failures"
  else
    save_state "fail"
  fi
}

main() {
  if ! command -v docker >/dev/null 2>&1; then
    log "docker not found"
    exit 1
  fi

  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    log "compose file not found: ${COMPOSE_FILE}"
    exit 1
  fi

  load_fail_count

  local cloudflared_id nginx_id metrics ha_connections
  cloudflared_id="$(container_id_for_service "${CLOUDFLARED_SERVICE}")"
  nginx_id="$(container_id_for_service "${NGINX_SERVICE}")"

  if ! is_running "${cloudflared_id}"; then
    record_failure "${CLOUDFLARED_SERVICE} container is not running"
    exit 0
  fi

  if ! is_running "${nginx_id}"; then
    record_failure "${NGINX_SERVICE} container is not running"
    exit 0
  fi

  metrics="$(docker exec "${nginx_id}" wget -qO- "${METRICS_URL}" 2>/dev/null || true)"
  if [[ -z "${metrics}" ]]; then
    record_failure "unable to read cloudflared metrics at ${METRICS_URL}"
    exit 0
  fi

  ha_connections="$(printf '%s\n' "${metrics}" | awk '$1=="cloudflared_tunnel_ha_connections"{print $2; exit}')"
  if [[ -z "${ha_connections}" ]]; then
    record_failure "metric cloudflared_tunnel_ha_connections is missing"
    exit 0
  fi

  if awk -v current="${ha_connections}" -v required="${MIN_HA_CONNECTIONS}" 'BEGIN {exit !((current+0) >= (required+0))}'; then
    record_success "${ha_connections}"
    exit 0
  fi

  record_failure "ha connections too low (${ha_connections} < ${MIN_HA_CONNECTIONS})"
}

main "$@"
