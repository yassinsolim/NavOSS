# Phone surface

One screen: a MapLibre map with the sheet the current task needs on top (`map-screen.tsx` composes `MapCanvas`, `MapLayers`, `MapControls`; behaviour in `features/map/controller/*`). Introduced in #78.

## Inventory (from #78)

Bottom sheets with detents: explore and search, place, route planning and preview (alternatives), trip panel, arrival, report picker, map appearance, guidance settings, about and privacy, categories, stops editor. Full pages: saved places, contribute. Floating map controls ride the sheet edge. Symbol layers draw search results, traffic webcams and safety facilities.

## Guidance

- Always on ink (`guidanceColors`), both schemes.
- Maneuver banner: distance, the action large and never truncated, then where it leads (#78). Lane strip and exit sign appear only when `/v2/routes` supplies lanes and signposts (#84).
- Current speed and the posted limit with the speeding state; current road name from the step's `currentRoadName` (#78, #84).
- Camera alerts come from the native snapshot's payload; the phone only presents them. Ask-first reroute offers present **Keep route** and **Accept new route**.
- The trip panel shows a notice only when it matters (weak GPS, waiting for GPS, off route, rerouted); otherwise the destination (#78).

## Behaviour that must not regress

- Sheets are interruptible, keyboard-aware, and honour Reduce Motion (they open at their final position).
- The sheet visible at launch appears in place; it must not animate in from the edge, or an immediate tap lands on a moving target (a product bug found in #78).
- A preference change must not reload the basemap (the style effect depends on `mapStyleInputs` only).
- After a trip ends, the next preview is fitted north-up and flat with padding reset (#78).

## Not yet standard

Phone community UI (map layer for reports, report sheet with the Share road reports switch, Still-there sheet) was being built in a separate change when this skill was written; its states are not recorded here. See `coverage-gaps.md`.
