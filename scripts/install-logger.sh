#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOGGER_SCRIPT="${LOGGER_SCRIPT:-${SCRIPT_DIR}/log-docker-stats.sh}"
LOG_DIR="${LOG_DIR:-${ROOT_DIR}/logs}"
UNIT_NAME="${UNIT_NAME:-satellite-oracle-stats}"
UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
SERVICE_PATH="${UNIT_DIR}/${UNIT_NAME}.service"
TIMER_PATH="${UNIT_DIR}/${UNIT_NAME}.timer"

if [[ ! -x "$LOGGER_SCRIPT" ]]; then
  chmod +x "$LOGGER_SCRIPT"
fi

mkdir -p "$UNIT_DIR" "$LOG_DIR"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; systemd is required for this installer." >&2
  exit 1
fi

if ! systemctl --user status >/dev/null 2>&1; then
  echo "systemd --user is not available. Enable lingering or run a user session." >&2
  exit 1
fi

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Satellite Oracle docker stats logger

[Service]
Type=oneshot
WorkingDirectory=${ROOT_DIR}
Environment=LOG_DIR=${LOG_DIR}
ExecStart=${LOGGER_SCRIPT}
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

cat > "$TIMER_PATH" <<EOF
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

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}.timer"

echo "Installed systemd timer: ${UNIT_NAME}.timer"
