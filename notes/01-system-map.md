# System Map

Last Updated: 2026-02-07

## Stack
- SvelteKit 2 + Svelte 5 + Vite 6
- Three.js + satellite.js
- SQLite via `better-sqlite3`
- OpenAI Responses API tool loop

## Runtime Skeleton
- `src/hooks.server.ts`: startup DB/cache init, scheduling, request logging.
- `src/routes/api/assist/+server.ts`: request validation + assist orchestration entry.
- `src/routes/data/scene-data.json/+server.ts`: serves `scene-data.json` and returns `503` when artifact is unavailable.
- `src/lib/server/assist/assistant.ts`: direct tool loop, SQL execution, scene action synthesis, and assist trace writing.
- `src/routes/oracle/+page.svelte`: sends chat+scene context, applies scene actions.
- `src/lib/scene.ts`: visibility application and camera focus behavior.

## Assist Request Flow
1. UI sends `{ messages, sceneContext }`.
2. Server waits for startup initialization, then calls Responses API with tools.
3. Model may call SQL/action tools for multiple rounds.
4. Server returns `{ assistantMessage, action }`.
5. UI applies `action.visibility` and/or `action.focus`.

## Startup Gating
- Dev server startup triggers an internal `/health` fetch so DB initialization starts before first browser visit.
- `/api/assist` and `/data/scene-data.json` both call `waitForStartupInitialization()` before serving requests.

## Observability Surfaces
- Dev runtime logs: `logs/dev-YYYYMMDD-HHMMSS.log` from `npm run dev`.
- Readable per-request traces: `logs/assist/<timestamp>-<requestId>.md`.
- Full payload logging toggle: `ASSIST_LOG_FULL` (defaults on outside production).
- Trace markdown toggle: `ASSIST_TRACE` (defaults on outside production).

## DB Shape
- Tables in active use: `gp`, `satcat`, `boxscore`, `discos_objects`, `discos_object_entities`.
- Scene artifact source: join-backed export to `src/data/scene-data.json` (+ `.gz`).
