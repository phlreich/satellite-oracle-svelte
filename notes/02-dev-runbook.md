# Dev Runbook

Last Updated: 2026-02-10

## Bearings in 60 Seconds

1. `git rev-parse --short HEAD` and `git status --short` to ground repo state.
2. `npm run dev` and wait for startup logs to settle.
3. Open `/oracle` in dev (`/satellite-oracle/oracle` in production) and verify scene load + chat panel render.
4. `ls -1t logs/dev-*.log | head -n 1` and tail the active log while testing.

## Core Commands

- `npm run dev`
- `npm run dev:raw`
- `npm test`
- `npm run check`
- `npm run lint`
- `npm run build`

## Dev Startup Behavior

- Vite dev sends an internal `/health` warmup request so startup DB initialization begins before first browser visit.
- `npm run dev` writes runtime logs to `logs/dev-YYYYMMDD-HHMMSS.log` and streams the same output to terminal.
- `npm run dev` skips full DB rebuild/DISCOS API refresh when live SQLite tables are already populated.
- Semantic assist views are (re)created on startup even when rebuild is skipped.
- Dev runs with empty base path, so local routes are `/oracle`, `/api/assist`, and `/data/scene-data.json`.
- To force a full rebuild in dev, clear or replace `src/data/satellite.db` before startup.

## Assist Debug Loop

1. Run `npm run dev`.
2. Trigger `/api/assist` from the UI.
3. Open the latest dev log and locate the request by `requestId`.
4. Open `logs/assist/<timestamp>-<requestId>.md` for the compact readable timeline.
5. Use dev log entries ending in `full` for raw OpenAI/tool payload fidelity.

## Test Guardrails

- Vitest setup file `tests/setup/no-network.ts` throws on any unmocked `fetch` call.
- Tests that need network behavior must explicitly mock `fetch`.

## UI Quick Checks

- Pending assist shows one animated thinking line with a blinking cursor.
- Input textarea is disabled while assist is pending.
- If a focus target is hidden, UI tries add-then-focus once before reporting failure.
- On mobile user agents, the chat window is currently hidden by design.
- Motion debug overlay appears in dev by default; in production, append `?debugMotion` to `/satellite-oracle/oracle`.

## Logging Controls

- `LOG_LEVEL=debug` for max detail.
- `LOG_LEVEL=warn` to suppress noisy traces.
- `ASSIST_LOG_FULL=1` to include full OpenAI/tool payload duplicates in dev logs.
- `ASSIST_LOG_FULL=0` to keep only compact summary log lines.
- `ASSIST_TRACE=1` to write readable markdown traces under `logs/assist/`.
- `ASSIST_TRACE=0` to disable markdown trace files.

## Assist Hard Limits

- API rejects `/api/assist` payloads over `50_000` bytes by `content-length`.
- API rejects assist bodies with more than `40` chat messages.
- Runtime trims forwarded chat history to the last `18` messages.
- Runtime allows up to `3` tool rounds per request.
- `sql_select` analysis budget is `2` calls per request, then only action tools are exposed.
- `sql_select` has no hard row cap and may return full result sets.

## Quick Log Queries

- Latest dev log: `ls -1t logs/dev-*.log | head -n 1`
- Latest assist trace: `ls -1t logs/assist/*.md | head -n 1`
- Find one request: `rg "requestId\":\"<id>" logs/dev-*.log`
- Find full payload entries: `rg " responses.create (request|response) full" logs/dev-*.log`
- Find thinking indicator mentions in Oracle UI: `rg "thinking|assistPending" src/routes/oracle/+page.svelte`

## Deploy Loop

- Container startup runs `node scripts/start-server-with-warmup.mjs` and performs internal warmup before external traffic.

1. `docker compose up -d --build`
2. Verify `/satellite-oracle/data/scene-data.json`
3. Verify gzip response headers

## 2026-02-06 DISCOSweb Rate-Limit Probe

- Live probe against `/api/objects?page[size]=1` returned `X-RateLimit-Limit: 100` and `X-RateLimit-Reset` about 60 seconds ahead.
- Treat effective budget as ~100 requests/minute per token and honor `429` + `Retry-After`.
