# CarPlay feature parity matrix

Date: 2026-08-01

## Scope

This matrix covers observable Google Maps and Waze behavior on standard Apple CarPlay and maps each
capability to an honest NavOSS decision. It does not authorize copying branded UI, proprietary map
content, private APIs, community data, or enforcement-reporting features.

Evidence combines:

- a direct physical-iPhone comparison in Apple's CarPlay Simulator 26.6 at 800 x 480;
- current official Google Maps, Waze, and Apple CarPlay documentation;
- NavOSS source, contracts, native tests, and deterministic CarPlay rendering checks.

No competitor incident was submitted. Test routes were started while parked. Temporary captures
containing private location or saved-place details were deleted after local inspection.

## Status legend

- **Matched**: available now in NavOSS.
- **Implemented**: added in the current working tree; requires a new signed build.
- **Next**: technically feasible, but requires a larger separately tested milestone.
- **Data gated**: requires reliable licensed, official, or moderated data.
- **Platform gated**: requires Apple/OEM support and physical vehicle validation.
- **Non-goal**: conflicts with NavOSS safety or privacy policy.

## Matrix

| Capability                                   | Google Maps / Waze baseline                                           | NavOSS status                             | Decision                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Idle map and live location                   | Both center on the vehicle and expose common map actions.             | **Implemented**                           | Re-establish idle tracking after style load and app resume.                                                                        |
| Typed destination search                     | Both support place/address search.                                    | **Matched**                               | Native `CPSearchTemplate`, local saved-place fallback, bounded results.                                                            |
| Voice destination search                     | Both expose voice search; Waze also supports Siri shortcuts.          | **Next**                                  | Add a system-owned Siri/App Intent flow; never record or retain raw speech in NavOSS.                                              |
| Nearby categories                            | Both prioritize large iconized gas/food/parking/coffee categories.    | **Implemented**                           | Strict API categories for every tile, SF Symbols, disclosure indicators.                                                           |
| Home, Work, favourites, recents              | Waze documents saved-place search; both expose frequent destinations. | **Matched**                               | Local-only account-free catalogue with bounded recents and clear controls.                                                         |
| Place details                                | Competitors expose richer place data and actions.                     | **Next / Data gated**                     | Parked read-only OSM details are feasible; ratings, photos, hours, and fuel prices require licensed/provider data.                 |
| Route alternatives before Start              | Both expose alternatives and ETA context.                             | **Matched**                               | Native `CPTrip` previews, selected green route, muted alternate, distance and duration.                                            |
| Route alternatives during guidance           | Waze documents in-trip alternatives.                                  | **Implemented**                           | Trip screen recalculates from current position; old trip remains active until Go.                                                  |
| Add stop during guidance                     | Google supports in-route search; Waze supports one stop.              | **Implemented**                           | Typed/category picker, up to eight total stops, alternatives before atomic replacement.                                            |
| Remove/reorder stops                         | Competitors support stop management with differing limits.            | **Partial / Next**                        | Phone supports add/remove/reorder. CarPlay add is implemented; CarPlay removal/reorder remains parked-only future work.            |
| Avoid highways                               | Both support it.                                                      | **Implemented**                           | Persistent CarPlay and phone switch; initial routes and reroutes preserve it.                                                      |
| Avoid tolls                                  | Both support it.                                                      | **Implemented**                           | Persistent CarPlay and phone switch; treated as a preference, not a guarantee.                                                     |
| Avoid ferries                                | Both support it.                                                      | **Implemented**                           | Persistent CarPlay and phone switch.                                                                                               |
| Avoid unpaved roads                          | Waze/vehicle profiles expose road restrictions; Google varies.        | **Implemented**                           | Existing Valhalla preference now exposed on phone and CarPlay.                                                                     |
| HOV/toll passes and toll prices              | Waze supports regional passes and estimated prices.                   | **Data gated**                            | Requires jurisdiction-specific authoritative restrictions and pricing; do not infer.                                               |
| Eco/vehicle-specific routing                 | Google supports fuel/EV profiles; Waze supports vehicle types.        | **Next / Data gated**                     | Requires validated energy model, charging/fuel data, and route-quality tests.                                                      |
| ETA, remaining time, distance                | Core navigation baseline.                                             | **Matched**                               | Native monotonic progress and `CPTravelEstimates`.                                                                                 |
| Current speed                                | Waze exposes it; Google varies by geography/version.                  | **Matched on CarPlay**                    | Valid nonnegative Core Location speed only; never inferred. Phone display is a later UI task.                                      |
| Posted speed limit                           | Both expose it where data exists.                                     | **Matched on CarPlay**                    | Geometry-aligned Valhalla/OSM values; unknown values stay hidden.                                                                  |
| Speeding threshold/audio warning             | Waze offers threshold and audible warning.                            | **Next**                                  | Add only after calibrated threshold UX and false-alert testing; posted limit must be known.                                        |
| Maneuver instructions and road names         | Both provide turn-by-turn guidance.                                   | **Matched**                               | Structured `CPManeuver`, road names, estimates, and Canadian speech.                                                               |
| Lane guidance, junction views, signposts     | Mature competitors expose richer lane/sign data.                      | **Data contract gated**                   | Route schemas currently discard lane/sign metadata. Add validated provider fields before UI.                                       |
| Automatic rerouting                          | Both reroute around missed turns and changing conditions.             | **Matched for off-route**                 | Accuracy-aware native hysteresis and waypoint preservation. No traffic-aware rerouting claim.                                      |
| Reroute consent / keep route                 | Waze may offer Change route or No thanks.                             | **Next**                                  | Add Automatic, Ask first, and Keep selected modes with route-impact preview.                                                       |
| Route explanations                           | Competitors expose limited reason/context.                            | **Next**                                  | Explain distance/time/avoid changes using deterministic route facts, not AI guesses.                                               |
| End navigation                               | Both keep a stop/exit path available.                                 | **Matched**                               | First active map control, Trip screen End button and row, idempotent teardown.                                                     |
| Route overview / follow                      | Common navigation control.                                            | **Matched**                               | One-tap full route and return to forward-biased follow.                                                                            |
| North-up / heading-up                        | Google exposes orientation; Waze behavior varies.                     | **Implemented**                           | Persistent CarPlay setting applied to idle and active cameras.                                                                     |
| Light/dark/automatic appearance              | Both follow or expose appearance choices.                             | **Matched**                               | Automatic, Light, Dark; high-contrast route casing.                                                                                |
| Map content / POI visibility                 | Competitors tune map density.                                         | **Matched**                               | Persistent POI toggle; POIs automatically hide during guidance for clarity.                                                        |
| Vehicle marker/avatar                        | Competitors offer vehicle avatars.                                    | **Matched**                               | Arrow or car marker, with correct absolute course.                                                                                 |
| Guidance sound modes                         | Waze has Sound on, Alerts only, Sound off.                            | **Implemented**                           | Same three modes on phone and CarPlay using one persisted native setting.                                                          |
| Guidance volume                              | Google/Waze use app or vehicle volume controls.                       | **Platform owned**                        | Keep volume controlled by iOS/vehicle; NavOSS activates only for prompts and notifies other audio on deactivation.                 |
| Voice choice/language                        | Competitors offer voice/language choices.                             | **Next**                                  | Evaluate installed system voices without bundling licensed voice assets.                                                           |
| Audio ducking and restoration                | Navigation prompts temporarily lower other audio.                     | **Implemented**                           | Bounded audio-session release retry after speech queue becomes idle.                                                               |
| Incident display and alerts                  | Both use live/community incident data.                                | **Data gated**                            | Official regional events exist on phone but do not affect routes/ETA. CarPlay display waits for route relevance and clutter tests. |
| Public incident reporting and voting         | Both accept and corroborate community reports.                        | **Data/trust gated**                      | Keep private two-hour drafts until App Attest identity, rate limits, corroboration, moderation, expiry, and kill switches exist.   |
| Police/checkpoint/mobile-enforcement reports | Both expose some regional enforcement categories.                     | **Non-goal**                              | Do not implement patrol, checkpoint, hidden-police, or mobile-camera reporting.                                                    |
| Fixed safety cameras                         | Competitors alert where lawful/data-supported.                        | **Partial / Next**                        | Calgary fixed-camera eligibility exists; move data and alert ownership fully native for suspended CarPlay reliability.             |
| Live traffic and traffic-aware ETA           | Core competitor advantage.                                            | **Data/licensing gated**                  | Requires licensed observations, directed-edge mapping, quality gates, privacy/cost review, and vehicle-use terms.                  |
| Fuel prices                                  | Google/Waze may show regional prices.                                 | **Data gated**                            | No reliable licensed Canadian feed; do not scrape or crowdsource without trust controls.                                           |
| Parking availability/entrances               | Competitors have selected-market data.                                | **Data gated**                            | Basic parking search exists; availability, entrances, and prices require sourced data.                                             |
| Share ETA / live trip                        | Competitors primarily start sharing on phone.                         | **Matched on phone / omitted on CarPlay** | Static system share only, no Contacts access or live tracking link. Keep CarPlay omitted unless Apple confirms a compliant flow.   |
| Planned drives / leave reminders             | Waze supports this mainly on phone.                                   | **Next**                                  | Local reminder and saved route recipe are feasible; predictive departure requires time-aware traffic data.                         |
| Offline maps and routing                     | Google supports downloaded areas; Waze expects connectivity.          | **Next / licensing gated**                | Start with a Calgary map-only pack and explicit routing/search-unavailable state; full offline routing is separate.                |
| Dashboard split view                         | Apple supports compatible third-party navigation apps.                | **Platform milestone**                    | Add a separately tested Dashboard scene after main-display release stabilization.                                                  |
| Instrument cluster / HUD                     | Waze supports selected vehicles; Google is undocumented.              | **Platform gated**                        | Publish structured maneuver/estimate metadata only where Apple/OEM support exists. No universal cluster-map claim.                 |
| Siri integration                             | Apple supports third-party navigation requests.                       | **Next**                                  | App Intent for bounded destination search and route preview, with explicit confirmation.                                           |
| Background, lock, reconnect                  | Required navigation behavior.                                         | **Matched; physical gate remains**        | Native location, transient recovery, phone companion, reconnect store. Repeat wired/wireless, lock, call, Siri, and radio tests.   |
| Arrival                                      | Both complete guidance at destination.                                | **Matched**                               | Sticky native arrival after accurate endpoint samples and explicit Done/End cleanup.                                               |
| Account/privacy posture                      | Competitors use accounts/history for many features.                   | **NavOSS differentiator**                 | Account-free, rounded search proximity, no server trip history, bounded local saved data, no Contacts access.                      |

