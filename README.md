The skies are busy, we prosper.

## Getting Started

### Prerequisites

- A free account at [space-track.org](https://www.space-track.org/auth/login)
- OpenAI API Key

### Setup Instructions

1. Clone the repository

2. Create a `.env` file by copying the example:

   ```bash
   cp .env.example .env
   ```

3. Fill in your credentials in the `.env` file:
   - EMAIL: Your space-track.org account email
   - PASSWORD: Your space-track.org password
   - OPENAI_API_KEY: Your OpenAI API key

4. Start the application:
   ```bash
   npm i
   npm run dev
   ```

The application should now be running and accessible through your web browser.

## Deployment

This repo is just the app. The production deployment for **phlreich.com** — nginx +
Cloudflare Tunnel, with this app proxied at `/satellite-oracle` alongside other projects
— lives in the private **[phlreich-site](https://github.com/phlreich/phlreich-site)** repo,
which pulls this repo in as a git submodule.

The app is built to live under the `/satellite-oracle` base path. Traffic to the legacy
`satellite-oracle.com` host redirects to `https://phlreich.com/satellite-oracle`.

> Note: the build inlines `OPENAI_API_KEY` (and other `$env/static/private` vars) at
> build time, so a populated `.env` must be present in the build context when the image
> is built.

## Application Overview

Once the application is running, you will see a visualization of the Earth with human-made objects orbiting it in real time. This provides a dynamic view of satellites and other objects in space.

## Using the Chat Interface

The application includes a chat interface that allows you to filter and interact with the objects in orbit. You can use natural language queries to filter the objects based on various criteria. For example, you can type:

- "Show me all objects launched by NASA in 2020"

This will filter the displayed objects to only those that match your query, providing a powerful tool for exploring the data.

## Operations (self-hosting)

Two optional systemd installers ship in `scripts/` for headless (e.g. Raspberry Pi) deployments:

- `./scripts/install-logger.sh` — system-level timer that writes Docker container CPU/IO
  stats plus host metrics (`uptime`, `df -h`, `free -h`, `docker system df`, top processes,
  …) to `logs/docker-stats-YYYY-MM-DD.log` every minute. Configurable via `LOGGER_SCRIPT`,
  `LOG_DIR`, `UNIT_NAME` env vars.
- `./scripts/install-cloudflared-watchdog.sh` — checks cloudflared liveness via its
  Prometheus metrics (`cloudflared_tunnel_ha_connections` at `http://127.0.0.1:20241/metrics`)
  and restarts `nginx` + `cloudflared` if HA connections stay below threshold.

Both require `systemd`/`systemctl` (use `sudo`), install under `/etc/systemd/system`, and are
verifiable with `systemctl status <unit>.timer` / `journalctl -u <unit>.service`. Disable with
`systemctl disable --now <unit>.timer` and remove the unit files.

## Architecture & design

See [`DESIGN.md`](./DESIGN.md) for the architecture map, AI-assist runtime, scene/UI behavior,
visual design language, dev/ops reference, known issues, and the manual test-query corpus.
