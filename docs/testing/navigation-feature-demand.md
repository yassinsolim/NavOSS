# Navigation feature demand synthesis

Research date: 2026-07-30

## Decision

NavOSS should not try to beat Google Maps, Apple Maps, or Waze by matching every feature. The best
near-term differentiation is to give drivers more control and more explanation without creating an
advertising profile or inventing road data.

The first product milestone should combine:

1. route lock and explicit reroute consent;
2. reusable local route recipes; and
3. plain-language route and route-change explanations.

These are recurring requests across multiple navigation communities, fit the existing NavOSS route
contract, require no new commercial data licence, and can be validated deterministically before
physical road testing.

## Method

This is a qualitative product-demand synthesis, not a statistically representative survey.

- Google-indexed public discussions were sampled from `r/GoogleMaps`, `r/applemaps`, `r/waze`, and
  directly relevant driving communities.
- Recurrence across independent threads and products mattered more than a single post's score.
- Google-indexed comment counts were used only as a rough engagement signal. Reddit blocked direct
  unauthenticated API enumeration, so exact vote totals were not used.
- Current official Google and Apple documentation was checked to avoid calling an existing feature
  universally missing.
- Each candidate was compared with the current NavOSS source, contracts, privacy posture, and data
  availability.

Basic offline maps are not in the top ten because Google and Apple already support them. Basic
multi-stop routing is also excluded because Apple supports up to 14 stops and NavOSS already supports
ordered intermediate stops. The unmet opportunity is saving, reusing, explaining, and optionally
optimizing those routes.

## Top ten opportunities

Scores are from 1 to 5. **Demand** reflects recurrence and discussion engagement. **Fit** measures
alignment with NavOSS's privacy-first product. **Readiness** measures how much trusted data and
infrastructure already exist.

| Rank | Opportunity                                     | Demand | Fit | Readiness | NavOSS status                                                                                | Decision          |
| ---: | ----------------------------------------------- | -----: | --: | --------: | -------------------------------------------------------------------------------------------- | ----------------- |
|    1 | Route lock and reroute consent                  |      5 |   5 |         4 | Every confirmed departure currently installs an automatic reroute                            | Build now         |
|    2 | Avoid or prefer exact roads and areas           |      5 |   5 |         3 | Only highway, toll, ferry, and unpaved preferences exist                                     | Prototype next    |
|    3 | Saved reusable route recipes                    |      5 |   5 |         5 | Ordered stops exist but disappear after the trip                                             | Build now         |
|    4 | Entrance-aware arrival and parking continuation |      4 |   5 |         2 | Arrival targets the selected place coordinate, often a centroid                              | Data milestone    |
|    5 | Along-route stop planning                       |      4 |   5 |         4 | Search is proximity-based, not route-corridor or detour-aware                                | Build next        |
|    6 | Explainable route choice and change history     |      4 |   5 |         4 | Alternatives show time, distance, and via roads but not why they differ                      | Build now         |
|    7 | Transparent correction workflow                 |      4 |   5 |         3 | Correction drafts remain private and have no submission status                               | Trust milestone   |
|    8 | Vehicle and road-condition profiles             |      3 |   4 |         2 | No height, width, weight, trailer, or winter-road profile exists                             | Research and gate |
|    9 | Private local trip journal with export          |      3 |   5 |         4 | NavOSS intentionally keeps no trip-history database                                          | Opt-in milestone  |
|   10 | Source-aware road context and calm controls     |      4 |   4 |         2 | Speed limits, cameras, audio, marker, and POI settings exist; lane/sign/signal data does not | Data milestone    |

## Product contracts

### 1. Route lock and reroute consent

Demand appears in a 160-plus-comment Google Maps discussion and recurring recent Apple Maps and Waze
threads. Users describe silent route changes as confusing and, in some cases, dangerous.

Implement three explicit modes:

- **Adaptive:** current automatic rerouting behavior.
- **Ask first:** calculate a replacement, show time/distance impact, and require confirmation before
  switching when the selected route is still reachable.
- **Keep selected route:** preserve the chosen route until the driver leaves it or requests another
  route; never silently switch merely to save time.

An actual off-route state still needs a safe recovery path. “Keep selected route” must not instruct a
driver to reverse illegally or continue onto a closed or inaccessible road.

### 2. Avoid or prefer exact roads and areas

Independent Google Maps, Apple Maps, and Waze discussions ask to avoid a specific street,
neighbourhood shortcut, city, narrow road, or poor road instead of disabling every highway or toll.

NavOSS should let a parked user select a rendered road segment or bounded area and store a local
preference with a visible reason and expiry. The API must use a structured Valhalla-supported
exclusion mechanism proven by provider tests; it must not approximate an avoided road through hidden
waypoints. Route preview must explain when an exclusion cannot be honoured.

