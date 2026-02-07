# Current Truth

Last Updated: 2026-02-07
Repo: `/home/phlreich/satellite-oracle-svelte`
Head Commit: `6234a6a`

## What Works Now
- `/api/assist` runs a direct Responses API tool loop with no planner/executor split.
- `npm run dev` now writes timestamped dev logs automatically to `logs/dev-YYYYMMDD-HHMMSS.log`.
- Dev assist logs now include full-fidelity OpenAI requests/responses and tool payloads (`ASSIST_LOG_FULL`, default on outside production).
- Assist traces now write to `logs/assist/*.md` with a readable step timeline and collapsible details.
- `sql_select` still enforces read-only SQL with SQLite authorizer validation and a 5000-row cap.

## Current Limits
- Full dev logs can be very large and include sensitive prompt/message/tool data.
- Multi-round tool loops can still be slow when the model keeps probing with extra SQL queries.
- Large visibility updates still push large NORAD ID arrays to the client.
- Full DISCOS refresh is still a complete reload and can take a long time.
- SQL query results are still held in-process per request round (now capped).

## Next High-Value Move
- Add log retention/rotation for `logs/dev-*` and `logs/assist/*` to keep disk usage predictable.
