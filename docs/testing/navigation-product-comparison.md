# Navigation product comparison

Date: 2026-08-01

## Purpose

This document compares observable Google Maps and Waze behavior with NavOSS to
identify original, lawful product improvements. It is not a claim of feature
parity and does not authorize copying interfaces, assets, map data, reviews, or
private APIs.

The follow-up [navigation feature demand synthesis](navigation-feature-demand.md) adds Apple Maps,
public user-request evidence, a ranked top ten, and a phased NavOSS implementation decision.

## Test boundary

An iOS runtime simulator cannot install App Store device binaries for Google Maps or Waze. The
phone comparison was completed on an iPhone 15 Pro Max running iOS 26.5.2 with NavOSS, Google Maps,
and Waze. On 2026-08-01, Apple's signed CarPlay Simulator from Additional Tools for Xcode 26.6 was
installed and connected to that iPhone over USB. This enabled direct comparison of all three apps
in the same standard 800 x 480 CarPlay navigation configuration. A real wired and wireless head
unit remains required for vehicle input, lock, Siri, radio ducking, and reconnect validation.

This review used:

- public Google Maps and Waze web experiences;
- official Google Maps and Waze help documentation;
- physical iPhone black-box testing through XCUITest;
- existing simulator, native iOS, and CarPlay validation evidence;
- no submitted crash, police, construction, closure, or traffic reports.

Local browser captures were taken for a Calgary gas search and an Aspen Woods
route. They are intentionally excluded from version control because they contain
third-party map imagery.

The NavOSS report flow passed on the dedicated iPhone SE simulator after the
comparison changes. All eight choices and the private-testing notice were
visible, a Construction draft saved locally, and End returned to route preview.

## CarPlay simulator follow-up

The 2026-07-31 deterministic renderer follow-up was supplemented on 2026-08-01 by a direct,
side-by-side physical-iPhone session in Apple's standalone CarPlay Simulator. NavOSS build 35,
Google Maps, and Waze were opened in the same vehicle configuration. No incident was submitted, all
routes were started while parked, and temporary captures containing private location or saved-place
data were deleted after local inspection.

The six NavOSS preview, dark-mode, early-progress, late-progress, overview, and clear-route frames
passed native compilation, route-pixel, blank-frame, stale-frame, and visual-distinction checks.
The review also fixed the reported speed-overlay collision, speech audio-session release, and
disappearing final route segment. Active guidance now hides POI layers, shows a mode-specific sound
button that opens only sound choices, and labels the persistent root action **Trip** instead of
**Search**.

The direct session found and fixed three more NavOSS defects:

- CarPlay category tiles used unfiltered text search. **Gas** returned fuel-industry businesses and
  produced a 30-minute, 26.8 km route while Google Maps and Waze returned nearby filling stations.
  Every CarPlay tile now sends the API's existing strict category, including fuel, cafe, bar,
  parking, pharmacy, shopping centre, hotel, healthcare, charging, repair, and car wash.
- A list template restored transparently over the map after switching away from and back to NavOSS.
  Scene activation now cancels stale search work and returns to the root map.
- An idle NavOSS launch could remain on a broad Calgary overview. Style loading and scene resume now
  re-establish user tracking when no route is displayed.

Google and Waze category screens use large familiar icons and disclosure affordances. NavOSS keeps
its richer list, Home, Work, favourites, and recents, but now adds SF Symbols and disclosure
indicators to category rows and icons to settings rows. NavOSS and Waze both provide three sound
modes: all guidance, alerts only, and muted. NavOSS active guidance keeps End, overview/follow,
sound, and private Report controls directly available; its sound icon now reflects the selected
mode instead of appearing as a generic gear.

The exhaustive status and implementation decisions are tracked in
[CarPlay feature parity matrix](carplay-feature-parity.md).

Official Google Maps CarPlay documentation confirms in-route stop search, free-form voice search,
incident reporting and voting, and alert controls. Official Waze documentation confirms search,
audio controls, nearby categories, reporting, and supported instrument-cluster navigation. The
remaining NavOSS priorities are:

1. Validate the implemented Add stop, active route alternatives, route options, map orientation,
   and synchronized phone/CarPlay sound controls in a new signed build.
2. Repeat the completed `CPMapTemplate` interaction audit on wired and wireless head units,
   including reconnect, locked-phone continuation, speech/radio mixing, rotary input, and arrival.
3. Add Dashboard or cluster metadata only after a separately gated implementation and supported
   vehicle test. Do not infer support from the main-map simulator harness.
