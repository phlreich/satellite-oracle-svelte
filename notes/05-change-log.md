# Change Log

Last Updated: 2026-02-10

## 2026-02-10

- `58032a9` Refresh and expand repository notes baseline.
- Sync notes to current head (`58032a9`) and fix dev route bearings (`/oracle` in dev vs `/satellite-oracle/oracle` in production).
- Record that backend `historyMessages` `[tool-history]` output is currently not appended by Oracle UI.
- Replace single-sample render extrapolation with delayed two-sample Hermite interpolation (`previous` + `current`) for smoother satellite motion.
- Rotate worker traversal start offsets each loop to remove stable “early index gets fresher updates” bias.
- Extend motion debug overlay with interpolation-health metrics (`interp`, `extrap`, `hold`, `current`, `missing`, `clamped`) and support `?debugMotion` in production.
- `b439ba3` Commit scene smoothing + debug metric updates and resync note head snapshots.

## 2026-02-08

- `951c4cd` Add `set_visibility_sql` fast path, round-aware tool gating, and one-hop action completion for obvious requests.
- `951c4cd` Restrict assistant SQL to `semantic_*` views via authorizer checks and add semantic view creation in DB init/build.
- `951c4cd` Remove `sql_select` hard row cap and tighten default loop budgets (`MAX_TOOL_ROUNDS=3`, SQL analysis budget `2`).
- `951c4cd` Filter hidden tool-history messages from outbound chat payloads to reduce prompt bloat.
- `951c4cd` Add Vitest global no-network guard (`tests/setup/no-network.ts`) and align assist/sql guard tests with semantic views.
- `951c4cd` Add manual query corpus in `notes/10-test-queries.md` for complex DISCOS-driven prompts.

## 2026-02-07

- `9bf52a0` Add typewriter thinking indicator with shuffled status phrases, graceful stop, and shared loader/chat cursor cadence.
- `66de02e` Restyle app and oracle UI to a stripped monochrome industrial look and simplify loading screen.
- Fix scene visibility updates so hiding the selected satellite also removes its orbit track.
- `97cb9d6` Add repository notes baseline (`notes/`) with current-truth, runbook, risks, and maintenance protocol.
- `6234a6a` Add dual observability mode with full-fidelity dev logging and compact human-readable assist traces.
- `56069e7` Make assistant focus robust in UI by auto-adding hidden target NORAD IDs before retrying focus and surfacing failures.
- `1f8b028` Replace regex SQL screening with SQLite authorizer-based read-only guard and single-statement tail checks.
- `a1157d5` Skip full startup rebuild in dev when DB is already populated and add database swap smoke test.
- `33c7870` Refactor refresh pipeline to build `satellite.next.db` and atomically swap into `satellite.db`.

## 2026-02-06

- `88dd99f` Fix DISCOS sparse fieldsets to include requested relationships and prevent startup `include:conflict` 400s.
- `f09505a` Add DISCOS nightly enrichment baseline (tables, ingest module, refresh wiring, and tests).
- `12749b1` Move DISCOSweb v2 OpenAPI spec to `docs/discosweb/openapi-v2.yml`.
- `03a1b33` Add full assist trace logging for requests, tools, and SQL.
- `d30b495` Replace planner stack with direct assist tool loop.
- `9fc6425` Aggressively simplify assist/runtime and remove fallback scaffolding.
- `ce7ca34` Remove assist result caps and dead response-thread state.
- `7c1a87f` Remove ad-hoc query API and SQL parser dependency.
- `65cd038` Prune legacy endpoints, dead modules, and unused assets.
- `579926d` Refactor assist pipeline with structured logging and safer selection.
- `3d5b205` Split planner/executor and move runtime to `catalog_v2` path.
- `e14b4ec` Add assist runtime and route regression tests.
