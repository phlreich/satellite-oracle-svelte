# UI + Scene Navigation

Last Updated: 2026-02-06

## Expected Behavior
- Scene click selects and focuses a satellite.
- Panel arrows cycle visible satellites with wraparound.
- Assistant can update visibility (`replace|add|remove`) and focus (`earth|norad`) in one turn.
- Coordinate rows keep stable panel height with placeholders.

## Key Files
- `src/routes/oracle/+page.svelte`
- `src/lib/scene.ts`

## Programmatic Focus Paths
- `focusEarth()` sets camera target to Earth and clears tracked satellite state.
- `focusVisibleNoradId(noradCatId)` focuses only if the NORAD object is currently visible.

## Critical Camera Detail
When switching selection programmatically, clear old tracking before setting a new lerp target:
- `trackTarget = undefined`
- `previousSatellitePosition = undefined`