4. Keep public incident display and voting plus traffic-aware ETA blocked until the existing trust,
   moderation, licensed-data, and route-quality gates are met.

## Physical iPhone findings

The physical comparison used the same Aspen-area location and nearest Shell
destination. Build 17 launched from TestFlight and remained stable throughout
the session.

- NavOSS Gas results were ordered nearest-first from 470 m through 3.6 km. Shell,
  Petro-Canada, and Calgary Co-op were the first three results.
- The Shell details sheet exposed Directions, Save, Share, OpenStreetMap
  attribution, and explicit Google Maps rating and review handoffs. The review
  action opened the matching place in Google Maps.
- NavOSS selected a 650 m, four-minute route and showed an 890 m alternative
  with the same ETA. The shorter equal-ETA route remained selected.
- Waze selected a 0.4 mi route, approximately 644 m, using the same local roads.
  This independently supports the NavOSS route rather than indicating an
  unsafe shortcut.
- NavOSS active guidance showed a 50 m maneuver, metric distance, ETA, arrival
  time, Share ETA, Report, and End. The matched arrow and remaining route began
  at the vehicle position.
- Locking and reopening the phone preserved the active NavOSS trip. Canceling
  the report sheet and ending guidance returned to route preview.
- Build 17 exposed the original four private report choices. The expanded eight
  choices in this change passed separately on the iPhone SE simulator and are
  intended for the next build.
- Google Maps showed ratings, review counts, opening hours, accessibility, fuel
  prices, calling, photos, and service filters. NavOSS does not own or license
  equivalent data and correctly hands it off instead of copying it.
- Google Maps guidance exposed speed limit, route search, mute, fuel-efficient
  route status, location sharing, reporting, and End. Its report menu listed
  Crash, Slowdown, Police, Construction, Lane closure, Object on road, Flooded
  road, and More.
- Waze guidance exposed route events, departure planning, stops, gas, food,
  parking, drive sharing, speed, reporting, and optional voice reporting. Its
  report menu listed Traffic, Police, Crash, Hazard, Closure, Blocked lane, Map
  issue, Bad weather, Gas prices, Roadside help, and Place.
- No competitor report category was selected and no report was submitted.

## Observed comparison

| Area             | Google Maps                                                                                                                                                                             | Waze                                                                                                                                                                                                                                                                                  | NavOSS today                                                                                                                                                                                                                                         | Product implication                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nearby discovery | Coordinated map and list; physical testing showed ratings, review counts, open state, accessibility, fuel prices, calling, per-result actions, and filters.                             | Physical testing showed quick Gas, Food, Parking, and Groceries categories plus route-oriented search.                                                                                                                                                                                | Calgary categories and typed search overfetch 20 proximity candidates, recompute exact distance on-device, and show the nearest 8. Saved Home, Work, favourites, and recents are available.                                                          | Preserve closest-first behavior. Add richer open-data details only when sourced and fresh. Fuel prices need a licensed or official source.                                                   |
| Place trust      | Google-hosted ratings and reviews are prominent.                                                                                                                                        | Community and place data are native to Waze.                                                                                                                                                                                                                                          | Default builds show no copied rating. An explicit Google Maps reviews link remains available; optional Google-rendered rating support is disabled.                                                                                                   | Do not scrape or restyle Google reviews. Keep provider attribution and fail closed when optional SDK configuration is absent.                                                                |
| Route choice     | Best route is selected and alternatives remain visible; each route shows an ETA. Physical testing exposed travel modes, stops, save, share, route options, and traffic-aware selection. | Physical testing showed ETA, arrival, distance, via roads, route events, departure planning, stops, fuel/food/parking search, and drive sharing.                                                                                                                                      | Route preview shows selected and muted alternatives, ETA, distance, via-road context, avoid-highways recalculation, and up to eight ordered intermediate stops with phone add/remove/reorder. The tested local route closely matched Waze.           | Route-choice presentation is competitive for a Calgary beta. CarPlay can add stops; parked CarPlay stop removal/reorder remains later work. Never imply traffic-aware ETA while unavailable. |
| Guidance         | Physical guidance exposed maneuver distance, speed limit, map controls, mute, route search, fuel-efficient route status, location sharing, reports, and End.                            | Physical guidance exposed maneuver distance, speed, map controls, route overview, sharing, reports, and optional voice reporting.                                                                                                                                                     | Native contract v8 owns matched progress, rerouting, arrival, background continuation, maneuver speech, and phone/CarPlay state. Physical testing confirmed lock recovery and End cleanup. CarPlay trims travelled geometry and keeps End available. | Physical wired and wireless CarPlay validation is still a release gate. Speed-limit, lane, live-traffic, and offline features require reliable data or later work.                           |
| Traffic          | Traffic conditions can affect displayed routes and ETAs.                                                                                                                                | Drivers can report traffic, heavy traffic, or standstill traffic.                                                                                                                                                                                                                     | Production explicitly reports traffic as unavailable.                                                                                                                                                                                                | Keep the current honest unavailable state until a licensed feed passes routing-quality and vehicle-use review. Local shadow traffic drafts must not affect routes.                           |
| Road reports     | Incident display exists, but this review did not exercise live submission.                                                                                                              | Official documentation lists traffic, crashes, hazards, closures, construction, car on shoulder, broken signals, potholes, and objects. A closure affects the reporter immediately but appears publicly only after corroboration and is removed when drivers traverse the road again. | Reports are fixed-choice, precise-coordinate, local-only drafts that expire after two hours. Choices cover crash, closure, slow traffic, construction, pothole, object on road, other hazard, and stopped vehicle.                                   | Keep all drafts private until identity, rate limits, proximity checks, independent confirmation, expiry, moderation, and kill switches exist. Do not add police or checkpoint reporting.     |
| CarPlay          | Requires testing in the installed app on real CarPlay.                                                                                                                                  | Official help documents reporting on CarPlay, but the installed flow was not available for this review.                                                                                                                                                                               | Native search, alternatives, preview, guidance, rerouting, arrival, speech, and persistent End controls are implemented.                                                                                                                             | Simulator rendering is useful evidence, not a substitute for a head-unit drive.                                                                                                              |

