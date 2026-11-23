# Next build checklist

Status refreshed: 2026-11-23. Build `0.1.0 (85)` from `main` (`3b57b04`) was distributed to internal `testers` and NavOSS Friends. App Store Connect showed Testing for both groups; no installs or sessions have been observed yet. The Google-profile build carries CarPlay and production App Attest. Build 73 remains held.

Context: production search and routing cover Canada. Reports are `attested`, traffic `collect`; live traffic is not shown. Offline bundles cover All Alberta and the Calgary area, not BC. Build 81 includes the Alberta, BC and Ontario province-wide road-events list, Canada refusal handling and the Explore-sheet fix; builds 75 and 80 use Calgary and Kelowna feeds. 511 Alberta and Ontario 511 were connected in production on 2026-11-15; build 81's list now includes their events. A Debug simulator downloaded Calgary and searched and routed with the API stopped. Physical offline download, first App Attest registration, Google's place panel and real CarPlay remain to be checked.

The 2026-11-15 Release simulator Canada pass on `14dae86` against production was a go before build 81 distribution; see [the release record](testflight.md#build-81-canada-validation-and-subsequent-fixes-2026-11-15) and `artifacts/release-validation-main-81/round3/`. CarPlay refusal alerts were Swift-tested only; no physical iPhone or head unit was exercised.

## Next build (after build 85)

Merged on `main` after `3b57b04`, not in build 85: [#162](https://github.com/yassinsolim/NavOSS/pull/162),
workflow hardening (CI reads command output before grepping it under pipefail). It changes no app
code, so it needs no on-device check.

Open, not merged (check each when it lands, and say which build contains it):

- [ ] Android pull requests [#157](https://github.com/yassinsolim/NavOSS/pull/157),
      [#158](https://github.com/yassinsolim/NavOSS/pull/158),
      [#159](https://github.com/yassinsolim/NavOSS/pull/159),
      [#161](https://github.com/yassinsolim/NavOSS/pull/161) and
      [#163](https://github.com/yassinsolim/NavOSS/pull/163). Before any iOS build that contains
      them, repeat the iOS prebuild comparison used for build 85 (`Info.plist`, entitlements and
      privacy manifest byte-identical to the previous build's).
- [ ] The time-zone fix, in progress in a separate pull request: arrival time and "updated h:mm"
      should follow the device's zone after it changes while the app runs. Check by changing the
      time zone with the app open (not exercised on screen so far).
- [ ] Trip restore rules (pull request `fix/restore-off-route`, supersedes #135). In the car,
      parked or passenger-operated, on the build that contains it:
  - Start a trip, drive onto the route, then close the app (swipe it away) and reopen it after
    leaving the route (a side road or a parking lot beside it). The trip should still be there,
    finding its place for a few seconds, then rerouted in Automatic, offering a new route in Ask
    first, or guiding back to the route in Keep route. It must not say "Trip ended". Until
    the car is back on the route, neither the phone nor CarPlay shows the turn it was saved
    before. CarPlay keeps the trip running and follows the car, showing "Finding your place",
    then "Finding a new route" or "Off route" instead of a maneuver. In Ask first,
    the "Use new route" / "Keep mine" offer appears on CarPlay.
  - Tap Start in a parking lot about 100 m from the road, close the app before reaching the road,
    reopen it in the same spot. The trip and the chosen route should still be there, silent and
    not rerouted while parked, and guided once the car reaches the road.
  - Close the app mid-trip, reopen it on the route: guidance continues with no new route request.
  - Close the app in the destination's car park before arrival is confirmed and reopen it there:
    "Trip ended" with "Your last trip had reached its destination, so it was ended."
- [ ] The `carplay-free-drive-end.png` harness pixel gate (marker at 0.561 of map height against
      0.6, twice) is under investigation; settle whether it is the harness or the device type
      before relying on that gate for the next build.
- [ ] Phone free drive (the phone side of #160): with no trip the phone map shows your Arrow or
      Car instead of the blue dot. Parked it points the way the phone faces; driving, the way you
      go; at a light it holds. Start a trip: one marker, no jump; End: the blue dot shows until the
      next fix, then the arrow returns. In a garage or after
      15 s without a fix the blue dot (with its accuracy ring) returns. Seen only on a simulator.

## Build 85, in testers' hands

Owner report on build 84 (2026-11-21): with no destination, CarPlay zoomed to the general area and
showed no arrow. [#160](https://github.com/yassinsolim/NavOSS/pull/160) is in build 85: with a live
fix and no destination, CarPlay draws the guidance vehicle marker pointing the way the car is
going and follows it with the close, tilted guidance camera. Build 85 also contains
[#153](https://github.com/yassinsolim/NavOSS/pull/153) and
[#154](https://github.com/yassinsolim/NavOSS/pull/154) (phone floating map controls) and
[#156](https://github.com/yassinsolim/NavOSS/pull/156) (Android bring-up, which reaches iOS only
through cached date and collation formatters). Verified only on a simulator with synthetic fixes and
mocked CarPlay buttons; see the
[build 85 record](testflight.md#build-85-validation-and-known-limits-2026-11-22). Check while parked
or with a passenger operating:

- [ ] Open CarPlay parked: the arrow (or car) appears low on the map within a few seconds, close
      and tilted, not a city overview. Before the car has moved it points the way the **phone**
      faces (compass); note whether that is wrong for your mount.
- [ ] Drive off: the arrow turns to the direction of travel and the map follows it heading-up,
      smoothly between fixes. At a red light the arrow and map do not spin.
- [ ] Pan the map: following stops, the arrow keeps moving; Recenter brings it back.
- [ ] Settings ▸ North up: north stays up and the arrow rotates instead.
- [ ] Start a trip with Go: the view does not jump and there is never a blue dot beside the arrow.
      End the trip: the arrow stays, with no gap or second marker.
- [ ] Dashboard and, if the car has one, the instrument cluster show the same arrow.
- [ ] In a tunnel or with location off: no arrow is drawn rather than a stale one.
- [ ] **Phone floating controls (#153, #154).** With Day map under dark system appearance the icons
      are readable; ending a trip from the expanded sheet leaves report and recenter with their
      glass circles; faded controls take no taps. Seen in a Release simulator on iPhone 15 Pro Max
      (the iPhone SE pass was not run); VoiceOver driven by a person was not verified.
- [ ] **Time zone (known limit).** A running app keeps the zone it started in for arrival time and
      "updated h:mm" until relaunch, for example across Alberta to British Columbia. Reasoned from
      source, not exercised on screen; relaunch to see the right time. A fix is in progress and is
      not in build 85.

Not verified for build 85: a real head unit or Apple's CarPlay Simulator (phone and CarPlay together;
Go and End marker continuity on a connected scene), a physical iPhone, the signed build itself, the
Maestro suite in the validation pass, the iPhone SE pass, opening hours on screen and the Google panel
with a real key. Changing text size mid-trip still clips the step list until relaunch, and closing the
app before a trip reaches the road ends that trip on reopen (#135 is parked).

## Build 83: build 82 feedback and car checks (historical)

On 2026-11-16 the owner filed two build 82 reports after driving with an iPhone 15 Pro Max on
iOS 26.6.1 and a small Toyota head unit: CarPlay was cluttered and Share ETA was broken. Build 83
contains [#139](https://github.com/yassinsolim/NavOSS/pull/139) (`f2df5d3`), which fixes the
clipped phone share sheet using a scene-backed window and drops its "Shared from NavOSS" suffix;
[#140](https://github.com/yassinsolim/NavOSS/pull/140) (`ccd3fd6`) and
[#141](https://github.com/yassinsolim/NavOSS/pull/141) (`2eac789`), which change the guidance card,
car-screen-scale symbols and controls; and [#142](https://github.com/yassinsolim/NavOSS/pull/142)
(`2cb5c70`), which restyles the map, route and camera, fixes route fitting, compacts speed and
updates the road pill, attribution and rendering work. The share fix was verified in an iOS 26.5
Release simulator, not on iOS 26.6.1 hardware.

- [ ] On the phone, open Share ETA and Share place and check the full system sheet.
- [ ] In the car, check that the guidance card is readable at a glance and nothing overlaps on that
      display; tap to reveal the bar and confirm End is reachable.
- [ ] Check the speed unit's position as chrome appears and disappears, the current road name, and
      night appearance. Check sunlight legibility when conditions allow.

The simulator map harness uses mocked chrome and the card layout was probed against Apple's layout
code; neither captured real CarPlay chrome. Build 83's own binary was not captured with the offline
restyle. Actual safe-area insets and frame pacing on a phone or head unit are also unverified.

The [build 83 release record](testflight.md#build-83-build-82-feedback-validation-and-limits-2026-11-17)
includes simulator validation and the known phone and card-wording limits. Real CarPlay chrome, a
head unit and iOS 26.6.1 hardware have not been checked for build 83. Closing the app before its
first route match still ends the trip on relaunch; #135 is parked.

## Build 84 owner checks

Build 84 includes #147 (`a1787ff`), #149 (`4031d25`), #150 (`eb61be1`), #148 (`683bc99`)
and the #144 Maestro label fixes. The production API was not redeployed. Check the signed build
while parked or with a passenger operating controls:

- [ ] **Phone guidance (#147).** Check the clock and battery on the light map and the controls and
      road name as the trip sheet expands and collapses. Check light, dark, Day map under dark
      system appearance and largest text. Release simulator validation at `cf2afaa` covered those
      appearances, a three-line banner with lanes and an iPhone SE-class simulator. VoiceOver driven
      by a person, Reduce Motion and camera/reroute/report-ahead cards stacked under the banner were
      not verified on screen; the stacked-card cases have unit tests only.
- [ ] **CarPlay card and map (#149).** Check wording and arrow size on the car display, especially
      Highway 401 Express/Collector and signed exit destinations. Check readability, overlaps or
      cut-off, End in the top bar, speed unit position, road name, night appearance and sunlight
      legibility. Real CarPlay chrome and a head unit have not been checked for build 84.
- [ ] **Offline CarPlay (#150).** Check preview and guidance in light and dark using an offline
      region, and the automatic switch when the hosted style fails. The restyle was captured on a
      simulator before build 84, but not from this binary; automatic switching remains unverified.
- [ ] **Phone and dependencies (#148).** Check search, route preview, guidance, Share ETA and offline
      maps on a physical iPhone. Release simulator validation parsed live production answers with
      the app's Zod 4.6.7. Generated OpenAPI was identical; MapLibre React Native 11.5.1 was
      deliberately deferred pending on-screen and offline-map validation.

### Build 84 open follow-ups

- [ ] **Fixed in [#153](https://github.com/yassinsolim/NavOSS/pull/153); the fix is in build 85, not build 84.** On a
      small phone with the trip sheet expanded, the road-events chip faded to about 15% but still
      took taps and VoiceOver focus, and the credits slid under the sheet. Below half opacity a
      floating control now takes no touches and leaves VoiceOver focus, and the bottom group is
      gone before a sheet covers it. Seen on a Release iPhone SE (3rd generation) and iPhone 15 Pro
      Max simulator; check on the build with VoiceOver.
- [ ] **Fixed in #153 and #154 (in build 85).** With Day map in dark system appearance, floating-button icons were nearly
      invisible: white on light glass. The buttons and pills now follow the basemap. Seen in all
      four light/dark system and Day/Night map combinations on a simulator.
- [ ] **Fixed in #153 and #154 (in build 85).** Report and recenter appeared without glass circles after a trip. Cause
      reproduced on a Release iPhone 15 Pro Max simulator: ending a trip with the trip sheet
      expanded mounts them inside the faded-out bottom group. They are now remounted when the group
      returns. Check by ending a trip from the expanded sheet on the build.
- [ ] Route preview did not refit after the simulated location jumped between cities.
- [ ] Changing to the largest text size mid-trip clips the trip-sheet step list until relaunch.
- [ ] A Montreal alternative reads "Exit 1-0 · Boulevard Roméo-Vachon Nord"; Square One's
      "stay on 403" step shows "401 East Express".
- [ ] Closing the app before a trip first matches its route ends the trip on relaunch; #135 is draft
      and parked. No live traffic is shown.

These findings are low except the pre-existing trip-restore and live-traffic limits. Real CarPlay
chrome, a head unit, a physical iPhone, iOS 26.6.x, the signed build and the other checks above remain
unverified. See the [build 84 release record](testflight.md#build-84-validation-and-known-limits-2026-11-20).

## Corrected candidate and prior binary hold

**Do not retry build 73 merely because its Apple agreement blocker is cleared.** Exact-core scratch probes reproduced a regression against build 70: after a five-minute GPS gap on a looping/out-and-back route, genuine fixes at 300 m can advance build 73's matcher to 3,680 m and arrival, while build 70 remains at 300 m without arrival. An uncapped reported speed can also open an unjustified far-ahead match. These probes are not physical-device evidence.

The minimal matcher fix [#100](https://github.com/yassinsolim/NavOSS/pull/100) passed independent review on `ec9b1f8` and a freshly rebuilt eight-phase harness, and merged as `d0594cd`. The review independently confirmed safe loop-gap behaviour, rejection of impossible jumps and correct divided-road handling, while ordinary/tunnel/arrival cases still worked. Source and results are retained in local ignored artifacts; none are physical-device proof.

The exact `d0594cd` tree was frozen on `release/matcher-candidate-20261114`. Hosted run `43601926831` selected Xcode 26.6, allocated build 74, built and verified its signed IPA, and skipped upload. This was a signing preflight, not TestFlight availability. Build 75 was subsequently uploaded from that tree.

Progress persistence and restore (#102) and traffic safeguards (#103 and #104) were outside that frozen candidate; restore and #104 shipped in build 80. The earlier go below is historical evidence; neither it nor Apple's agreement acceptance authorizes retrying the held build 73.

### Post-candidate verification (2026-11-14)

- **Production compatibility, actual shipping JS consumers:** a strict write-allow-list allowed only configuration/cameras reads and search/route computation. `/v2/config`, `/v1/search`, `/v1/routes` and `/v1/cameras` each returned HTTP 200; the client accepted three routes and 57 cameras. The server declared `/v1/routes`, community reports and live traffic off, and routing traffic unavailable. No `/v2/routes` or community write was sent. Evidence: local ignored `artifacts/release-validation/shipping-old-server-compat-20261114.json`. This was an API-consumer smoke, not a new simulator or head-unit run.
- **Restore #102, separate from the candidate:** independent probes compiled against exact head `07a7cd2` passed all 30 original checks and five boundary cases. Existing arrival deferrals preserve their original corroboration with normal, future and missing capture times; stationary biased fixes do not arrive, while genuinely driving in does. CI run `43608571630` passed JavaScript/TypeScript, native iOS core and CarPlay generated sources before merge `b934040`. Independent sources/results are in local ignored `artifacts/matcher-restore-review/07a7cd2-independent/`; owner-run service logs are in `artifacts/matcher-restore-review/service-e2e/`.
- Neither check changes the frozen candidate, allocates another build number, uploads a binary or proves real-vehicle CarPlay or App Attest.
- **Traffic safeguards #103 and #104, separate from the candidate:** each was merged only after an independent reviewer passed its exact head (`533bce7`, `7c15d11`) and CI was green. Independent probes reproduced, then confirmed closed: access-only node restrictions, terminal qualification across duplicate road copies, the operator check's entrypoint and matcher-endpoint binding (every network the API joins, case-folded names), late evidence ageing a completed sample, re-cut stop time, coordinate-based dwell continuation, client re-sorting of the server's route order, and a credential request returning 500 instead of 503 when the pool is exhausted. A credential request has no single deadline: each wait is bounded on its own (about 20 s worst case plus queries; CI measured 15.0 s). Rendered checks on the simulator (light, dark, default and largest text, live text-size change, old production through a write-blocking proxy) cover the route preview, traffic caption, Map appearance and the place sheet. Evidence is in local ignored `artifacts/dead-end-mask-review/`, `artifacts/traffic-invariant-review/` and `artifacts/traffic-freshness-ui/`.
- **Known gaps after these merges:** sheets that hold their own input state (search, report, stops) are not re-measured when the text size changes while they are open; CarPlay traffic attribution is covered by native tests only, not a render; the operator check was exercised against container records and a local Docker stack, never the production host.

## 0. Validation evidence (2026-11-13, `release/validation-0.2`, code `6180ffc`)

Release-validation pass on simulators only; no build was created or uploaded during it. (Later the same day a signed build 73 was produced from `a9e7c00` but its upload failed on a pending Apple agreement; see the status table in [testflight.md](testflight.md).) Code commit `6180ffc`: main `630e031` (with #93 and #94) plus the validation fixes in PR #92, with the core far-jump matcher change (`a8ebb6f`) reverted so it can ship in its own reviewed PR. The commit that adds this text changes documentation only.

| Check                                                                        | Result            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Five gates, PostGIS suites                                                   | Pass on `6180ffc` | `TURBO_FORCE=1` `check`, `lint`, `test`, `build`, `format:check` exit 0 with `NAVOSS_REQUIRE_TEST_DATABASE=1` on `postgis/postgis:16-3.5-alpine`; contracts 123, mobile 473, api 675 tests; `community-reports.db.test.ts` and `traffic-postgres.test.ts` ran. Licence notices, CarPlay splice and `git diff --check` clean                                                                                                                                                                                                                        |
| Native Swift tests                                                           | Pass on `6180ffc` | 375 tests, 0 failures, 0 skipped with `NAVOSS_OFFLINE_TEST_RELEASE` set to the local `2026-11-11-v1-798f5c442644` bundle                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Release simulator build, exclusions, bundle audit                            | Pass on `6180ffc` | `expo prebuild --clean` with the production-carplay env and `NAVOSS_APP_ATTEST_ENVIRONMENT=production`, private `TMPDIR`; Release `xcodebuild` (Xcode 27.2, unsigned); `check-release-exclusions.sh` all absent; entitlements `carplay-maps` and App Attest `production` (before the entitlement flag; build 75 shipped without App Attest, build 80 carries it); `NavOSSAPIURL` production; honest `NSMotionUsageDescription`                                                                                                                     |
| Navigation harness                                                           | Pass on `6180ffc` | `validate:navigation:ios` with a fresh Debug build: all eight phases (preflight, native tests, build, phone checkpoints, phone reroute, phone arrival, CarPlay visuals, pixel validation) and `NAVIGATION_VALIDATION_PASSED`. Interactive CarPlay is not available on this Mac (Xcode 27.2)                                                                                                                                                                                                                                                        |
| Production (old server), Release build, write-blocking proxy                 | Pass              | Search (Calgary Tower first from 4.4 km; University; University of Calgary; Costco; "Airport" lists Calgary International Airport first), place, save, preview, drives, automatic, ask-first (proposal stays 45 s; Accept installs) and keep-route reroute, arrival, background/foreground, relaunch restore and the "Trip ended" notice, Map appearance, Offline maps, About, dark mode, largest text size. Requests: `/v2/config`, `/v1/cameras`, `/v1/events`, `/v1/offline/manifest` (404, quiet), `/v1/search`, `/v1/routes`; nothing blocked |
| Local new server (AB+BC graph, traffic `live`, reports `attested`, manifest) | Pass              | Deerfoot exit 248 lanes and signposts; `/v2/routes` Edmonton, Vancouver, Calgary to Banff with lanes; 124 real Calgary incidents; "+5 min traffic" after a traffic replay; camera banner on screen ("Red light + speed camera · 440 m · Macleod Tr SW and 58 Av SW")                                                                                                                                                                                                                                                                               |
| Offline                                                                      | Pass              | Calgary region installed from the local manifest; API stopped: offline search ("Chinook Centre"), "Offline route · No traffic or closures", guidance with the exit 248 lane strip; API restarted: search and `/v2/routes` online again                                                                                                                                                                                                                                                                                                             |
| Community (Debug build, local server)                                        | Pass              | Share (installation registered, report `201`), see on a second simulator, "Still there" vote (`200`, "Thanks for confirming"), withdraw (`DELETE 200`). Development keys are untrusted by design, so the test promoted that installation to `attested` in the local database to make the report visible. A Debug simulator build must be built with local signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`); unsigned, the keychain refuses the key and sharing fails                                                                      |
| Maestro suite (local server)                                                 | Pass              | 15 flows: `about-privacy`, `camera-marker-icons`, `long-press-route`, `map-customization`, `map-place-details`, `place-save-favorite`, `report-road-condition`, `route-to-airport`, `route-to-university-avoid-highways`, `search-calgary-tower`, `search-multiple-locations`, `start-airport-simulation`, both `capture-carplay-*`, and `reviewer-route-preview` (needs a location outside coverage and a non-dev-client build). The `assert-*` flows run inside the harness scripts                                                              |
| Cannot pass against production by design                                     | —                 | Every flow that opens the dev-client deep link (`exp+navoss://…localhost:8081`); flows that rely on fixture-only places or answers (`Central Library` stop, fixture "Airport" ordering, `search-multiple-locations`); `report-road-condition` and community flows need a server with community features; `reviewer-route-preview` needs a location outside coverage                                                                                                                                                                                |

### Open defects from the pass

- **D17, harness arrival failure (fixed in the harness):** `replay-route-ios.mjs` searched for "Calgary International Airport" and took the first row with exactly that name, which with the current search ordering is the airport grounds on 78 Avenue NE, 1 km from the terminal the Maestro flow selects by typing "Airport". The arrival phase drove the last 180 m of the route to a different place, so the app was really off route and correctly showed the remaining distance to the terminal. The replay now uses the flow's search text and first-matching-row rule (`a2e3a0b`). The arrival phase no longer jumps the position to the last 180 m of a started downtown trip: it places the simulator 300 m before the airport on that route before planning, so the app plans and starts a real short trip, and the replay drives it in full at 8 m/s.
- **Matcher correctness (own pull requests):** the navigation core on `main` can match a fix to a later pass of a route that returns to its own neighbourhood (a loop that ends near its start, the other carriageway of a divided road) on the strength of reported speed times elapsed time or a single bad speed reading, and then arrive without the route having been driven; after a jump of several km along the route it can declare a vehicle that is on the route off route. The change that states the matching rules as invariants and closes these is under independent review. With it, a jump along the route that the elapsed time makes possible is believed on its second fix; a position further along than any vehicle could have driven in the time is not progress, goes off route and is rerouted once from where it is, keeping the stops not yet reached. The first fix of a trip restored after a relaunch was placed where it scores best, which on such a route can be its end (as in build 70); the follow-up saves the matcher's last confirmed state beside the active trip (distances along the route, capture time, reported speed, any waiting arrival) and resumes on the same evidence, shows a restored trip as "Resuming trip" with End and no guidance on the phone and CarPlay until a fix is matched on a confirmed pass, and is under its own review. Not decidable from GPS, and left waiting: a trip restored without saved progress where the vehicle stands still where two passes meet. Interactive CarPlay and a real head unit are not exercised by it.
- **D16, trip sheet invisible:** once, after accepting an ask-first proposal, the trip sheet (End, ETA, actions) was not drawn until relaunch; not reproduced on a second try.
- **Offline road names:** offline routes name multi-name roads "2 / Deerfoot Trail SE" (the online fix reads "Highway 2 / Deerfoot Trail SE"); the offline router's naming is in the core.
- **D12, preview camera:** twice the route preview opened without fitting the route (after closing About; after finishing a trip).
- **Text size changed while the app is open:** the trip sheet, banner, road pill, Explore chips, tab bar and map credits now re-measure; other sheets (route preview, place sheet) keep their old measurement until relaunch.
- **D6, road pill (accepted limitation):** the current-road pill shows the step's road name; Valhalla folds a name change without a maneuver into one step (e.g. "Cambrian Drive NW" continuing as 10 Street NW, "9 Avenue SW" continuing as 9 Avenue SE). Correct names need per-segment road names from the server.

### Known production issues for the owner (server side, independent of the app)

- **Calgary road events (D2):** `GET /v1/events` answered 503 on 2026-11-13. The #93 incident-feed fix is live after the 2026-11-15 deploy; `/v1/events` returned 200 with 149 events.
- **Search (D1):** fixed in the client by #94: with the pre-deploy server, "Airport" listed Calgary International Airport first. Near-duplicate rows were also observed then (four "University of Calgary" rows; five "University" transit rows for one station); their post-deploy status has not been verified.
- **Valhalla 503 on one reroute:** a single production `/v1/routes` reroute request answered 503 during a simulated drive and could not be reproduced.

### Local Release builds: use a private Metro cache (D10)

Metro's shared transform cache under `$TMPDIR` ignores a changed `EXPO_PUBLIC_API_URL`, even with `--reset-cache`, so a local Release build can embed the API origin of an earlier build. Set `TMPDIR` to a fresh directory for each local Release build or `export:embed`, and check the embedded origin. EAS builds start from a clean machine and are not affected.

## 0b. Validation of `main` before build 80 (2026-11-15, `7c3672a`)

Simulator pass by a dedicated agent; evidence in local ignored `artifacts/release-validation-main-20261115/`. Decision: conditional go for an internal build.

- **Passed:** five gates with caches off; PostGIS suites (739 of 739); 482 native tests; the eight-phase navigation harness with all 5 phone and 32 CarPlay captures inspected; against production through a write-blocking proxy: config and coverage text (Alberta and British Columbia), Banff preview over `/v2/routes`, a Calgary Tower to Airdrie drive with lane strips, exit 285 sign, a camera alert, an automatic reroute and arrival; kill and relaunch mid-trip resumed the same trip without a new route request; Google's panel for Calgary Tower with attribution, the nearest-listing caption and "Find this place on Google"; Community settings read "Not available yet" with both features off; the Offline maps sheet; a Release build with the Google profile (entitlements `carplay-maps` and App Attest `production`, release exclusions clean, Google key present and not printed). The app sent nothing to `/v2/community` or `/v2/traffic`.
- **Not seen on a render:** the Google panel's street-address case in this pass (earlier feature renders cover dark mode and the largest text size), the "Paused for a few minutes" traffic state, the "Resuming trip" banner (the simulated location never paused), Community settings across a live text-size change.
- **Observed:** two false reroutes on Deerfoot Trail that recurred with the route's raw points (up to 579 m apart) and not with points every 10 m, so most likely a replay artifact: confirm on a real drive. Once, the search sheet and map buttons did not return after closing Offline maps; it did not reproduce after relaunch.
- **G2, chosen route replaced at Start (build 81 validation; fix in review):** Square One to Scarborough Town Centre with the Express alternative chosen, started while parked 100 m from the road. Every route starts on the road, so three fixes from the parked car (about 6 s) were off route; the reroute asked for one route (`alternatives: 0`) and installed the server's Highway 401 Collector route, then repeated every 6 s while parked (production log: three `/v2/routes` 6.5 s apart). Reproduced in `NavigationTripStartTests` from recorded production routes in every reroute mode. Now, until the first fix matched on the route, a fix off the road counts as leaving it only when the vehicle moves 50 m further from the whole route than it has been, or has credibly driven more than 500 m beyond its starting distance from the route (travel is positional only: movement between fixes of more than 30 m and both accuracies; a reported speed never credits it and a stationary one vetoes it only within 100 m plus both accuracies of where travel was last counted, so parked GPS wander, multipath jumps and spurious speeds do not add up while a slow crawl does, and a vehicle circling inside about 30 m stays acquiring until it leaves; fixes worse than 50 m count neither way and are not a first match); such a reroute asks for alternatives and takes the one sharing most road with the chosen route. Until that first match the trip is shown as acquiring (raw position, no place on the route, nothing spoken). Not the cause of the Deerfoot false reroutes above: that vehicle was already matched, at speed, mid-trip. Confirm on a real drive: start parked away from the road with a non-first alternative chosen; the chosen route stays and no "Route updated" appears before you reach it.

## 1. Pre-upload conditions

- [ ] **Matcher regression resolved on the candidate SHA.** PR #100 or its successor has passed independent review, the build-70 comparison probes and a fresh navigation-harness run. Rebuild the candidate with this fix; do not reuse the held build 73.

- [ ] **Production and older-server compatibility.** Run the candidate commit on the simulator against the current production service: config accepted, search, route preview, guidance with lanes and signposts when supplied, camera alert, reroute and arrival. Also verify quiet v1 fallback against a server without `/v2/routes` and quiet unavailability for missing community or traffic capabilities. Evidence so far: #84 (phone and CarPlay, simulator, pre-deploy production config) and #85 (simulator through a write-blocking proxy to the pre-deploy API; unit test for 404 on `/v2/community/*` and `/v2/traffic/*`). The offline manifest client (#83) must also degrade quietly when `/v1/offline/manifest` is 404 or 503; production published the manifest on 2026-11-15.
- [x] **Historical candidate without App Attest.** Build 75 shipped without the entitlement; community writes were not supported and reports stayed private drafts. Build 80 carries the entitlement; verify the signed archive for each new candidate.
- [x] **App Attest provisioning (2026-11-15, owner-approved).** The App Attest capability is enabled on App ID `org.navoss.mobile`; the App Store provisioning profile was regenerated in the developer portal (it now carries `appattest-environment` and `carplay-maps`) and replaced in EAS; `NAVOSS_APP_ATTEST_ENTITLEMENT_ENABLED` is `1` in the three store profiles; hosted run `43674818814` (Xcode 26.6, no upload) signed build 76 with it, and the release workflow now refuses an archive whose entitlement is not `production`. The ad hoc profile is invalid until regenerated, so `internal-carplay` stays without the entitlement. Production reports publication is `attested`.
- [x] **App Privacy answers published (2026-11-15).** The eight data types are listed in `docs/release/app-store-metadata.md`; they were entered in App Store Connect with the owner's approval.
- [ ] **Real App Attest registration.** Verify the first physical iPhone registration on a build carrying the entitlement. Reports `attested` and traffic `collect` are enabled; at 16:52 UTC on 2026-11-15 no installation had registered.
- [ ] **First on-phone checks.** Install from TestFlight without Metro and check launch, production search, route preview and guidance, Google's place panel, and an offline download on a physical iPhone; record the build and outcomes. These were not exercised on a physical iPhone in the build 81 Canada pass.
- [ ] **511 source presentation.** On screen, verify 511 Alberta and Ontario 511 event rows, attribution and licence links in build 81 or later.
- [ ] **511 and city-feed overlap.** On screen, check whether the two 511 sources duplicate city-feed events for the same incident.
- [ ] **Release exclusions.** Run `apps/mobile/scripts/check-release-exclusions.sh` against the Release archive: the DEBUG-only software App Attest key and simulator harness code must be absent from device builds.
- [ ] **Privacy manifest.** The app privacy manifest, SDK manifests, App Store Connect App Privacy answers and the permission string agree. The Disk Space condition is met on `main`: #83 merged and `apps/mobile/app.json` declares `NSPrivacyAccessedAPICategoryDiskSpace` (verify it in the signed archive). The permission string and App Privacy changes for community features are in [app-store-metadata.md](app-store-metadata.md#app-privacy-answers-needed-before-community-features-are-enabled); they must be in place before the server enables community features, and are best shipped in this build.
- [x] **External distribution is manual (#88).** App Store Connect showed build 85 Testing for NavOSS Friends; no installs or sessions have been observed yet.
- [ ] **Build number.** `appVersionSource` is `remote`: the latest uploaded build is 85. Record the actual number and commit in [testflight.md](testflight.md) after any later build exists.
- [ ] **Gates on the candidate commit:** `corepack pnpm check`, `lint`, `test`, `build`, `format:check`; `corepack pnpm --filter @navoss/mobile test:native:ios`; a full Xcode compile with CarPlay enabled; `corepack pnpm validate:navigation:ios`. Read each command's exit status.
- [ ] **Claims.** Distinguish the Canada service and distributed build 81 from build 70's v1 behavior. Live traffic remains unavailable; lanes and signs appear only when returned; offline maps cover Alberta and Calgary only. The province-wide road-events list is not in builds 75 or 80.
- [ ] **Long-trip formatting (Canada pass F1).** #127 (`36c8a9f`) is in build 82. Phone long-trip text was seen in a Release simulator; on screen in CarPlay, check the route choice distance and duration, since the CarPlay formatter change has not been seen on screen.
- [ ] **Three known low items.** Check and record the route-only signpost omitted by design, arrival times in the device time zone, and the collapsed outside-coverage notice potentially hidden behind the tab bar at the largest text size. Do not treat them as fixed.
- [ ] CarPlay entitlement, template scene, `location` background mode and production API origin audited in the signed IPA (existing audit in [ci-cd.md](ci-cd.md)).

### App Privacy answers for a Google-profile build (`production-carplay-google`)

Enter these in App Store Connect only for an artifact built with the Google profile; the default
`production-carplay` build keeps its current answers. They come from the privacy manifests embedded
in GooglePlacesSwift 10.15.0 (`GooglePlacesSwift.bundle`: declares nothing) and its Google Places
SDK (`GooglePlaces.bundle`), read from the pods on 2026-11-15. Add them to the existing NavOSS
answers (Other User Content, linked, App Functionality, no tracking).

| App Store Connect data type      | Linked to the user | Used for tracking | Purposes                     |
| -------------------------------- | ------------------ | ----------------- | ---------------------------- |
| Location → Precise Location      | No                 | No                | Analytics, App Functionality |
| Location → Coarse Location       | No                 | No                | Analytics, App Functionality |
| Identifiers → Device ID          | Yes                | No                | Analytics, App Functionality |
| Other Data → Other Data Types    | Yes                | No                | Analytics                    |
| Diagnostics → Performance Data   | No                 | No                | Analytics                    |
| Usage Data → Product Interaction | No                 | No                | Analytics                    |
| Search History → Search History  | No                 | No                | Analytics                    |

The SDK manifest also lists required-reason APIs (file timestamp `C617.1`; user defaults `1C8F.1`,
`C56D.1`, `CA92.1`); those are not App Privacy answers. Use the Google-build review note in
`app-store-metadata.md`. Before upload, check the IPA has `NavOSSGooglePlacesEnabled` and
`GooglePlacesSwiftResources.bundle` (the hosted workflow does this) and that the hosted privacy
policy is the November 15, 2026 version.

## 2. Head-unit checklist

Run on an entitled physical head unit, parked or passenger-operated. Record build number, phone, iOS version, vehicle and wired or wireless. Do not record route coordinates or trip history. The owner reported on build 82 in a car; a full wired/wireless validation of the current changes remains outstanding. Interactive CarPlay has not been exercised on the maintainer's Mac (Xcode 27.2 has no CarPlay Simulator window).

### A. CarPlay quality pass (22 items: the 19 from the PR #77 report plus the 3 added after its core integration)

1. Connect with the phone locked: the map opens on your position, not central Calgary, within a few seconds.
2. Search > Gas: a list appears at once saying "Searching…", then fills nearest first with distances.
3. Mic in Search, say "Navigate to Calgary Tower": the result list opens immediately and fills. Car radio comes back after recording.
4. Turn off Dictation and try voice: the failure screen offers retry, Type a destination, and Home/Work/recents.
5. Preview with alternatives > Go: guidance starts, and the map follows heading-up with the car beside the turn card.
6. Approach a turn: the card symbol matches the junction, "then" appears for close turns, a white arrow sits on the road, and the bottom label names the road you're on.
7. Roundabout: the card shows the numbered exit, and the map arrow follows the circle.
8. Speed through a known limit: the badge turns red at 5 km/h or more over, and never with an unknown limit.
9. Leave the route: the "New route" alert shows and guidance continues.
10. Switch to Music mid-preview and back: the preview and its route choices are still there.
11. Report button > a type: back on the map within two taps with a "saved privately" banner (with reporting unavailable: "Kept privately on this iPhone. Not shared with other drivers.").
12. Trip > Stops > a stop > Remove: alternatives show, and the old trip guides until you choose.
13. Arrive: the "You've arrived" alert stays, and Done ends the trip on both CarPlay and the phone.
14. Spoken prompts over music: the music dips only during the prompt and comes back afterwards.
15. Dusk or headlights on: the map switches to dark.
16. Dashboard: the route, arrow and speed show; Go and Voice open NavOSS.
17. Car with a cluster or HUD: the NavOSS map appears there, and the car's zoom controls work.
18. Siri, "Navigate to Home with NavOSS": routes appear on CarPlay and nothing starts until you tap Go.
19. Disconnect and reconnect mid-trip: guidance, turns and the route are restored.
20. Ask-first reroute: with Rerouting set to Ask first, leave the route; the alert states the real time and distance change; tap **Use new route** once and **Keep mine** once.
21. Camera banner and marker on approach to a Calgary intersection safety camera.
22. Settings: change **Rerouting** and **Speeding warning** from CarPlay; the phone's Guidance settings follow.

Carried-over open items from [testflight.md](testflight.md) (builds 54 and 70): vehicle-microphone voice search after permission approval, head-unit music restoration, cornering and wake-without-jump with the handset locked, reconnect while locked, Dashboard-only, and the route-preview Start control at the largest accessibility text size. The Copilot review on #77 also raised three cases worth trying: a multi-arrow lane that lacks an active indication must not highlight "straight" for a right turn; a Siri shortcut to a place that is not in the saved-place catalog after a restart; and "Home" and "Work" queries when the saved place has a different name.

### B. Community checks (only against a build that contains #85 and a server where the feature is on)

Against a server with community features off (old-server compatibility):

- [ ] CarPlay Settings > Community shows Share road reports, Share traffic speeds and Spoken road reports, all off. Turning on Share traffic speeds shows "Not available yet" and nothing is uploaded.
- [ ] The report grid is titled "Report (private)" and a report stays a private draft.

Against a server with reports enabled (publication `attested`, App Attest configured):

- [ ] First shared report registers the installation (real App Attest on a physical iPhone: this has **never** been run; #85 verified only the simulator's development key).
- [ ] With Share road reports off the grid says "Report (private)"; with it on, "Report to drivers".
- [ ] A report within 400 m of saved Home or Work, or a trip's start, destination or stop, stays private and says why.
- [ ] A shared report appears as an unconfirmed marker on the CarPlay map and the phone map; a second installation's "Still there" makes it confirmed; "Not there" removes it.
- [ ] Report-ahead banner at most once per trip within about 800 m; spoken alert only with Spoken road reports on and sound mode allowing it.
- [ ] "Still there?" is a `CPNavigationAlert` shown only after passing a report, never near a turn, never over another alert; Dismiss and timeout send nothing; the alert withdraws if a maneuver comes near (reviewed in code only so far).
- [ ] **Reset community identity** (phone) deletes the installation, its reports and answers; a later report registers a new key.
- [ ] Traffic: with Share traffic speeds on, a new installation shows "starts tomorrow"; after a day, uploads occur only during turn-by-turn; the first and last 400 m of a trip and the area around stops are not uploaded (needs server-side evidence, not only the app).

### C. Offline checks

Production published the manifest and R2 bundles on 2026-11-15. A Debug simulator downloaded Calgary from the real hostname, paused and resumed, then searched and planned a route with the API stopped. A download in build 80 on a physical iPhone is still outstanding.

- [ ] The Offline maps sheet says the feature is not available when the manifest endpoint is 404 or 503 (test against a server without the manifest).
- [ ] Download, pause, resume, update and delete a region; free-space check; the bundle is excluded from iCloud backup.
- [ ] In airplane mode: offline map, address and category search, an offline route with alternatives labelled as offline, guidance, off-route reroute computed on the device, CarPlay search and route preview.
- [ ] Route and search are online first when a network exists; the style falls back to the offline bundle when the hosted style fails.

## 3. Server enablement order

Follow [infra/compose/README.md](../../infra/compose/README.md) and the checklist in [community-traffic.md](../architecture/community-traffic.md#enablement-checklist). Each step names its evidence. Roll back by the method named in the same document.

1. [x] **Record and prepare (2026-11-15).** Previous image retained as `navoss-api:pre-provincial-v2` (`351acadeaa57`); previous source tree retained at `~/NavOSS.prev-20261115`. Before cutover, logical PostgreSQL backup `navoss-20261115T033116Z.sql.gz` and Proxmox snapshot `pre-deploy-20261115` were taken; the snapshot was deleted after verification. Geospatial artifacts and additive migrations remain in place.
2. [x] **Deploy the image and migrate (2026-11-15).** Commit `f780903` was deployed as `navoss-api:latest` (`9001dda4444f`). Migrations `0001_community_reports`, `0002_community_traffic` and `0003_traffic_publication_marker` were applied. The updated `check-stack.sh` passed on the VM. At that deployment reports publication was `shadow` with `features.communityReports` false and no App Attest team id or installation secret; `COMMUNITY_TRAFFIC_MODE=off`, and `/v2/traffic/status` reported off. The offline manifest then returned 503; it was published later on 2026-11-15.
3. [x] **Verify with the 22-route matrix (2026-11-15).** Locally on the VM and through `https://navoss-api.yassin.app`, `/v1/config` remained strict v1 (`calgary-ab`, `/v1/routes`); `/v2/config` reported `alberta-british-columbia`, `/v2/routes`, and service areas `alberta` and `british-columbia`; the Calgary Deerfoot/Glenmore fixture returned exit 248 with lanes; `/ready` was ready. The complete 22-directed-route Alberta+BC matrix passed 22/22 (local ignored `artifacts/deploy-20261115/route-quality-alberta-bc-22.json`). The app's JS client planned Calgary to Banff (128 km) over v2 with lane and signpost steps. `/v1/events` returned 200 with 149 events (#93 is live), and `/v1/cameras` returned 57 cameras. Build 70 continues to use v1; build 75 uses v2. Interactive CarPlay remains unverified on a head unit.
4. [x] **App Attest (2026-11-15).** Production App Attest configuration is in place. Never use `allow-development` on production or casually rotate the installation secret: rotation orphans every installation. The first physical iPhone registration remains outstanding.
5. [x] **Reports publication (2026-11-15).** `COMMUNITY_REPORTS_PUBLICATION=attested` is enabled. Setting it back to `shadow` is the kill switch; `corroborated` is stricter.
6. [x] **Traffic collection (2026-11-15).** `COMMUNITY_TRAFFIC_MODE=collect` is enabled for evaluation. Batches are matched and counted in memory, never published. **Live remains off:** `features.liveTraffic` stays false; move to `live` only after "Before `live`" is ticked and residual risks are accepted in writing.
7. [x] **Publish the truth.** Privacy policy and site copy describe report publication and traffic collection. Keep them aligned with deployed behaviour.
8. [x] **Offline hosting (2026-11-15).** Cloudflare R2 bundles, the public hostname, manifest and `navoss-offline-guard.timer` are in place. The guard runs every five minutes and withdraws the manifest and disables the hostname when usage exceeds the thresholds or cannot be read for four consecutive runs; see [offline hosting](../architecture/offline.md#hosting-cloudflare-r2). A physical iPhone download on build 80 remains unverified.
