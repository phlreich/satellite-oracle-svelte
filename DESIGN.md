# Design

Single design + architecture reference for the Satellite Oracle app. Consolidates what
was previously a `notes/` knowledge base. Code is the source of truth; this captures the
non-obvious decisions and gotchas behind it.

## Identity

Industrial space. A ground-station terminal that happens to be on the web. Serious but
visually unusual — distinctive through restraint and rawness, not decoration. Not a video
game, not a SaaS dashboard. The app renders Earth with human-made objects in orbit in real
time, and a chat interface filters/focuses them via natural-language queries.

## Stack

- SvelteKit 2 + Svelte 5 + Vite
- Three.js + satellite.js for the 3D scene and orbit propagation
- SQLite via `better-sqlite3` (assist SQL guard uses `node:sqlite`'s authorizer)
- OpenAI Responses API tool loop

## Architecture

### Runtime skeleton
- `src/app.html` — inline loading screen + shared cursor-blink CSS variable (instant first paint).
- `src/hooks.server.ts` — startup DB/cache init, scheduling, request logging.
- `src/routes/api/assist/+server.ts` — request validation + assist orchestration entry.
- `src/routes/data/scene-data.json/+server.ts` — serves `scene-data.json`; `503` when the artifact is unavailable.
- `src/lib/server/assist/assistant.ts` — tool loop, SQL execution, fast-path scene-action synthesis, assist trace writing.
- `src/lib/server/assist/sqlGuard.ts` — read-only SQL validation + semantic-view-only authorizer guard.
- `src/lib/server/database.server.ts` — CSV/DISCOS ingest, prune, semantic-view creation, scene-data export.
- `src/routes/oracle/+page.svelte` — sends chat + scene context, applies scene actions.
- `src/routes/+page.svelte` — root wrapper that renders the oracle page directly (`/` and `/oracle` are tightly coupled).
- `src/lib/scene.ts` — visibility application and camera focus.

### Startup gating
- Dev startup fires an internal `/health` warmup so DB init begins before the first browser visit.
- `/api/assist` and `/data/scene-data.json` both `waitForStartupInitialization()` before serving.
- Startup init failures are logged and swallowed (not process-fatal), so degraded behavior can surface later at request time.

### Database shape
- Raw tables: `gp`, `satcat`, `boxscore`, `discos_objects`, `discos_object_entities`.
- Semantic views for assist SQL: `semantic_gp`, `semantic_satcat`, `semantic_boxscore`,
  `semantic_discos_objects`, `semantic_discos_object_entities` — clearer column names without
  migrating raw tables; steers the model toward human-readable fields (e.g. `launch_site_name`).
- Scene artifact is a join-backed export to `src/data/scene-data.json` (+ `.gz`).
- Refresh uses build-and-swap rotation: build `satellite.next.db`, then atomically swap into
  `satellite.db` (temporarily doubles disk usage during the build).

## AI Assist Runtime

A single `/api/assist` Responses API tool loop with round-aware tool gating.

### Tools
- `set_visibility_sql` — fast path: run one SELECT, extract NORAD IDs, apply visibility
  directly; optional orbit/focus updates and `assistant_message` in the same call.
- `sql_select` — analysis SELECT returning `result_ref`, row count, columns, preview + sample rows.
- `set_visibility_from_result` / `set_visibility` — apply visibility from result rows or explicit IDs.
- `set_orbits_from_result` / `set_orbits` — orbit overlays from result rows or explicit IDs.
- `set_focus` — camera focus to Earth or one NORAD target.

The server validates tool args and applies a single deterministic scene-action payload
(`action.visibility` / `action.orbits` / `action.focus`).

### SQL guard
- SQL is normalized and validated as a single read-only statement.
- A SQLite authorizer allows reads only through `semantic_*` views (plus internal `sqlite_*`).
  It distinguishes direct table reads from view-expansion reads (`triggerOrView`), so raw
  tables are reachable only when routed through semantic views. Missing semantic columns can
  stall model analysis until the views are updated.
- `node:sqlite`'s `DatabaseSync#prepare` only compiles the first statement — check
  `statement.sourceSQL` tail to reject extra statements in one tool call. (`node:sqlite` is
  still experimental in Node 24.)

### Round budgeting and fast return
- Max `3` tool rounds per request.
- `sql_select` analysis budget is `2` calls; it is unavailable in the last model round.
- If round 0 contains only successful fast-action tools with no `sql_select`, the runtime
  returns immediately without a followup model call.
- If a tool provides `assistant_message`, it can serve as final assistant text when model
  `output_text` is empty.

### Limits
- End-to-end latency is usually dominated by upstream model time (a `show debris` run was
  18.6s total but only 29ms of local SQL — the rest was OpenAI response/queue time).
- Uncapped `sql_select` result sets can grow memory and followup payload size.
- The model can pick weak SQL for ambiguous prompts (e.g. over-broad country predicates).
- Server returns a compact `[tool-history]` `historyMessages` payload, but the Oracle UI does
  not yet append it, so cross-turn tool-history continuity is currently inactive.

## Scene, Motion & UI

- Scene click selects + focuses a satellite; panel arrows cycle visible satellites with wraparound.
- Motion uses delayed two-sample Hermite interpolation (`previous` + `current`) with rotating
  worker-traversal offset each loop to remove "early index is fresher" bias. This renders at a
  fixed delay (~225ms), so visuals are steadier but intentionally lag freshest propagation.
- Motion debug overlay: on by default in dev; append `?debugMotion` in production. Reports
  visible/ready counts, stale update age, per-worker loop timing, and interpolation-health
  counters (`interp`/`extrap`/`hold`/`missing`/`clamped`). When `stale > 2×workerUpdateInterval`,
  extrapolation is clamped (freeze-then-jump risk).
- Focus: `focusEarth()` clears tracked state; `focusVisibleNoradId()` focuses only if visible.
  If the assistant returns focus for a hidden NORAD with no visibility action, the UI tries one
  `add` before retrying. When switching selection programmatically, clear old tracking first
  (`trackTarget = undefined`, `previousSatellitePosition = undefined`) or the camera lerps wrong.
- Orbit tracking is independent of point visibility: when a selected satellite becomes hidden,
  clear selection tracking and `stopOrbitTracking()` or stale orbit lines persist.
- Orbit overlays: tag worker requests `focus` vs `overlay` (one live focused orbit + many static
  overlays). Per-orbit draw calls are the FPS bottleneck at constellation scale; batch overlay
  segments into one `THREE.LineSegments` mesh.
- Chat send is Enter-driven and disabled while assist is pending. Chat is currently hidden on
  mobile user agents (`isMobileView`), disabling assistant controls on mobile.
- Thinking indicator: typewriter loop, phases `cursor → typing → holding → erasing`. Graceful
  stop defers only during `typing`/`erasing`. Cursor cadence shares `--cursor-blink-duration`
  with the loading screen.

## Visual Design Language

- **Font:** `Consolas, 'Courier New', 'Liberation Mono', monospace` everywhere.
- **Background:** `#000` flat black. **Text:** white primary, `rgba(255,255,255,0.4–0.7)` secondary.
- **Borders:** `1px solid white` (panels), `1px solid rgba(255,255,255,0.4)` (inputs/buttons at rest).
  Border radius `0` everywhere. Hover/active: border + text → full white, background `#232121`.
- **Panels:** background `rgba(0,0,0,0.9)`; no box shadows, no gradients.
- **Layout:** full-viewport `<canvas>` with floating overlay panels at viewport edges — no header,
  nav, sidebar, or chrome. Chat bottom-right (resizable via invisible border drag zones); satellite
  info bottom-left (name + coordinates + prev/next). The void around elements is intentional.
- **Messages:** no colored fills — differentiate by structure. Assistant: left-border
  `2px rgba(255,255,255,0.2)`, bg `rgba(255,255,255,0.03)`. User: right-border `2px rgba(255,255,255,0.5)`,
  bg `rgba(255,255,255,0.06)`, right-aligned.
- **Labels/buttons:** uppercase, letter-spaced (`0.1–0.12em`), small, dimmed at rest, bright on hover.
- **Scrollbar:** thin 4px, `rgba(255,255,255,0.25)` thumb, transparent track.
- **3D scene** keeps its own color logic (color as instrument data, not decoration): satellites are
  uniform white points; hover green `(0,1,0)`; selected orbit `0x90ee90` 95%; orbit overlay `0x9de3ff`
  35%; Earth is a photo texture (`earth.webp`, `MeshBasicMaterial`, no lighting).
- **Loading screen:** `INITIALIZING` + blinking block cursor, fades out in 0.6s; inline in `app.html`.
- **Thinking phrases:** shuffled deck of 19 — 14 active (QUERYING CATALOG, PROPAGATING ORBITS,
  CONSULTING THE ORACLE, …) + 5 atmospheric (AWAITING DOWNLINK, REMEMBERING, …). Atmospheric phrases
  are spaced by at least one active phrase. The ambiguous ones (REMEMBERING, INDEXING DISTANCE,
  CENSORING MANIFOLD) should read as purposeful but resist resolution.

### Principles
1. Dim at rest, bright on interaction.
2. Structure over color — differentiate via alignment, borders, spacing, not fills.
3. The void is design — empty space is intentional.
4. Panels are chrome, the scene is data — different visual rules for each.
5. Personality through ambiguity — thinking phrases are the main personality surface.
6. No decoration — every visual element is functional or informational.

## Dev & Ops

### Commands
- `npm run dev` — writes runtime logs to `logs/dev-YYYYMMDD-HHMMSS.log` and streams to terminal.
- `npm run dev:raw`, `npm test`, `npm run check`, `npm run lint`, `npm run build`.

### Dev behavior
- Dev uses an empty base path, so local routes are `/oracle`, `/api/assist`, `/data/scene-data.json`
  (production serves them under `/satellite-oracle/*`).
- `npm run dev` skips full DB rebuild / DISCOS refresh when live tables are already populated, but
  semantic views are always (re)created on startup. To force a full rebuild, clear/replace
  `src/data/satellite.db` before startup.

### Logging controls
- `LOG_LEVEL=debug|warn` — verbosity.
- `ASSIST_LOG_FULL=1|0` — include full OpenAI/tool payloads in dev logs (defaults on outside prod).
- `ASSIST_TRACE=1|0` — write readable markdown traces under `logs/assist/<timestamp>-<requestId>.md`
  (defaults on outside prod). Traces render parsed summaries; dev `*full*` entries keep raw payloads.

### Assist debug loop
1. `npm run dev`, trigger `/api/assist` from the UI.
2. Find the request by `requestId` in the latest dev log (`ls -1t logs/dev-*.log | head -n 1`).
3. Open `logs/assist/<timestamp>-<requestId>.md` for the compact timeline; use `*full*` dev-log
   entries for raw fidelity (`rg " responses.create (request|response) full" logs/dev-*.log`).

### Assist hard limits
- Reject `/api/assist` payloads over `50_000` bytes (`content-length`) or with more than `40` messages.
- Forwarded chat history is trimmed to the last `18` messages.

### Deploy
- Container startup runs `node scripts/start-server-with-warmup.mjs` (internal warmup before traffic).
- `docker compose up -d --build`, then verify `/satellite-oracle/data/scene-data.json` + gzip headers.
- DISCOSweb rate limit: ~`100` requests/min per token (`X-RateLimit-Limit: 100`); honor `429` + `Retry-After`.

## Known Issues & Risks

- Chat hidden on mobile (`isMobileView`) — mobile users lose assistant controls.
- UI/scene integration test coverage is limited; WSL screenshot automation is unreliable (trust manual checks).
- Uncapped `sql_select` rows raise memory + followup payload size; large visibility/orbit updates ship large NORAD arrays to the client.
- Semantic-view-only guard blocks raw-table reads, so missing semantic columns can stall analysis.
- Full assist traces include raw messages, prompts, tool args, and SQL text — sensitive and fast-growing; no log retention/rotation yet (highest-value next move).
- Assistant may claim focus success even when a target can't be added/focused; the UI appends a failure note.
- Nightly DISCOS refresh reloads full enrichment tables and depends on external API availability + rate limits; dev may skip refresh when populated, so stale local data can persist.
- Root + `/oracle` route duplication adds avoidable complexity.

## Data Pipeline Gotchas

- `deleteUnusedRows()` deletes SATCAT rows lacking a non-decayed GP row, then deletes all GP rows
  with a non-null `decay_date`. This leaves `gp`/`satcat` at ~31,913 rows (from 66,199/67,593 CSV
  rows) while `discos_objects` stays ~89,099, so cross-source count mismatches are expected.
- DISCOS operator names can differ from intuition: OneWeb appears as `One Web` (with a space), so
  `entity_name LIKE '%OneWeb%'` returns zero and can make the model wrongly broaden filters.
- `satcat.SITE`/`gp.SITE` are launch-site *codes* (e.g. `TTMTR`, `VOSTO`); human-readable names live
  in `discos_objects.launch_site_name`. Listing only column names often makes the model confuse them.
- Some objects exist in DISCOS but not in GP/SATCAT (decayed), so "visible in orbit now" filters
  legitimately return zero for them (e.g. German debris NORAD `38844`/`44597`, decayed 2014/2020).
- Tests: a global Vitest setup (`tests/setup/no-network.ts`) stubs `fetch` to throw on any unmocked
  call, so accidental external API calls fail fast unless a test explicitly mocks `fetch`.

## Manual Test Queries

Small corpus of high-value prompts with SQL and expected counts against the local DB snapshot
(last revalidated 2026-02-10).

### Q1 — OneWeb Soyuz subset (expect `386`)
> Show only OneWeb commercial-communications payloads still trackable, excluding Falcon 9; restrict to Soyuz-2-1B Fregat launches from Vostochny or Baikonur.
```sql
SELECT COUNT(DISTINCT d.norad_cat_id) AS c
FROM discos_objects d
JOIN gp g ON g.norad_cat_id = d.norad_cat_id
JOIN discos_object_entities op
  ON op.norad_cat_id = d.norad_cat_id AND op.role = 'operator' AND op.entity_type = 'organisation'
WHERE d.object_class = 'Payload'
  AND d.mission = 'Commercial Communications'
  AND d.launch_vehicle_name = 'Soyuz-2-1B Fregat'
  AND d.launch_site_name IN ('Vostochny Cosmodrome', 'Baikonur Cosmodrome (Tyuratam)')
  AND op.entity_name IN (
    'One Web (Network Access Associates Ltd.)', 'One Web',
    'Eutelsat OneWeb (Network Access Associates Ltd.)');
```

### Q2 — US launch + non-US state commercial payloads (expect `53`; largest state `Japan`=`9`)
> Show payloads launched from the US where the owning state is not the US, only Commercial Communications; then focus the largest non-US state group.
```sql
SELECT COUNT(DISTINCT d.norad_cat_id) AS c
FROM discos_objects d
JOIN gp g ON g.norad_cat_id = d.norad_cat_id
JOIN discos_object_entities l
  ON l.norad_cat_id = d.norad_cat_id AND l.role = 'launch' AND l.entity_type = 'country'
JOIN discos_object_entities s
  ON s.norad_cat_id = d.norad_cat_id AND s.role = 'state' AND s.entity_type = 'country'
WHERE d.object_class = 'Payload'
  AND d.mission = 'Commercial Communications'
  AND l.entity_name = 'United States'
  AND s.entity_name != 'United States';
```

### Q3 — GEO-like mission-related Kourou/Xichang (expect `33`)
> Show only mission-related objects with GEO-like period (1300–1600 min), limited to launches from Kourou or Xichang.
```sql
SELECT COUNT(DISTINCT d.norad_cat_id) AS c
FROM discos_objects d
JOIN gp g ON g.norad_cat_id = d.norad_cat_id
WHERE d.object_class IN ('Payload Mission Related Object', 'Rocket Mission Related Object')
  AND g.period BETWEEN 1300 AND 1600
  AND d.launch_site_name IN ('Guiana Space Center (Kourou)', 'Xichang Satellite Launch Center');
```
