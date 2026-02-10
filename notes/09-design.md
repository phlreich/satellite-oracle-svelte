# Design

Last Updated: 2026-02-07

## Identity

Industrial space. A ground station terminal that happens to be on the web. Serious but visually unusual — distinctive through restraint and rawness, not decoration. Not a video game, not a SaaS dashboard.

## Design Tokens

- Font: `Consolas, 'Courier New', 'Liberation Mono', monospace` everywhere.
- Background: `#000` flat black.
- Text: `white` primary, `rgba(255,255,255,0.4–0.7)` secondary.
- Borders: `1px solid white` (panels), `1px solid rgba(255,255,255,0.4)` (inputs/buttons at rest).
- Border radius: `0` on all elements.
- Hover/active: border and text brighten to full white; background `#232121`.
- Panel backgrounds: `rgba(0,0,0,0.9)`.
- Cursor blink: `var(--cursor-blink-duration, 0.6s)`, `step-end`, shared between loading screen and chat.

## Layout

Full-viewport `<canvas>` with floating overlay panels absolutely positioned at viewport edges. No header, nav bar, sidebar, or layout chrome. The void around elements is intentional.

- Chat window: bottom-right, resizable via invisible border drag zones.
- Satellite info: bottom-left, name + coordinates + prev/next nav.
- No box shadows, no gradients.

## Messages

No colored fills. Differentiation through structure (border side + alignment), not color.

- Assistant: left-border `2px solid rgba(255,255,255,0.2)`, background `rgba(255,255,255,0.03)`.
- User: right-border `2px solid rgba(255,255,255,0.5)`, background `rgba(255,255,255,0.06)`, right-aligned.

## Labels and Buttons

Uppercase, letter-spaced (`0.1–0.12em`), small font-size, dimmed at rest (`rgba(255,255,255,0.4–0.7)`). Brighten to full white on hover.

## Scrollbar

Custom thin scrollbar: 4px wide, `rgba(255,255,255,0.25)` thumb, transparent track. Firefox: `scrollbar-width: thin`.

## 3D Scene

The scene is a different register from the panels. It keeps its own color logic.

- Satellites: white points, uniform size/color.
- Hover: green `(0, 1, 0)`.
- Selected orbit: `0x90ee90` light green, 95% opacity.
- Vertical line: `0x90ee90` light green.
- Orbit overlay: `0x9de3ff` light blue, 35% opacity.
- Earth: photo texture (`earth.webp`), `MeshBasicMaterial`, no lighting.

The green accent is functional — the only way to distinguish "selected" from "everything else" in a white point cloud. Panels are monochrome; the scene uses color as instrument data. This is consistent, not contradictory.

## Thinking Indicator

Typewriter animation during assistant requests. Phrases drawn from a shuffled deck of 19 entries across two registers:

- 14 active (system doing something): QUERYING CATALOG, SCANNING TELEMETRY, PARSING EPHEMERIS, CORRELATING TRACKS, INTERROGATING DATABASE, PROPAGATING ORBITS, CONSULTING THE ORACLE, CROSS-REFERENCING OBJECTS, RESOLVING ELEMENTS, REDUCING OBSERVATIONS, VALIDATING EPOCHS, REBUILDING CONTEXT, INDEXING DISTANCE, CENSORING MANIFOLD.
- 5 atmospheric (passive/ambiguous): AWAITING DOWNLINK, ACQUIRING SIGNAL, STILL LOOKING, REMEMBERING.

Atmospheric phrases are guaranteed at least one active phrase between them. Full deck cycles before reshuffling. Style: `0.78em`, uppercase, `0.12em` letter-spacing, `rgba(255,255,255,0.5)`. Reads as system status, not conversation.

Phrases range from real orbital operations jargon to deliberate ambiguity. The ambiguous phrases (REMEMBERING, INDEXING DISTANCE, CENSORING MANIFOLD) should seem purposeful but resist full resolution — the viewer fills the gap.

## Loading Screen

`INITIALIZING` + blinking block cursor. Black background. Same monospace font. No animation, no starfield, no graphics. Fades out in 0.6s when scene is ready. Inline in `app.html` for instant first paint.

## Landing Page (webroot)

Content gravity-anchored bottom-left. Name as heading, thin rule (`1px, rgba(255,255,255,0.15)`), section label, project entries using the same left-border treatment as assistant messages. No container, no card — content sits directly on the void. Structure scales to more entries.

## Principles

1. Dim at rest, bright on interaction.
2. Structure over color — differentiate through alignment, borders, spacing, not fills.
3. The void is design — empty space is intentional, not missing content.
4. Panels are chrome, scene is data — different visual rules for different purposes.
5. Personality through ambiguity — thinking phrases are the main personality surface.
6. No decoration — every visual element is functional or informational.
