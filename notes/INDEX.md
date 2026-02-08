# Satellite Oracle Svelte KB

Last Updated: 2026-02-08
Repo: `/home/phlreich/satellite-oracle-svelte`

## Start Here
- `00-current-truth.md`
- `07-notes-maintenance-protocol.md`

## Status Snapshot
- Branch head is `951c4cd`.
- `/api/assist` uses a direct Responses loop with round-aware tool exposure.
- Fast path `set_visibility_sql` can apply visibility/orbits/focus plus assistant text in one call.
- Assistant SQL is restricted to `semantic_*` views.
- Runtime no longer hard-caps `sql_select` rows.
- Dev logs capture full payloads while `logs/assist/*.md` keeps compact readable traces.
- Refresh uses build-and-swap DB rotation (`satellite.next.db` -> `satellite.db`).
- Dev startup skips rebuild/API refresh when live DB tables are already populated.

## Fast Bearings
1. `git rev-parse --short HEAD` and `git status --short`.
2. `npm run dev`.
3. Load `/satellite-oracle/oracle`.
4. Inspect latest log via `ls -1t logs/dev-*.log | head -n 1`.

## Read By Task
- Architecture: `01-system-map.md`
- Dev commands: `02-dev-runbook.md`
- UI/scene details: `03-ui-scene-navigation.md`
- Risks: `04-known-issues.md`
- History: `05-change-log.md`
- Visual design: `09-design.md`
- Manual query checks: `10-test-queries.md`

## Commit Gate
Follow `07-notes-maintenance-protocol.md`.
