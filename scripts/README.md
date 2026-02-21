# Logging setup

This repo ships a small logger that captures container stats plus basic host metrics.

## What it does

- Every minute, writes Docker container CPU/IO stats to `logs/docker-stats-YYYY-MM-DD.log`.
- Appends host `uptime`, `uname -a`, `df -h`, `docker system df`, `docker compose ps`,
  `free -h`, top processes by CPU/memory, `ss -s`, and `systemctl is-system-running`
  output when available.

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

- `LOGGER_SCRIPT` (default: `scripts/log-system-stats.sh`)
- `LOG_DIR` (default: `logs/` inside repo)
- `UNIT_NAME` (default: `satellite-oracle-stats`)

Example:

```
LOG_DIR=/var/log/satellite-oracle ./scripts/install-logger.sh
```

## Cloudflared watchdog

This repo also ships a watchdog that checks cloudflared liveness through its Prometheus metrics endpoint and auto-recovers on prolonged failure.

### Install (systemd, system-level)

```
./scripts/install-cloudflared-watchdog.sh
```

What it does:

- Runs every minute via `satellite-oracle-cloudflared-watchdog.timer`.
- Reads `cloudflared_tunnel_ha_connections` from `http://127.0.0.1:20241/metrics` (via the nginx container namespace).
- If HA connections stay below threshold for repeated checks, restarts `nginx` + `cloudflared` with `docker compose up -d`.

### Verify

```
systemctl status satellite-oracle-cloudflared-watchdog.timer
journalctl -u satellite-oracle-cloudflared-watchdog.service --no-pager -n 50
```

### Uninstall

```
sudo systemctl disable --now satellite-oracle-cloudflared-watchdog.timer
sudo rm -f /etc/systemd/system/satellite-oracle-cloudflared-watchdog.service
sudo rm -f /etc/systemd/system/satellite-oracle-cloudflared-watchdog.timer
sudo systemctl daemon-reload
```
