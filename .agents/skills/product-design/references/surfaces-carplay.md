# CarPlay surface

Design constraints come from Apple's CarPlay framework and are recorded in `docs/architecture/carplay.md`. Read it before designing; this file lists only what a designer needs to remember.

## Constraints

- CarPlay is a native scene inside the same app (`NavOSSCarPlaySceneDelegate`). React Native does not render onto the vehicle display.
- The base map window draws **map content only**. Alerts, buttons, lists, search, trip previews and guidance use CarPlay templates. No custom controls or overlays on the map view.
- A custom recent-contacts browser is not an approved navigation-template surface; it will not be added (`docs/architecture/carplay.md`).
- Siri and the "Navigate to <place> with NavOSS" App Intent open a route preview; **Go is still required** (#77).
- Route-choice preview is not active navigation; the `CPNavigationSession` starts only after Go.
- Dashboard (`CPTemplateApplicationDashboardSceneDelegate`) shows route, arrow and speed while navigating and Go / Voice shortcuts when idle. Whether a cluster or HUD connects is the vehicle's decision.
- A connected display holds a background-activity session so location keeps flowing with the phone locked.
- The restricted entitlement `com.apple.developer.carplay-maps` and the `production-carplay` EAS profile gate everything.

## What the code does (#77, #85)

- Idle map follows the vehicle; guidance camera is course-up with look-ahead, pitch 36 to 50 degrees, eased up to 60 fps.
- Template content: search hub (Home, Work, Recents, Saved, categories), debounced typed search, nearest-first results with distances, route preview with alternatives, drawn maneuver symbols (roundabout exits included), "then" when the next maneuver is within 250 m, `CPLaneGuidance` only when the route carries lanes, arrival and reroute alerts.
- Every list has loading, empty and error states. Voice failure offers retry, typing or saved places.
- Report grid: two taps, titled "Report (private)" or "Report to drivers" before a type is chosen; Settings has Rerouting, Speeding warning and a Community group (Share road reports, Share traffic speeds, Spoken road reports).
- Still-there is a `CPNavigationAlert` (Still there, Not there; timeout or Dismiss sends nothing), never over another alert and never near a maneuver.
- Night and day follow the vehicle's `contentStyle`.

## Verification honesty

Interactive CarPlay has not been run in this project's environment: Xcode 27.2 has no CarPlay Simulator window, and a hosted-runner probe crashed Apple's `CarPlayTemplateUIHost` on iOS 26.4 before Search appeared. The visual harness (`validate:navigation:ios --carplay-only`) renders the production map with a labelled **mock** of template chrome whose content comes from production code. Say that in every CarPlay review; template layout, touch, alerts, Siri, cluster and Dashboard buttons need a head unit (`docs/release/next-build-checklist.md`).

## Not yet standard

Template item limits, title lengths and per-template text budgets are Apple's; this repository records none of them. See `coverage-gaps.md`.
