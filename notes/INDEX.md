# Satellite Oracle Svelte KB

Last Updated: 2026-02-07
Repo: `/home/phlreich/satellite-oracle-svelte`

## Start Here
- `00-current-truth.md`
- `07-notes-maintenance-protocol.md`

## Status Snapshot
- Branch head is `9bf52a0`.
- `/api/assist` uses a direct multi-tool Responses loop.
- Runtime supports SQL analysis + scene visibility updates + scene focus updates in one turn.
- Dev logs now capture full assist payloads while `logs/assist/*.md` keeps readable compact traces.
- Refresh now uses build-and-swap DB rotation (`satellite.next.db` -> `satellite.db`).
- Dev startup skips rebuild/API refresh when live DB tables are already populated.
- Oracle UI now uses monochrome industrial styling with a typed thinking-status indicator during pending assist.

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

## Commit Gate
Follow `07-notes-maintenance-protocol.md`.
