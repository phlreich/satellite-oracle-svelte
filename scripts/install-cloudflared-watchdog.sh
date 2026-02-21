#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WATCHDOG_SCRIPT="${WATCHDOG_SCRIPT:-${SCRIPT_DIR}/cloudflared-watchdog.sh}"
UNIT_NAME="${UNIT_NAME:-satellite-oracle-cloudflared-watchdog}"
SERVICE_PATH="/etc/systemd/system/${UNIT_NAME}.service"
TIMER_PATH="/etc/systemd/system/${UNIT_NAME}.timer"
SUDO=""

if [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
fi

if [[ ! -x "${WATCHDOG_SCRIPT}" ]]; then
  chmod +x "${WATCHDOG_SCRIPT}"
fi

$SUDO mkdir -p /etc/systemd/system

$SUDO tee "${SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Satellite Oracle cloudflared watchdog
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=${ROOT_DIR}
ExecStart=${WATCHDOG_SCRIPT}
Environment=COMPOSE_FILE=${ROOT_DIR}/docker-compose.yml
Environment=FAIL_THRESHOLD=5
Environment=MIN_HA_CONNECTIONS=1
Environment=STATE_DIR=/var/lib/satellite-oracle
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF

$SUDO tee "${TIMER_PATH}" >/dev/null <<EOF
[Unit]
Description=Run cloudflared watchdog every minute

[Timer]
OnBootSec=3m
OnUnitActiveSec=1m
Persistent=true

[Install]
WantedBy=timers.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "${UNIT_NAME}.timer"
$SUDO systemctl start "${UNIT_NAME}.service"

echo "Installed systemd timer: ${UNIT_NAME}.timer (system-level)"