## Required next milestones

1. Compile and physically validate this working tree in a new signed TestFlight build.
2. Implement reroute consent/route lock with deterministic route-change explanations.
3. Add Siri/App Intent destination search with explicit route-preview confirmation.
4. Move fixed-camera eligibility and alert ownership fully into native navigation.
5. Design Dashboard/cluster metadata as a separate Apple/OEM-gated milestone.
6. Evaluate offline map packaging and licensed traffic independently; neither may be advertised before validation.

## Release gates

- Never claim live traffic, traffic-aware ETA, lane guidance, public reports, or offline routing until
  the corresponding matrix row reaches **Matched** with measured evidence.
- CarPlay interactions must remain template-compliant and operable while parked or by a passenger.
- Every new data source needs provenance, freshness, fail-closed behavior, privacy review, and route
  quality gates before it can influence guidance.
- Real wired and wireless head-unit testing remains mandatory even when Apple CarPlay Simulator and
  deterministic renderer checks pass.

## Official references

- [Google Maps on CarPlay](https://support.google.com/maps/answer/9432062?hl=en)
- [Google Maps route options](https://support.google.com/maps/answer/144339?hl=en&co=GENIE.Platform%3DiOS)
- [Google Maps navigation](https://support.google.com/maps/answer/3273406?hl=en&co=GENIE.Platform%3DiOS)
- [Google Maps speedometer and speed limits](https://support.google.com/maps/answer/9356324?hl=en&co=GENIE.Platform%3DiOS)
- [Google Maps offline areas](https://support.google.com/maps/answer/6291838?hl=en&co=GENIE.Platform%3DiOS)
- [Waze on Apple CarPlay](https://support.google.com/waze/answer/9123774?hl=en)
- [Waze route preferences](https://support.google.com/waze/answer/6262566?hl=en)
- [Waze alternate routes](https://support.google.com/waze/answer/6262424?hl=en)
- [Waze add a stop](https://support.google.com/waze/answer/6262564?hl=en&co=GENIE.Platform%3DiOS)
- [Waze sound preferences](https://support.google.com/waze/answer/6273671?hl=en&co=GENIE.Platform%3DiOS)
- [Waze speedometer and speeding alerts](https://support.google.com/waze/answer/6386895?hl=en)
- [Apple: use other apps with CarPlay](https://support.apple.com/guide/iphone/use-other-apps-with-carplay-iph206c570e3/ios)
- [Apple: using the CarPlay Simulator](https://developer.apple.com/documentation/carplay/using-the-carplay-simulator)
