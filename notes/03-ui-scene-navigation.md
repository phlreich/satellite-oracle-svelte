# UI + Scene Navigation

Last Updated: 2026-02-07

## Expected Behavior
- Scene click selects and focuses a satellite.
- Panel arrows cycle visible satellites with wraparound.
- Assistant can update visibility (`replace|add|remove`) and focus (`earth|norad`) in one turn.
- Pending assistant requests show a typed status phrase + blinking cursor in chat.
- Chat input is disabled during pending assist requests.
- Coordinate rows keep stable panel height with placeholders.

## Key Files
- `src/routes/oracle/+page.svelte`
- `src/lib/scene.ts`
- `src/app.html`

## Programmatic Focus Paths
- `focusEarth()` sets camera target to Earth and clears tracked satellite state.
- `focusVisibleNoradId(noradCatId)` focuses only if the NORAD object is currently visible.
- If assistant returns focus for a hidden NORAD and no visibility action is returned, UI attempts one `add` visibility update before retrying focus.

## Critical Camera Detail
When switching selection programmatically, clear old tracking before setting a new lerp target:
- `trackTarget = undefined`
- `previousSatellitePosition = undefined`

## Thinking Indicator Contract
- Phrase queue is shuffled and avoids clustering atmospheric phrases adjacently.
- Animation phases run `cursor -> typing -> holding -> erasing`.
- Graceful stop waits for typing/erasing boundaries before clearing the indicator.
- Cursor cadence is sourced from `--cursor-blink-duration` to align loader + chat rhythm.
