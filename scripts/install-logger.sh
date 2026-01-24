#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOGGER_SCRIPT="${LOGGER_SCRIPT:-${SCRIPT_DIR}/log-docker-stats.sh}"
LOG_DIR="${LOG_DIR:-${ROOT_DIR}/logs}"
UNIT_NAME="${UNIT_NAME:-satellite-oracle-stats}"
SERVICE_PATH="/etc/systemd/system/${UNIT_NAME}.service"
TIMER_PATH="/etc/systemd/system/${UNIT_NAME}.timer"
SYSTEMCTL_BIN="$(command -v systemctl || true)"
SUDO=""

if [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
fi

if [[ ! -x "$LOGGER_SCRIPT" ]]; then
  chmod +x "$LOGGER_SCRIPT"
fi

mkdir -p "$LOG_DIR"

if [[ -z "$SYSTEMCTL_BIN" ]]; then
  echo "systemctl not found; systemd is required for this installer." >&2
  exit 1
fi

if systemctl --user status "${UNIT_NAME}.timer" >/dev/null 2>&1; then
  systemctl --user disable --now "${UNIT_NAME}.timer" || true
  rm -f "${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${UNIT_NAME}.service"
  rm -f "${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${UNIT_NAME}.timer"
fi

$SUDO mkdir -p /etc/systemd/system

$SUDO tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=Satellite Oracle docker stats logger

[Service]
Type=oneshot
WorkingDirectory=${ROOT_DIR}
Environment=LOG_DIR=${LOG_DIR}
ExecStart=${LOGGER_SCRIPT}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

$SUDO tee "$TIMER_PATH" >/dev/null <<EOF
[Unit]
Description=Run Satellite Oracle docker stats logger every minute

[Timer]
OnBootSec=2m
OnUnitActiveSec=1m
Persistent=true

[Install]
WantedBy=timers.target
EOF

python - <<'PY'
import subprocess

result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
lines = result.stdout.splitlines() if result.returncode == 0 else []
lines = [line for line in lines if "log-docker-stats.sh" not in line]
payload = "\n".join(lines) + "\n"
subprocess.run(["crontab", "-"], input=payload, text=True, check=True)
PY

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "${UNIT_NAME}.timer"

echo "Installed systemd timer: ${UNIT_NAME}.timer (system-level)"
