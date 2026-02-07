# Working Notes

Last Updated: 2026-02-07

- `node:sqlite` `DatabaseSync#prepare` only compiles the first statement; check `statement.sourceSQL` tail to reject extra statements in one tool call.
- SQLite authorizer action codes provide a robust read-only guard (`SELECT/READ/FUNCTION/RECURSIVE` allow-list) without regex SQL scanning.
- Keep raw fidelity in dev logs (`ASSIST_LOG_FULL`) and keep markdown trace intentionally compact/readable; they serve different debugging goals.
- Trace markdown renders parsed/summarized payloads and is not a byte-for-byte copy of the OpenAI request body.
- Box table rows in trace files are single physical lines; visual multiline wrapping can come from narrow viewers.
- `initializeDatabaseAndSetCache()` logs and swallows initialization failures, so route-level failures can surface later instead of failing process startup.
- `notes/INDEX.md` commit snapshot can lag real `HEAD`; verify with `git rev-parse --short HEAD` when grounding status.
- Notes can also lag uncommitted local edits; run `git status --short` before trusting snapshots in `notes/`.
- Orbit tracking is independent of point visibility; when a selected satellite becomes hidden, explicitly clear selection tracking and call `stopOrbitTracking()` or stale orbit lines persist.
- A more stable fix than baseline nudges is making `.message.thinking` a flex row with `align-items: center` and `line-height: 1`.
- For better waiting feedback, run a loop: cursor-only pause, type phrase, hold, erase, then type the next phrase.
- Keep loader and chat cursor cadence linked through a shared `--cursor-blink-duration` CSS variable and derive cursor-only delay from blink-count.
- When a response arrives, request a graceful stop so thinking text finishes the current `typing` or `erasing` phase before disappearing.
- `stopThinkingAnimationGracefully()` only defers during `typing`/`erasing`; if phase is `cursor`/`holding`, the indicator clears immediately.
- The current Oracle mobile mode applies `.hidden` to the chat window (`isMobileView`), effectively disabling chat controls on mobile user agents.
- Root route currently wraps the Oracle page directly (`src/routes/+page.svelte` imports `./oracle/+page.svelte`), so `/` and `/oracle` behavior is tightly coupled.
