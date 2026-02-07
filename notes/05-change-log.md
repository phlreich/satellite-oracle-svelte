# Change Log

Last Updated: 2026-02-07

## 2026-02-07
- `6234a6a` Add dual observability mode: full-fidelity dev logging for OpenAI/tool payloads and compact human-readable assist trace markdown output.
- `56069e7` Make assistant focus robust in UI by auto-adding hidden target NORAD IDs before retrying focus and surfacing failures.
- `1f8b028` Replace regex SQL screening with SQLite authorizer-based read-only guard, add single-statement tail checks, and cap `sql_select` results.
- `a1157d5` Skip full startup rebuild in dev when DB is already populated and add database swap smoke test.
- `33c7870` Refactor refresh pipeline to build `satellite.next.db` and atomically swap into `satellite.db`; assistant now opens DB per request.

## 2026-02-06
- `88dd99f` Fix DISCOS sparse fieldsets to include requested relationships (`launch`, `operators`, `states`) and prevent startup `include:conflict` 400s.
- `f09505a` Add DISCOS nightly enrichment baseline (new tables, ingest module, refresh wiring, and tests).
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
