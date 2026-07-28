# Navigation product comparison

Date: 2026-07-28

## Purpose

This document compares observable Google Maps and Waze behavior with NavOSS to
identify original, lawful product improvements. It is not a claim of feature
parity and does not authorize copying interfaces, assets, map data, reviews, or
private APIs.

## Test boundary

A direct App Store comparison cannot be completed in iOS Simulator. The
simulator has no App Store and cannot run App Store device binaries for Google
Maps or Waze. The phone comparison was subsequently completed on a connected
iPhone 15 Pro Max running iOS 26.5.2 with NavOSS 0.1.0 (17), Google Maps 26.29.1,
and Waze 5.21.0. Real CarPlay comparison remains blocked until the phone is
connected to a real CarPlay system.

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

| Area             | Google Maps                                                                                                                                                                             | Waze                                                                                                                                                                                                                                                                                  | NavOSS today                                                                                                                                                                                                                                         | Product implication                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nearby discovery | Coordinated map and list; physical testing showed ratings, review counts, open state, accessibility, fuel prices, calling, per-result actions, and filters.                             | Physical testing showed quick Gas, Food, Parking, and Groceries categories plus route-oriented search.                                                                                                                                                                                | Calgary categories and typed search overfetch 20 proximity candidates, recompute exact distance on-device, and show the nearest 8. Saved Home, Work, favourites, and recents are available.                                                          | Preserve closest-first behavior. Add richer open-data details only when sourced and fresh. Fuel prices need a licensed or official source.                                               |
| Place trust      | Google-hosted ratings and reviews are prominent.                                                                                                                                        | Community and place data are native to Waze.                                                                                                                                                                                                                                          | Default builds show no copied rating. An explicit Google Maps reviews link remains available; optional Google-rendered rating support is disabled.                                                                                                   | Do not scrape or restyle Google reviews. Keep provider attribution and fail closed when optional SDK configuration is absent.                                                            |
| Route choice     | Best route is selected and alternatives remain visible; each route shows an ETA. Physical testing exposed travel modes, stops, save, share, route options, and traffic-aware selection. | Physical testing showed ETA, arrival, distance, via roads, route events, departure planning, stops, fuel/food/parking search, and drive sharing.                                                                                                                                      | Route preview shows selected and muted alternatives, ETA, distance, via-road context, and avoid-highways recalculation. The tested local route closely matched Waze.                                                                                 | Route-choice presentation is competitive for a Calgary beta. Multi-stop routing is later work. Never imply traffic-aware ETA while traffic is unavailable.                               |
| Guidance         | Physical guidance exposed maneuver distance, speed limit, map controls, mute, route search, fuel-efficient route status, location sharing, reports, and End.                            | Physical guidance exposed maneuver distance, speed, map controls, route overview, sharing, reports, and optional voice reporting.                                                                                                                                                     | Native contract v8 owns matched progress, rerouting, arrival, background continuation, maneuver speech, and phone/CarPlay state. Physical testing confirmed lock recovery and End cleanup. CarPlay trims travelled geometry and keeps End available. | Physical wired and wireless CarPlay validation is still a release gate. Speed-limit, lane, live-traffic, and offline features require reliable data or later work.                       |
| Traffic          | Traffic conditions can affect displayed routes and ETAs.                                                                                                                                | Drivers can report traffic, heavy traffic, or standstill traffic.                                                                                                                                                                                                                     | Production explicitly reports traffic as unavailable.                                                                                                                                                                                                | Keep the current honest unavailable state until a licensed feed passes routing-quality and vehicle-use review. Local shadow traffic drafts must not affect routes.                       |
| Road reports     | Incident display exists, but this review did not exercise live submission.                                                                                                              | Official documentation lists traffic, crashes, hazards, closures, construction, car on shoulder, broken signals, potholes, and objects. A closure affects the reporter immediately but appears publicly only after corroboration and is removed when drivers traverse the road again. | Reports are fixed-choice, precise-coordinate, local-only drafts that expire after two hours. Choices cover crash, closure, slow traffic, construction, pothole, object on road, other hazard, and stopped vehicle.                                   | Keep all drafts private until identity, rate limits, proximity checks, independent confirmation, expiry, moderation, and kill switches exist. Do not add police or checkpoint reporting. |
| CarPlay          | Requires testing in the installed app on real CarPlay.                                                                                                                                  | Official help documents reporting on CarPlay, but the installed flow was not available for this review.                                                                                                                                                                               | Native search, alternatives, preview, guidance, rerouting, arrival, speech, and persistent End controls are implemented.                                                                                                                             | Simulator rendering is useful evidence, not a substitute for a head-unit drive.                                                                                                          |

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
- Multi-stop and offline navigation.
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
