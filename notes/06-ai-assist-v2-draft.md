# AI Assist Runtime Notes

Last Updated: 2026-02-07

## Current Architecture
- Single `/api/assist` Responses API tool loop.
- Model has direct access to read-only SQL via `sql_select`.
- Scene mutation tools are explicit (`set_visibility_from_result`, `set_visibility`, `set_focus`).
- Server validates tool args and applies deterministic scene-action payloads.
- UI forwards scene context (`selectedNoradId`, `visibleCount`, condensed selected panel text) with each assist call.

## Observability Model
- Dev runtime logs keep full-fidelity OpenAI requests/responses and tool payloads when `ASSIST_LOG_FULL` is enabled.
- Runtime logs also keep compact summary lines so sequence scanning stays fast.
- Trace markdown (`logs/assist/*.md`) is intentionally compact and omits heavy payload details.
- Trace markdown is a readable rendering, not a byte-for-byte wire capture.

## Tool Loop Contract
- `sql_select`: one read-only `SELECT`, returns `result_ref`, row count, columns, preview rows, and sample rows.
- `set_visibility_from_result`: maps prior result rows to NORAD IDs by column and sets visibility mode.
- `set_visibility`: applies explicit NORAD IDs directly.
- `set_focus`: sets focus to Earth or one NORAD target.

## Followup Payload Detail
- Followup OpenAI requests send `input` entries with `type=function_call_output`.
- Each `function_call_output.output` is JSON text from `JSON.stringify(toolResult)`.
- Trace view may show parsed summaries of that payload, while dev full logs show the raw payload structure.

## Current Limits
- Multi-round tool loops can still be slow when the model performs extra SQL probes.
- Full-fidelity dev logs can expose sensitive text and grow quickly.
- SQL query results are still stored in-process per request round (capped at 5000 rows).

## Next Refinements
- Add log retention/rotation for `logs/dev-*` and `logs/assist/*`.
- Add optional trace verbosity levels (`compact|standard|full`) for faster troubleshooting switches.