### 3. Saved reusable route recipes

Waze multi-stop limitations generate repeated threads, including a 60-plus-comment discussion, and
users separately ask to save predefined multi-stop routes. Apple and Google provide basic multi-stop
routing, but reusable route intent remains inconsistent.

A NavOSS recipe should store only:

- a user-chosen name;
- ordered public destinations;
- route preferences and vehicle profile; and
- an optional preferred arrival entrance.

Do not persist stale route geometry. Recalculate against current road and closure data each time.
Stop-order optimization should be a separate explicit command because “shortest” may conflict with a
driver's required visit order.

### 4. Entrance-aware arrival and parking continuation

Apple Maps discussions repeatedly report navigation ending at a building centroid, rear service
road, or parking-lot boundary. This matches NavOSS's current use of one selected place coordinate.

The place model should support source-labelled arrival candidates such as public entrance, vehicle
entrance, driveway, parking entrance, and user-selected pin. Route preview should show the chosen
arrival side. Guidance should not announce arrival until the matched route reaches that access point.
Unknown entrance data must remain visibly unknown rather than inferred from a building centroid.

### 5. Along-route stop planning

Gas, rest-area, food, and drive-through searches recur in Waze discussions, including a
110-plus-comment feature thread. Users want options ahead on the route, not simply closest to their
current position.

NavOSS can compute this without live traffic:

- search within a forward route corridor;
- rank by added distance and free-flow detour time;
- show side of route and distance ahead;
- filter by known opening hours without assuming unknown means open; and
- support prompts such as gas within 100 km or a rest stop near two hours ahead.

### 6. Explainable route choice and change history

Users ask why the recommended route is slower, longer, or suddenly different. Google Maps users also
complain when alternate-route times disappear.

Every NavOSS route card should provide a deterministic explanation assembled from known data:

- time and distance difference from the selected alternative;
- major roads used;
- selected avoid/prefer rules;
- toll, ferry, unpaved, and known closure effects;
- traffic source and freshness when licensed traffic exists; and
- unknown factors that NavOSS cannot evaluate.

During guidance, keep a bounded in-memory change log such as “rerouted after confirmed departure” or
“driver accepted 3-minute faster route.” Do not claim causation from traffic when traffic is
unavailable.

### 7. Transparent correction workflow

Apple Maps and Waze discussions repeatedly describe reports taking weeks, being rejected without a
useful reason, or never appearing. NavOSS already has private correction drafts, which is a useful
starting point but not a submission system.

A reviewed service should add draft, submitted, needs-evidence, accepted, rejected, published, and
expired states. Every transition needs a timestamp and reason. Submissions should deduplicate against
official and OpenStreetMap changes, protect private addresses, and preserve a public-source audit
trail. No correction should silently rewrite production routing data.

### 8. Vehicle and road-condition profiles

Waze users ask for vehicle height and width, trailer-aware routes, bridge limits, and parkway
avoidance. Broader driving communities report consumer maps routing large vehicles onto narrow or
restricted roads.

Valhalla truck costing and OpenStreetMap restriction tags make a prototype possible, but this is a
safety-critical data feature. Do not ship a profile until Calgary/Alberta tests cover height, width,
weight, hazmat, trailer, seasonal restriction, narrow-road, and missing-tag failure cases. Profiles
must say when coverage is unknown and must never imply legal clearance.

### 9. Private local trip journal with export

Apple Maps users ask for Google-like Timeline behavior, while Waze users ask for route history and
GPX/KML export. Google provides Timeline, so the differentiator is not history itself; it is explicit
local ownership.

This feature must be off by default. The user should choose between destination-only history and
exact-route history, see the storage cost, export GPX/GeoJSON, delete individual trips, set automatic
expiry, and erase everything in one action. Exact traces must stay on device and use iOS data
protection. NavOSS must never upload or log them.

### 10. Source-aware road context and calm controls

Apple Maps and Waze users repeatedly request clearer lane guidance, traffic lights, stop signs,
speed limits, cameras, and control placement. Other users ask to remove or shortcut report controls,
showing that more information is not automatically better.

NavOSS should extend its existing settings with individually selectable, source-labelled layers:

- traffic signals and stop signs;
- school and playground zones;
- road surface and seasonal restrictions;
- lane and signpost guidance only when normalized provider data exists; and
- official cameras and current speed limits, which are already partially implemented.

Driving defaults should remain restrained. Unknown or stale context must disappear or show an
explicit uncertainty state instead of becoming a plausible-looking icon.

## Delivery sequence

### Milestone A: control and reuse

1. Route lock modes and reroute confirmation.
2. Local saved route recipes using the current ordered-stop editor.
3. Route comparison explanations and a transient route-change log.

This milestone has the highest demand-to-risk ratio and no new provider dependency.

### Milestone B: better trip planning

