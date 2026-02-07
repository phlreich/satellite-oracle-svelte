# Current Truth

Last Updated: 2026-02-07
Repo: `/home/phlreich/satellite-oracle-svelte`
Head Commit: `9bf52a0`


## What Works Now
- `/api/assist` runs a direct Responses API tool loop with no planner/executor split.
- Scene visibility updates that hide the selected satellite now clear selection and orbit tracking together.
- Oracle chat now shows a typewriter-style thinking indicator while assist requests are pending.
- Thinking animation now stops gracefully at typing/erasing boundaries when a response arrives.
- Dev runtime still writes timestamped logs plus compact assist traces with optional full payload logging.

## Current Limits
- Full dev logs can be very large and include sensitive prompt/message/tool data.
- Multi-round tool loops can still be slow when the model keeps probing with extra SQL queries.
- Large visibility updates still push large NORAD ID arrays to the client and UI.
- Chat is hidden on mobile user agents (`isMobileView`) in the current Oracle page.
- Full DISCOS refresh is still a complete reload and can take a long time.
- SQL query results are still held in-process per request round (capped at 5000 rows).

## Next High-Value Move
- Add log retention/rotation for `logs/dev-*` and `logs/assist/*` to keep disk usage predictable.
