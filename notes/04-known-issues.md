# Known Issues and Risks

Last Updated: 2026-02-10

- WSL screenshot automation can be misleading; trust manual browser checks.
- Chat UI is hidden on mobile user agents (`isMobileView`), so mobile users currently lose assistant controls.
- UI/scene integration test coverage is still limited.
- Assist tool loops can still run multiple model hops and increase latency on complex prompts.
- `sql_select` now returns uncapped row sets, which can increase memory usage and followup payload size.
- Semantic-view-only SQL guard blocks raw table reads, so missing semantic columns can stall model analysis until views are updated.
- SQLite SQL authorization currently relies on `node:sqlite`, which is still marked experimental in Node 24.
- Assistant may still claim focus success even when a target NORAD cannot be added/focused; UI appends a failure note when this occurs.
- Thinking indicator can remain visible slightly after response arrival until typing/erasing phase completes.
- Large visibility and orbit updates still send large NORAD ID arrays to the client.
- Full assist tracing logs include raw messages, prompts, tool args, and SQL text.
- Dev full assist logs intentionally include raw OpenAI payloads and can expose sensitive text while growing quickly.
- Nightly DISCOS refresh currently reloads full enrichment tables and depends on external API availability and rate limits.
- Dev startup may intentionally skip external refresh when tables are already populated, so stale local data can persist until scheduled or manual refresh.
- Build-and-swap refresh doubles temporary disk usage while `satellite.next.db` is being built.
- Startup initialization failures are logged but not process-fatal, so degraded behavior can surface later at request time.
- Root and `/oracle` route duplication adds avoidable complexity.
- Visibility updates that hide the selected satellite clear selection and orbit immediately, which can feel abrupt in the panel.
- Motion smoothing renders at a fixed delay (`~225ms`) to improve continuity, so displayed positions intentionally lag freshest propagated state.
