# System Map

Last Updated: 2026-02-08

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
- `src/lib/server/assist/assistant.ts`: direct tool loop, SQL execution, fast-path scene action synthesis, and assist trace writing.
- `src/lib/server/assist/sqlGuard.ts`: read-only SQL validation and semantic-view-only authorizer guard.
- `src/lib/server/database.server.ts`: CSV/discos ingest, prune, semantic view creation, and scene-data export.
- `src/routes/oracle/+page.svelte`: sends chat+scene context, applies scene actions, and omits hidden tool-history messages from outbound assist payloads.
- `src/routes/+page.svelte`: root route wrapper that renders oracle page directly.
- `src/lib/scene.ts`: visibility application and camera focus behavior.

## Assist Request Flow
1. UI sends `{ messages, sceneContext }`.
2. `sceneContext` includes selected NORAD, visible count, and a condensed selected-info panel string.
3. Server waits for startup initialization, then calls Responses API with tool set for round 0.
4. Model may call SQL/action tools; `sql_select` is available only before the final round.
5. Server applies tool outputs into one deterministic scene action payload.
6. Server may return early after round 0 fast actions without a followup model call.
7. UI applies `action.visibility`, `action.orbits`, and/or `action.focus`.

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
- Raw tables in active use: `gp`, `satcat`, `boxscore`, `discos_objects`, `discos_object_entities`.
- Semantic views for assist SQL: `semantic_gp`, `semantic_satcat`, `semantic_boxscore`, `semantic_discos_objects`, `semantic_discos_object_entities`.
- Scene artifact source remains join-backed export to `src/data/scene-data.json` (+ `.gz`).
