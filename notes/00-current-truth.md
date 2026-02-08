# Current Truth

Last Updated: 2026-02-08
Repo: `/home/phlreich/satellite-oracle-svelte`
Head Commit: `951c4cd`

## What Works Now
- `/api/assist` runs a direct Responses API tool loop with round-aware tool gating and a 3-round max.
- Fast path `set_visibility_sql` can apply visibility, orbits, focus, and assistant text in a single model call.
- Assistant SQL is restricted to `semantic_*` views via SQLite authorizer checks.
- Semantic views are created during DB build and on startup reuse so assist schema naming stays stable.
- Tests block unmocked network calls by default through global `fetch` stubbing in Vitest setup.

## Current Limits
- End-to-end assist latency is still usually dominated by upstream model response time.
- `sql_select` result sets are no longer row-capped, so large queries can increase memory and followup payload size.
- The model can still pick weak SQL logic for ambiguous prompts (for example over-broad country predicates).
- Large visibility/orbit updates still send large NORAD ID arrays to the client.
- Chat UI is still hidden on mobile user agents (`isMobileView`).

## Next High-Value Move
- Add log retention and rotation for `logs/dev-*` and `logs/assist/*`.
