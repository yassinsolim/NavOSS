# Automated navigation validation

NavOSS provides one deterministic command for repeatable iOS navigation evidence:

```sh
corepack pnpm validate:navigation:ios
```

The command starts its own local API and Metro processes, rebuilds a CarPlay-enabled simulator app, reboots the dedicated simulator, runs phone and native scenarios, captures screenshots and logs, validates the images, writes a JSON result, and cleans up its child processes.

Artifacts are written to `artifacts/navigation-validation/` and preserved after both successful and failed runs.

## Prerequisites

- macOS with Xcode, an installed iOS Simulator runtime, CocoaPods, and Maestro;
- the repository's pinned Node and pnpm versions installed through mise or equivalent;
- the local API dependencies configured as described in the repository setup;
- ports 3001 and 8081 available for the API and Metro processes owned by the command.

The harness uses a dedicated simulator named `NavOSS iPhone 15 Pro Max`; create it in Xcode before the first run. The command does not depend on the currently selected Xcode simulator or a previously installed app.

## Modes

Use the complete validation before a release checkpoint:

```sh
corepack pnpm validate:navigation:ios
```

Use focused modes while debugging:

```sh
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --phone-only
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --carplay-only
```

After a successful build, add `--reuse-build` for fast iteration against the installed simulator app:

```sh
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --carplay-only --reuse-build
```

Build reuse is intentionally opt-in. The complete release command always regenerates and compiles the native project.

Add `--offline` to also capture CarPlay on the installed offline style: `offline-preview` and
`offline-guidance` (the `real-calgary-exit` view), each in light and dark. It needs the Calgary or
All Alberta region installed in the app on the harness simulator first (download it once from the
phone app's offline maps screen, see `docs/architecture/offline.md`); without one the run fails
rather than capturing the hosted map. The offline captures must show the route and endpoint
markers like their hosted twins and differ from them in at most 12% of perceptual cells; with the restyle skipped on the offline style
they differed in 24% to 97%.

```sh
corepack pnpm --filter @navoss/mobile validate:navigation:ios -- --carplay-only --reuse-build --offline
```

## Coverage

The phone suite validates:

- Calgary search and route preview;
- selected and alternate route presentation;
- active guidance, ETA, Share ETA, and End;
- all private road-report choices and safety copy;
- automatic rerouting after deterministic off-route movement;
- confirmed arrival after replaying the final route segment;
- screenshot decoding, nonblank content, OCR overlay detection, and uniqueness.

The native suite validates 48 navigation and CarPlay core behaviors, including trip lifecycle, stable publication, End controls, remaining-route geometry, route matching, rerouting, arrival, maneuver speech, destination persistence, API decoding, and driving-scale units.

The CarPlay visual suite mounts the exact production `NavOSSCarPlayMapViewController` in a simulator-only phone window and validates:

- selected route, alternate route, destination and on-screen endpoint markers in preview, including
  short routes and resized views; preview assertions keep the route and endpoints in the free map;
- light and dark restyled OpenFreeMap maps (and, with `--offline`, the offline style), matched
  arrow and forward camera, travelled-route removal, overview and route cleanup;
- `guidance-far-stopped` and `guidance-far-moving` with a distant maneuver, plus `guidance-narrow`,
  which asserts the road name fits below the vehicle and does not overlap attribution;
- guidance captures assert the vehicle is inside the visible map and follow mode has a pitched
  camera; marker scenarios assert a marker is on screen;
- `guidance-maneuver` and `guidance-night` show the maneuver arrow, road pill and compact speed
  unit; annotation and community-report scenarios assert fixture markers are visible;
- `free-drive-*` (no destination) feed synthetic 1 Hz fixes and a compass heading through the
  map's real free-drive entry points: first open parked (compass only), straight, mid-turn,
  stopped after moving (noisy stopped courses), panned away, after Recenter, north-up, no live fix,
  Go, End, and the Dashboard tile. Each checks the heading source, follow state and map heading in
  the app; the pixel gate requires the NavOSS vehicle marker in the lower part of the map, no
  MapLibre user-location dot in any of them, and no vehicle without a live fix. The harness prints
  each capture's map rectangle in pixels (`NAVOSS_CARPLAY_VISUAL_MAP_FRAME`, saved as
  `pixels/map-frames.json`) and the marker's height is measured within it, so neither the
  letterbox colour nor the simulator's appearance or screen size changes the measurement;
- `trip-pause-locating`, `trip-pause-rerouting` and `trip-pause-off-route` (light and dark, plus a
  narrow `trip-pause-locating-narrow`) render a trip under way with no maneuver
  (`NavOSSCarPlayState.tripPause`, a restored trip finding its place, rerouting, or off its route
  with a proposal). The harness fails if the camera stops following the vehicle or a maneuver
  arrow, road pill or speed limit is drawn. The pixel gate requires the production pause text in
  the mocked card and no distance unless a proposal is shown;
