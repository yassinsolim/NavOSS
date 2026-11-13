# PR #78: phone UI refresh (merged)

**Decided**

- One token module and a small set of primitives instead of per-screen styling; the Expo-template theme files were removed. Dark mode enabled (`userInterfaceStyle: automatic`); the `Auto` map style follows the system.
- Sheets are gesture-driven with detents and one shared value on the UI thread; floating controls ride the sheet edge; Liquid Glass with a solid fallback.
- `map-screen.tsx` became a composition root; behaviour moved into `features/map/controller/*` hooks. Measured, not asserted: screen renders in a launch-to-arrival run fell from about 4,300 to about 130; panning and zooming an idle map re-rendered no screen component.
- Every surface got loading, empty, error, offline, location-denied and degraded states. Source-grepping tests were replaced by behavioural tests (sheet detents, overlay layout, route UI state, WCAG contrast for every text role in both schemes).

**Mistakes caught by looking at the render (rounds 2 and 3)**

- The sheet visible at launch animated in from the bottom edge, so an immediate tap landed on the Work chip and started "Search to set Work". Fix: the launch sheet appears in place.
- At the largest Dynamic Type size the map credits ballooned over the map and titles truncated. Fix: text growth capped on guidance, credits, rows, banners and route cards; titles wrap.
- After a trip ended the next preview was fitted underneath its own sheet and rotated because the native camera kept guidance padding, bearing and pitch. Fix: reset padding; fit north-up and flat.
- Route preview drew every camera in the city; now only those within 60 m of the selected route.
- Unselected chips on Contribute had no fill in dark mode.

**Left unverified and recorded**: VoiceOver listening, offline state on screen, Kelowna and Ontario overlays, one local-data Maestro flow that needs production search data.

**Lesson**: the bugs that mattered (launch tap, Dynamic Type, preview camera) were visible only on the simulator. See `SKILL.md` verification.
