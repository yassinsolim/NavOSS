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

Simulator runtimes: iOS 18.5, 26.5 and 27.2 are installed on the maintainer's Mac. Release builds are linked against the iOS 26.5 SDK (hosted runner, Xcode 26.6), while Xcode 27.2 links local simulator builds against iOS SDK 27.2, so a local build is subject to iOS 27 SDK rules that do not yet apply to a TestFlight build. One of those rules: an app linked against the iOS 27 SDK without a window scene stops at launch with `SIGTRAP` in `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Every flavour now declares the phone scene; if a build traps there, its generated `Info.plist` has lost `UIApplicationSceneManifest`. Check new phone or CarPlay behaviour on an iOS 27.2 simulator as well as 26.5.

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

How the CarPlay vehicle moves between fixes is measured in two places. The native test
`CarPlayVehicleMotionTests.testMotionReplayReport` replays drives (straights from 7 to 100 km/h, a
right-angle corner, a roundabout, a stop at a light) through `NavOSSCarPlayVehicleMotion` with
fixes about once a second (±200 ms, an occasional 2–3 s gap), 3 m of correlated GPS error, and the
compass republishing the same fix, in guidance and free drive, and reports per 60 fps frame how
often a moving car is drawn standing, the frame-to-frame speed steps, the camera heading rate, the
lag behind the true position, and movement while stopped. Set `NAVOSS_MOTION_REPORT` to a file
path to write the numbers as JSON. The harness scenario `motion-drive` (not in the pixel gate)
drives the turn fixture with the same kind of fix timing for recording with `xcrun simctl io
<device> recordVideo`; it prints `NAVOSS_CARPLAY_MOTION` phase markers and frame timings.

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
shows the trip paused for locating ("Finding your place"), rerouting ("Finding a
new route") or proceed to route ("Off route").

The simulator restore harness (`NAVOSS_RESTORE_E2E`, `NavOSSRestoreSimulatorHarness.swift`)
checks the same through the real `NavOSSNavigationService`; it is run by hand on a simulator.

## Repeated departures

A driver who leaves the route and keeps going their own way is rerouted at once, then given a
fresh route from where they are at growing intervals, never one per block. The rule is
`NavigationRerouteSpacing` and `navigationIsMateriallySameRoute` in the navigation core;
`NavigationRerouteBackoffTests` drives it through `NavigationEngine` on a 200 m street grid with
a router double that answers like Valhalla (to the next intersection in the direction of travel,
then back to the chosen road).

- The first request after leaving a route the driver was established on is never held.
- After a replacement is answered (installed, proposed in Ask first, or found to be the route
  already followed), the next request waits for 400 m of travel and 20 s, then 800 m and 40 s,
  and never longer than 800 m or 60 s, whichever comes first (the minute needs the vehicle to
  have moved since the last answer, so a parked car is not routed again). Then, while the driver is
  still off the route they were given (past its turn back, or further from it than a
  departure), they get a fresh route from where they are, whichever way they are going.
- After 500 m and 30 s on a route without leaving it, the driver is established again and the
  count starts over.
- Ask first: a declined offer holds for 90 s and the spacing, and an answer materially the same
  as the declined route is not offered again. The replacement owed for an offer nobody answered
  waits for the time spacing only (the 45 s response window has always covered it).
- A replacement that is materially one of the last three routes replaced in this detour or the
  offer just declined (all but 50 m of it within 20 m of that route and in its direction) is
  not installed, offered, published, counted or spoken; it still counts as an answer for the
  spacing. So is one that, once the route has been matched, is the rest of the route followed
  from the vehicle's match: walked in order, every point of it but 50 m lies within 20 m of the
  route, in its direction, at or just after the previous one, starting at the match, and its
  length is within 50 m of the route left; it starts within 20 m of the match and ends within
  20 m of the route's end (`navigationIsRestOfRoute`). That is the router
  starting where the matcher's anchor is (a lay-by or a stop beside the road where the vehicle
  left it). The vehicle stays off route until the matcher finds it on the route going forwards;
  nothing about matching, jumps or arrival changes. Any other answer along the route's roads
  (starting behind the match after a GPS gap, ahead of it beside the route, on the far side of
  a loop or an out-and-back, or near the end) is installed as any other replacement, as before this change. The replaced and declined memory ends with the detour, when the
  driver is established on a route. Before the first match the route followed is not compared.
- A request without a platform heading carries the direction of the last 20 m of fixes within
  10 s, so the router does not start the route with a U-turn behind the car.
- Failed requests keep their retry schedule: 10 s, doubling to 2 minutes, nothing spoken; they
  are not answers.

Worst-case added delay: none for the first reroute after a departure. A second departure in the
same detour waits until 400 m and 20 s after the previous replacement (about 29 s at 50 km/h,
20 s at 100 km/h, less the few seconds the departure itself takes to confirm). After that a
driver who keeps ignoring routes is never more than 800 m or a minute from the next fresh route
(on 5 km ignoring every route: 8 installs, longest gap 61 s and 732 m at 43 km/h; 7 installs,
longest 28 s and 840 m at 108 km/h, the answer taking a second).

On the 2.4 km straight detour at 43 km/h (up the next avenue, ignoring every route): adaptive and
keep-route went from 12 installs to 5 (one at once, one 400 m on, then one a minute), Ask first
from 7 requests, 4 spoken offers and 3 installs to 4 requests, 2 offers and 2 installs. With a
router that starts every route with a U-turn, adaptive went from 24 installs to 5. A 1.5 km
parallel avenue went from 9 installs to 3, and a service road 60 m beside the route for 1.5 km
from 9 to 3. A same-road answer from where the vehicle is, while it drives on beside the route
(a 600 m lay-by, an 800 m service road), is installed once in Automatic and offered once in Ask
first (it was dropped while the rule allowed any shorter answer). The recorded Calgary drive speaks the same prompts, and its detour, answered with
the whole recorded route from its start, installs once (2 before): the first answer is longer
than the rest of the route, and the second is the route just replaced.

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