- `frame-pacing` measures frame and per-fix work during a 60-second simulated drive at about
  60 km/h with 1 Hz fixes (not head-unit performance);
- permission-overlay absence through Vision OCR, nonblank pixels, color diversity, luminance
  variance, unique hashes and perceptual differences between scenarios.

The visual entrypoint is compiled only for Simulator and requires `NAVOSS_CARPLAY_VISUAL_SCENARIO`. It is absent from device builds and cannot be activated in TestFlight.

## Trip restore

What happens when the app is killed or the phone restarts mid-trip is decided by the navigation
core and covered by the Swift package tests (`test:native:ios`), mostly on the recorded Calgary
drive (`NavigationTripRestoreEngineTests`):

| Situation on relaunch                                                                                                 | Outcome                                                                                                                                                   | `tripEndReason`             |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| First accurate fix on the route                                                                                       | Continues from the checkpoint                                                                                                                             | none                        |
| Off the route                                                                                                         | Withheld for the usual departure fixes, then rerouted by the mode; no maneuver, distance, lanes, road or estimate from the checkpoint until matched again | none                        |
| Saved before its first match                                                                                          | Starts as it was started; the pre-match rules decide                                                                                                      | none                        |
| Saved without progress (build 75, or a damaged record)                                                                | Withheld until its pass is confirmed, at most two minutes of accurate fixes, then as if just started                                                      | none                        |
| No fix yet, or only fixes poorer than 50 m                                                                            | Restored and visible, finding its place; nothing ended or asked                                                                                           | none                        |
| 12 hours after the later of the route's save and its last checkpoint                                                  | Removed                                                                                                                                                   | `restored-trip-expired`     |
| First accurate fix further from the route than 45 m/s since the checkpoint                                            | Ended                                                                                                                                                     | `restored-trip-too-far`     |
| Checkpoint on the final leg with at most 500 m left, first accurate fix off the route within 250 m of the destination | Ended                                                                                                                                                     | `restored-trip-arrived`     |
| The saved trip cannot be read or started again                                                                        | Removed                                                                                                                                                   | `restored-trip-unavailable` |

"Matched again" means a fix the matcher accepted on the route
(`NavigationSession.acceptedLatestFix`) with an accuracy of 50 m or better. A new route or
arrival also counts. A matched coordinate does not count: a poor fix can match within its
accuracy, and a rejected fix keeps an earlier fix's match. While a trip under way has no maneuver
to show, the core says why in `tripPause`, part of every state read and of the snapshot:
`locating` (finding its place), `rerouting` (a route being fetched) or `proceed-to-route` (off
route, nothing being fetched). It follows every reroute status change, not only fixes. The phone
derives no step or estimate while `tripPause` is present. CarPlay treats a trip as under way
(`NavOSSCarPlayState.isTripUnderWay`) when it is guided or paused. Its trip actions, Siri and
replacements use that predicate; the session keeps running and follows the vehicle. CarPlay
shows the trip paused for locating ("Finding your place on the route"), rerouting ("Finding a
new route") or proceed to route ("Off route").

The simulator restore harness (`NAVOSS_RESTORE_E2E`, `NavOSSRestoreSimulatorHarness.swift`)
checks the same through the real `NavOSSNavigationService`; it is run by hand on a simulator.

## Artifact layout

```text
artifacts/navigation-validation/
  environment.json
  summary.json
  logs/
  pixels/
    metrics.json
    sha256.json
  screenshots/
```

`summary.json` is the machine-readable source of truth. It includes the mode, timestamps, phase durations, failures, and final `passed` value. A failed command exits nonzero but preserves the full artifact directory.

## Limits

The simulator visual host verifies production map rendering and shared navigation state, not Apple's external CarPlay host, `CPMapTemplate` chrome, or vehicle-specific input behavior. On this Mac, an ad hoc simulator signature with `NAVOSS_CARPLAY_ENTITLEMENT_ENABLED=1` retains `com.apple.developer.carplay-maps` in `__TEXT,__entitlements`. Xcode 27's Device Hub has no CarPlay external-display menu; Apple's CarPlay processes crash on missing selectors in the iOS 26.5 simulator runtime, and no frames reach the simulated car display. The card layout was probed against Apple's layout code, and the map harness uses mocked card chrome; neither captures real CarPlay chrome.

Before broader distribution, still validate the signed TestFlight build on at least one wired and one wireless real CarPlay system. That manual check should focus on connection/reconnection, vehicle controls, search templates, route preview, Start, rerouting, arrival, persistent End controls, lock behavior, and phone synchronization. The automated harness is intended to make that final hardware check short and focused, not to pretend the hardware boundary does not exist.