## Production gates

### Before a broader public beta

- Complete a moving physical iPhone drive with build 17 or later. Stationary
  physical discovery, route, guidance, lock recovery, reporting, and End checks
  are complete.
- Validate wired and wireless CarPlay reconnect, start, reroute, arrival, End,
  backgrounding, voice interruption, and phone/CarPlay synchronization.
- Compare the same public Calgary origin and destination in all three apps,
  recording route geometry, ETA, distance, alternatives, maneuver timing, and
  recovery after one intentional missed turn.
- Open competitor report menus for comparison but do not submit fabricated
  incidents. Perform any NavOSS report test only in local shadow mode.
- Repeat the report-sheet check with supported larger-text accessibility
  settings; the default-size iPhone SE check is complete.
- Keep live traffic, public reports, Google ratings, and unsupported coverage
  visibly unavailable rather than presenting placeholder data as live.

### Before public crowdsourced reports

- Use App Attest-backed pseudonymous installation identity.
- Enforce server and device rate limits with replay protection.
- Require proximity-verified independent Present or Not present votes.
- Reject self-confirmation and keep credibility scores private.
- Apply type-specific expiry and route relevance rules.
- Add moderation, auditability, emergency kill switches, and a staged shadow
  launch before any report becomes public or changes routing.

### Later product work

- Licensed traffic evaluation and traffic-aware route-quality gates.
- Official closure ingestion before community closure routing effects.
- Offline routing and parked CarPlay stop removal/reordering; phone multi-stop and CarPlay stop
  addition are already implemented.
- Ontario search and routing only after dedicated data imports and quality
  validation; Toronto camera markers alone are not Ontario coverage.

## Physical comparison protocol

1. Confirm current NavOSS, Google Maps, and Waze versions on the paired iPhone.
2. Connect the same phone to a real CarPlay system and record app versions,
   NavOSS build, iOS version, vehicle/head-unit model, and wired or wireless mode.
3. Use one short urban route and one highway route in Calgary at the same time of
   day. Keep origins, destinations, units, and avoid settings equivalent.
4. Capture discovery, place details, alternatives, active guidance, one missed
   turn, arrival, and End. Have a passenger operate and capture controls.
5. Inspect report choices without submitting a report unless a real condition is
   present and it is safe and lawful to report.
6. Record differences as requirements, not as instructions to reproduce another
   product's visual design.

## Official references

- [Google Maps: get directions and show routes](https://support.google.com/maps/answer/144339?hl=en)
- [Waze: report traffic](https://support.google.com/waze/answer/13740207?hl=en)
- [Waze: report a crash](https://support.google.com/waze/answer/13739612?hl=en)
- [Waze: report road hazards](https://support.google.com/waze/answer/13739290?hl=en)
- [Waze: report road closures](https://support.google.com/waze/answer/13753511?hl=en)
