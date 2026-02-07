# System Map

Last Updated: 2026-02-07

## Stack
- SvelteKit 2 + Svelte 5 + Vite 6
- Three.js + satellite.js
- SQLite via `better-sqlite3`
- OpenAI Responses API tool loop

## Runtime Skeleton
- `src/app.html`: inline loading screen and shared cursor blink CSS variable.
- `src/hooks.server.ts`: startup DB/cache init, scheduling, request logging.
- `src/routes/api/assist/+server.ts`: request validation + assist orchestration entry.
- `src/routes/data/scene-data.json/+server.ts`: serves `scene-data.json` and returns `503` when artifact is unavailable.
- `src/lib/server/assist/assistant.ts`: direct tool loop, SQL execution, scene action synthesis, and assist trace writing.
- `src/routes/oracle/+page.svelte`: sends chat+scene context, applies scene actions.
- `src/routes/+page.svelte`: root route wrapper that renders oracle page directly.
- `src/lib/scene.ts`: visibility application and camera focus behavior.

## Assist Request Flow
1. UI sends `{ messages, sceneContext }`.
2. `sceneContext` includes selected NORAD, visible count, and a condensed selected-info panel string.
3. Server waits for startup initialization, then calls Responses API with tools.
4. Model may call SQL/action tools for multiple rounds.
5. Server returns `{ assistantMessage, action }`.
6. UI applies `action.visibility` and/or `action.focus`.

## Startup Gating
- Dev server startup triggers an internal `/health` fetch so DB initialization starts before first browser visit.
- `/api/assist` and `/data/scene-data.json` both call `waitForStartupInitialization()` before serving requests.

## Observability Surfaces
- Dev runtime logs: `logs/dev-YYYYMMDD-HHMMSS.log` from `npm run dev`.
- Readable per-request traces: `logs/assist/<timestamp>-<requestId>.md`.
- Full payload logging toggle: `ASSIST_LOG_FULL` (defaults on outside production).
- Trace markdown toggle: `ASSIST_TRACE` (defaults on outside production).

## UI State Model
- Chat send is Enter-key driven and disabled while assist is pending.
- Pending assist shows a typewriter thinking phrase loop with a blinking cursor.
- Thinking and loader cursor cadence both use `--cursor-blink-duration`.

## DB Shape
- Tables in active use: `gp`, `satcat`, `boxscore`, `discos_objects`, `discos_object_entities`.
- Scene artifact source: join-backed export to `src/data/scene-data.json` (+ `.gz`).
