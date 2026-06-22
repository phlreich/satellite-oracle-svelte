# Scene loading & satellite streaming

Status: proposal. This document describes the desired shape of the scene-loading
refactor, not an implementation checklist.

## Intent

The first meaningful visual should be a textured, animated Earth. Satellite data
loading, parsing, worker setup, and first-position computation should happen
after that Earth scene exists, with satellites appearing only once they have
valid computed positions.

The refactor should make startup feel alive without first changing the
scene-data artifact format.

## Current issue

Startup currently couples three different concerns:

- Earth scene boot.
- Earth texture readiness.
- Satellite layer loading and worker warmup.

The loading screen is hidden only after the satellite path completes, while the
Earth texture is loaded independently and can visibly pop in later.

The satellite `visibility` state is also overloaded. It controls rendering,
query filtering, worker assignment, and worker propagation. That makes a simple
"hide all dots until workers update them" patch unsafe: if visibility starts at
zero, workers may never compute the positions needed to make dots visible.

## Design

Split the scene into two lifecycle layers.

### Earth layer

Create the renderer, camera, controls, Earth mesh, texture load signal, and
animation loop without requiring satellite data.

The page should be able to:

1. Create the Earth scene.
2. Wait for texture readiness, with a bounded failure/timeout fallback.
3. Hide the loading screen.
4. Load and attach satellites afterward.

The render loop must be valid when no satellite layer exists yet.

### Satellite layer

Attach satellites to the already-running scene through a separate load step.
That step owns scene-data rows, shared buffers, workers, point geometry, orbit
state, query filtering, and satellite-specific controller methods.

Before this layer is ready, satellite controller methods should return safe
defaults such as no-op, `false`, or `0`.

## Visibility model

Separate computation eligibility from render readiness.

- Compute visibility: whether a satellite should be assigned to workers, usually
  based on the active query/filter.
- Render readiness: whether a satellite has received at least one valid computed
  position.
- Render visibility: whether the shader may draw the satellite.

Render visibility should be derived from the other two states:

```ts
renderVisible = computeVisible && renderReady;
```

Workers should use compute visibility, not shader visibility. The shader should
use render visibility, not worker eligibility.

This allows workers to compute hidden-not-ready satellites, then reveal each dot
only after its first valid position arrives.

## Phase 1: visual streaming

Keep the current JSON scene-data blob.

Expected user-visible sequence:

1. Loading screen.
2. Textured Earth appears and starts animating.
3. Scene data finishes loading and parsing.
4. Workers begin computing positions.
5. Satellite dots appear progressively from valid positions.

This phase improves perceived startup and removes texture pop-in. It does not
make the first satellite appear before the full scene-data blob has arrived.

## Phase 2: data streaming

True data streaming means changing the scene-data protocol so rows can be
consumed before the full payload arrives. Prefer a count-first protocol so the
client can allocate fixed-size shared buffers, then append rows in batches.

Production currently serves scene data through nginx from the static satellite
data volume, while the Svelte route also exists for app/dev behavior. A streaming
protocol must account for both paths, or deliberately remove the nginx bypass.

## Worker data cost

The current worker initialization clones the satellite catalog to multiple
workers. That cost is independent of visual streaming and can be optimized
separately.

If this is addressed, prefer a shared catalog representation based on
`SharedArrayBuffer`. A single transferable `ArrayBuffer` is not a shared
multi-worker solution because transfer moves ownership to one recipient.

## Acceptance criteria

- The loading screen hides on texture readiness or bounded fallback, not on full
  satellite initialization.
- The Earth can render and animate before scene data is loaded.
- Satellites never render at the origin during startup.
- Dots appear progressively as valid positions arrive.
- Query filtering still controls which satellites workers compute and which
  ready satellites render.
- Texture failure does not hang the page behind the loading screen.
- `SharedArrayBuffer` and cross-origin isolation requirements are preserved.

## Sequencing

1. Split Earth scene creation from satellite layer loading.
2. Add texture readiness with timeout/failure fallback.
3. Start rendering before satellite data loads.
4. Split compute visibility from render visibility.
5. Remove first-position waiting from the reveal path.
6. Measure reveal time, first-dot time, full-ready time, and main-thread stalls.
7. Optimize worker catalog sharing or data streaming only if measurements justify
   the added complexity.
