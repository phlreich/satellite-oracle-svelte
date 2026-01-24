# Logging setup

This repo ships a small logger that captures container stats plus basic host metrics.

## What it does
- Every minute, writes Docker container CPU/IO stats to `logs/docker-stats-YYYY-MM-DD.log`.
- Appends host `uptime` and `free -h` output when available.

## Install (systemd, system-level)
The installer now sets up a **system-level** systemd timer (more reliable for headless Raspberry Pi deployments).

```
./scripts/install-logger.sh
```

Notes:
- Requires `systemd` and `systemctl`.
- Uses `sudo` when needed to write units to `/etc/systemd/system`.
- Removes any prior cron entry for `log-docker-stats.sh` to avoid double logging.

### Verify
```
systemctl status satellite-oracle-stats.timer
journalctl -u satellite-oracle-stats.service --no-pager -n 50
```

### Uninstall
```
sudo systemctl disable --now satellite-oracle-stats.timer
sudo rm -f /etc/systemd/system/satellite-oracle-stats.service
sudo rm -f /etc/systemd/system/satellite-oracle-stats.timer
sudo systemctl daemon-reload
```

## Configuration
These env vars can be set when running the installer or the logger:

- `LOGGER_SCRIPT` (default: `scripts/log-docker-stats.sh`)
- `LOG_DIR` (default: `logs/` inside repo)
- `UNIT_NAME` (default: `satellite-oracle-stats`)

Example:
```
LOG_DIR=/var/log/satellite-oracle ./scripts/install-logger.sh
```