1. Forward-corridor along-route search and detour scoring.
2. Personal avoid/prefer road selections after a Valhalla exclusion proof.
3. User-selected arrival pins and stored per-place entrance preferences.

### Milestone C: trust and ownership

1. Moderated correction submission and status service.
2. Opt-in local trip journal with export, expiry, and complete deletion.

### Milestone D: safety-critical context

1. Vehicle profile data audit and isolated truck-costing prototype.
2. Official/OSM road-context normalization and confidence model.
3. Lane/sign/signal presentation only after route-linked physical validation.

## Explicit non-goals

- Do not add police, checkpoint, patrol-location, or enforcement-rotation tracking.
- Do not infer live traffic from speed limits, road class, anecdotal drives, or unconsented traces.
- Do not scrape competitor place, review, map, route, or traffic data.
- Do not make offline maps the headline differentiator; Google and Apple already provide them, though
  NavOSS still needs an offline architecture milestone for resilience.
- Do not add controls to CarPlay merely because competitors have them. Each control must earn one of
  Apple's limited template positions through a parked or driving task.

## Representative demand sources

### Route control

- [Google Maps automatic rerouting request](https://www.reddit.com/r/GoogleMaps/comments/161fw2d/google_maps_absolutely_needs_a_setting_to_turn/)
- [Apple Maps recent rerouting complaint](https://www.reddit.com/r/applemaps/comments/1oxpn80/how_do_i_stop_apple_maps_from_rerouting_while_im/)
- [Waze automatic route-change request](https://www.reddit.com/r/waze/comments/1o6h0nc/is_there_a_way_to_disable_the_automatic_route/)
- [Google Maps exact-road avoidance request](https://www.reddit.com/r/GoogleMaps/comments/m537pi/is_there_a_way_to_tell_google_maps_to_avoid_a/)
- [Apple Maps exact-road avoidance request](https://www.reddit.com/r/applemaps/comments/1udt2y3/how_to_tell_apple_maps_to_avoid_a_certain_road/)
- [Waze neighbourhood-road avoidance request](https://www.reddit.com/r/waze/comments/19atzrz/is_there_a_way_i_can_eliminate_certain_streets/)

### Stops and arrival

- [Waze multi-stop demand](https://www.reddit.com/r/waze/comments/1kw1ms4/can_anyone_tell_me_why_waze_still_doesnt_let_you/)
- [Waze gas-stop demand](https://www.reddit.com/r/waze/comments/1d4surf/gas_stops_along_route/)
- [Waze feature thread led by along-route search](https://www.reddit.com/r/waze/comments/1qjb79q/what_feature_would_you_like_to_see_on_waze/)
- [Apple Maps parking-lot navigation complaint](https://www.reddit.com/r/applemaps/comments/16yls2i/apple_map_doesnt_provide_directions_inside/)
- [Apple Maps destination-position complaint](https://www.reddit.com/r/applemaps/comments/116ahu8/location_of_destination_during_navigation_is_such/)

### Explanations, corrections, and ownership

- [Apple Maps slower-route question](https://www.reddit.com/r/applemaps/comments/1fnpxee/why_does_apple_maps_pick_the_slower_route_as/)
- [Apple Maps correction review delay](https://www.reddit.com/r/applemaps/comments/1m4t8sy/how_long_to_review_and_approve_updates/)
- [Apple Maps correction workflow request](https://www.reddit.com/r/applemaps/comments/ix2vnc/is_there_a_faster_way_to_voluntarily_edit_map/)
- [Waze address-update delay](https://www.reddit.com/r/waze/comments/1eyey05/how_long_do_address_updates_take/)
- [Apple Maps private-history demand](https://www.reddit.com/r/applemaps/comments/184io0q/does_apple_maps_have_something_similar_to_my/)
- [Waze trip-history export workaround](https://www.reddit.com/r/waze/comments/1eei50d/i_developed_a_tool_to_export_trip_history_as_gpx/)

### Vehicle and road context

- [Waze vehicle-dimension request](https://www.reddit.com/r/waze/comments/ozp81j/been_able_to_set_hight_and_width_restrictions_for/)
- [Apple Maps lane and road-context feature thread](https://www.reddit.com/r/applemaps/comments/168b1uz/what_is_one_future_you_would_add_or_fix_to_apple/)
- [Waze traffic-light demand](https://www.reddit.com/r/waze/comments/1e3ihjr/still_no_traffic_light_icons/)

## Official feature checks

- [Google offline maps](https://support.google.com/maps/answer/6291838?hl=en)
- [Google multi-stop routes](https://support.google.com/maps/answer/144339?hl=en)
- [Apple offline maps](https://support.apple.com/en-ca/105084)
- [Apple multi-stop routes](https://support.apple.com/en-ca/guide/iphone/iph837d13d03/ios)
