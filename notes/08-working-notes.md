# Working Notes

Last Updated: 2026-02-07

- `node:sqlite` `DatabaseSync#prepare` only compiles the first statement; check `statement.sourceSQL` tail to reject extra statements in one tool call.
- SQLite authorizer action codes provide a robust read-only guard (`SELECT/READ/FUNCTION/RECURSIVE` allow-list) without regex SQL scanning.
- Keep raw fidelity in dev logs (`ASSIST_LOG_FULL`) and keep markdown trace intentionally compact/readable; they serve different debugging goals.
- Trace markdown renders parsed/summarized payloads and is not a byte-for-byte copy of the OpenAI request body.
- Box table rows in trace files are single physical lines; visual multiline wrapping can come from narrow viewers.
- `initializeDatabaseAndSetCache()` logs and swallows initialization failures, so route-level failures can surface later instead of failing process startup.
