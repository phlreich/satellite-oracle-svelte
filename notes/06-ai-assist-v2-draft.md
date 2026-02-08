# AI Assist Runtime Notes

Last Updated: 2026-02-08

## Current Architecture
- Single `/api/assist` Responses API tool loop.
- Model has read-only SQL via `sql_select` and a fast action-SQL tool `set_visibility_sql`.
- Scene mutation tools are explicit (`set_visibility_sql`, `set_visibility_from_result`, `set_visibility`, `set_orbits_from_result`, `set_orbits`, `set_focus`).
- Server validates tool args and applies deterministic scene action payloads.
- UI forwards scene context (`selectedNoradId`, `visibleCount`, condensed selected panel text) and excludes hidden tool-history messages from outbound request context.

## SQL Guard Model
- SQL text is normalized and validated as a single read-only statement.
- SQLite authorizer allows reads only through `semantic_*` views (plus internal `sqlite_*` sources).
- Direct raw-table reads from assistant SQL are rejected.

## Tool Loop Contract
- `set_visibility_sql`: run one SELECT, extract NORAD IDs, and apply visibility directly; optional orbit/focus updates and `assistant_message` are supported in the same call.
- `sql_select`: analysis SELECT returning `result_ref`, row count, columns, preview rows, and sample rows.
- `set_visibility_from_result`: map prior result rows to NORAD IDs by column and apply visibility mode.
- `set_visibility`: apply explicit NORAD IDs directly.
- `set_orbits_from_result` / `set_orbits`: apply orbit overlays from result rows or explicit IDs.
- `set_focus`: set camera focus to Earth or one NORAD target.

## Round Budgeting and Fast Return
- Runtime max tool rounds is `3`.
- SQL analysis budget is `2` calls (`sql_select` unavailable in the last model round).
- If round 0 contains only successful fast action tools with no `sql_select`, runtime returns immediately without a followup model call.
- If tool output provides `assistant_message`, runtime can use it as final assistant text when model `output_text` is empty.

## Followup Payload Detail
- Followup OpenAI requests send `input` entries with `type=function_call_output`.
- Each `function_call_output.output` is JSON text from `JSON.stringify(toolResult)`.
- Trace markdown renders parsed summaries; dev full logs preserve raw payloads.

## Current Limits
- Complex prompts can still consume all rounds with weak SQL choices.
- `sql_select` no longer row-caps results, so large result sets can be expensive.
- Full-fidelity dev logs can expose sensitive text and grow quickly.

## Next Refinements
- Add log retention and rotation for `logs/dev-*` and `logs/assist/*`.
- Consider lightweight, fixed examples for high-frequency intents (`show debris`, `show starlink`) to reduce first-hop reasoning variance.
