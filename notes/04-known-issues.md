# Known Issues and Risks

Last Updated: 2026-02-07

- WSL screenshot automation can be misleading; trust manual browser checks.
- UI/scene integration test coverage is still limited.
- Assist tool loops can run many SQL probes and increase per-request latency.
- `sql_select` still stores result rows in-process per request round (now capped at 5000 rows).
- SQLite SQL authorization currently relies on `node:sqlite`, which is still marked experimental in Node 24.
- Assistant may still claim focus success even when a target NORAD cannot be added/focused; UI now appends a failure note when this occurs.
- Large visibility updates still send large NORAD ID arrays to the client.
- Full assist tracing logs include raw messages, prompts, tool args, and SQL text.
- Dev full assist logs now intentionally include raw OpenAI payloads and can expose sensitive text while growing quickly.
- Nightly DISCOS refresh currently reloads full enrichment tables and depends on external API availability/rate limits.
- Dev startup may intentionally skip external refresh when tables are already populated, so stale local data can persist until scheduled/manual refresh.
- Build-and-swap refresh doubles temporary disk usage while `satellite.next.db` is being built.
- Startup initialization failures are logged but not process-fatal, so degraded behavior can appear later at request time.
- Root and `/oracle` route duplication adds avoidable complexity.
