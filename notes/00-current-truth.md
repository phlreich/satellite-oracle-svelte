# Current Truth

Last Updated: 2026-02-10
Repo: `/home/phlreich/satellite-oracle-svelte`
Head Commit: `b439ba3`

## What Works Now

- `/api/assist` runs a direct Responses API tool loop with round-aware tool gating and a 3-round max.
- Fast path `set_visibility_sql` can apply visibility, orbits, focus, and assistant text in a single model call.
- Assistant SQL is restricted to `semantic_*` views via SQLite authorizer checks.
- Scene motion uses delayed two-sample Hermite interpolation and rotating worker traversal to reduce close-up stutter.
- Tests block unmocked network calls by default through global `fetch` stubbing in Vitest setup.

## Current Limits

- End-to-end assist latency is still usually dominated by upstream model response time.
- `sql_select` result sets are no longer row-capped, so large queries can increase memory and followup payload size.
- The model can still pick weak SQL logic for ambiguous prompts (for example over-broad country predicates).
- Large visibility/orbit updates still send large NORAD ID arrays to the client.
- Chat UI is still hidden on mobile user agents (`isMobileView`).
- Server can return `[tool-history]` in `historyMessages`, but Oracle UI currently does not append them, so cross-turn tool-history continuity is inactive.
- Smoothing intentionally renders with a fixed delay (`~225ms` at current settings), so visuals are steadier but slightly behind real-time propagation.

## Next High-Value Move

- Add log retention and rotation for `logs/dev-*` and `logs/assist/*`.
