# Official Data Sources

## Provincial Service-Area Boundaries

Routing/search coverage is Alberta and British Columbia in the v2 configuration. The single registry
is `packages/contracts/src/coverage-data.ts`; adding a Canadian province is a data change after its
routing/search imports and quality gates are ready. V1 configuration remains Calgary-shaped for
strict shipped clients. Calgary civic/camera data and Kelowna/DriveBC context are **local overlays**,
not province-wide datasets.

- Source: [Statistics Canada, 2021 Census province/territory digital boundaries](https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Digital_boundary_files/MapServer/0), PRUID `48` and `59`, published 2022-09-21.
- Licence declared by the service metadata: [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
- Retrieval: `outSR=4326`, `maxAllowableOffset=0.001`, `geometryPrecision=6`.
- Adaptation: normalize polygons to GeoJSON MultiPolygon and compute retrieval envelopes. No
  hand-drawn borders, province bounding-box eligibility, or omitted small-island filter is used.
- Digital boundaries include coastal waters and islands, unlike land-only cartographic rings.
  Simplification is approximately 0.001 degrees (up to about 110 m north/south), not a cadastral,
  border-control or survey-grade geofence.

Adapted from Statistics Canada, 2021 Census – Province and territory digital boundary files, 2021.
This does not constitute an endorsement by Statistics Canada of this product. Contains information
licensed under the Open Government Licence – Canada.

The API and pure phone modules share the same polygon predicate. Nominatim/Photon viewboxes are
retrieval envelopes only: results are polygon-filtered before limits are applied, and every route
origin, waypoint and destination must lie in a supported province.

## Calgary Place and Address Search

The result-quality behaviour below describes this implementation, not the shipped build. The
deployed service still uses the older Calgary/Kelowna image; province-wide retrieval and expanded
station/campus/variant deduplication are not live there until deployment. The new phone
presentation accepts the older response shape, but is not in TestFlight build 70.

NavOSS combines a local copy of two City of Calgary datasets with its self-hosted
OpenStreetMap/Nominatim index. The local copy is refreshed every 24 hours and swapped
atomically after a complete import, so user searches never query Calgary Open Data directly.
Before a swap, the indexer verifies filtered source counts, rejects implausible or greater-than-10%
drops, confirms source timestamps and counts did not change during pagination, and checks the
staging-table totals. The previous accepted index remains available for immediate rollback.

### Business licences

- Dataset: [Calgary Business Licenses](https://data.calgary.ca/d/vdjc-pybd)
- Socrata dataset ID: `vdjc-pybd`
- Supplier: The City of Calgary
- Imported records: licensed businesses with a public location and `HOMEOCCIND = N`
- Search fields: trade name, public business address, community, and licence types
- Terms: [Calgary Open Data Terms of Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)

Home-occupation records are deliberately excluded even when present in the public source.
The dataset does not cover every Calgary organization: some activities do not require a
municipal licence, names and locations can change between updates, and informal place names
may exist only in OpenStreetMap or neither source.

### Parcel addresses

- Dataset: [Parcel Address and lat/long](https://data.calgary.ca/d/s8b3-j88p)
- Socrata dataset ID: `s8b3-j88p`
- Supplier: The City of Calgary
- Search fields: house number and suffix, street name, street type, quadrant, and coordinates
- Terms: [Calgary Open Data Terms of Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)

Common long and abbreviated street forms are normalized consistently, such as `Trail`/`TR`
and `Southeast`/`SE`. Rows without a street identity or valid coordinates are excluded rather
than guessed. Parcel coordinates identify a civic parcel and are not guaranteed to represent
an entrance, driveway, unit, or ideal vehicle arrival point.

The production index stores public source records only. It does not store search text, search
origins, selected results, routes, or user identities. Text search uses query-specific name
relevance (exact fixture aliases, exact names, prefixes, then incidental matches), then proximity.
For a chain/brand with multiple same-name places, exact and prefix variants share a tier so nearby
branches and departments precede a same-name warehouse hundreds of kilometres away. A locality-
qualified query such as `Costco Kelowna` still prioritizes the explicitly named place. Explicit
distance sorting retains its meaning; category discovery always remains nearest-first.

With a supported origin, Nominatim starts a local text lookup (±0.35° latitude, ±0.5° longitude,
clipped to the provincial retrieval envelope) and a province-wide lookup concurrently. Both share
one four-second timeout budget. Pools are polygon-filtered, deduplicated and ranked before the
result limit is applied. An unavailable pool marks the surviving results degraded; complete
upstream failure retains the established fixture fallback. Calgary civic data and fixtures are
not added to Edmonton, Vancouver or other searches outside the Calgary overlay.

### Result identity and routing points

Same normalized names, or narrowly defined variants (legal suffixes, `Costco`/`Costco Wholesale`,
a tagged station's `LRT Station` suffix, or a curated fixture's city-qualified name), merge only
when close together. The standard radius is 150 m: the recorded University station components
span 101 m and duplicate Costco sources span 3–41 m. A matching complete civic number and street
allow 250 m for address-point/building-centroid offsets. Only a tagged university campus and its
same-name administrative boundary allow 1,000 m; the recorded Calgary campus node/way spread is
821 m. Conflicting house numbers, units or known business kinds veto merging. Distinct complete
same-provider node/way records are retained, even at one address, unless they are campus/station
components or an explicitly tagged main entrance. Every distinct entity must match every other
member: nearby records cannot form a chain that joins distant branches. Multiple snapshots of
the same ID contribute only the selected representative, not several old coordinate anchors.

Representative choice uses an explicitly tagged public main entrance (not private or explicitly
vehicle-prohibited), a factual place kind (the station rather than its platform/stop), civic
address quality, then coordinate representation. Existing curated fixture routing points are
retained when equally described; otherwise physical way/relation centroids precede an unqualified
node. Administrative boundaries never outrank a described campus. Public details are combined,
preferring a usable street address over a bare administrative breadcrumb. This is not a guarantee
of a verified driveway or vehicle entrance: Valhalla still snaps the selected point to its graph.
Saddletowne's fixture point now matches recorded OSM station node `6575529216`.

Phone and CarPlay rows show a compact street address (including a sourced unit) or neighbourhood
plus city, a factual short category when available, and straight-line distance when an origin is
known. Nominatim's legacy `class` and current `category`/`type` metadata are accepted; a light-rail
tag can say `LRT station`, `university` says `University`, and `wholesale` says `Warehouse store`.
Generic building/road/boundary tags are not place descriptions. Full original addresses remain in
optional place details; missing addresses/categories are never invented.

Development Photon results are merged with exact-alias fixtures too, so `University` retains
`University of Calgary` rather than losing it among station platforms. The phone promotes against
the complete overfetch pool before its eight-row cap, including when using an older API's scores.
CarPlay merges fresh remote metadata into matching local destinations; at most two matching Home,
Work or favourites stay visibly pinned as saved. Recents are ordinary ranked candidates, not
pinned chain branches. Query relevance is in-memory only and is not persisted with destinations.

Restaurants, Groceries, and Parks use a checked-in set of Nominatim special phrases that map the
visible category to explicit OpenStreetMap tags. The same strict mapping covers all 35 Explore
filters: every phone button has a shared contract category, every category has an exact server
allowlist, and every allowlist is checked against the repeatable Nominatim phrase source. This
prevents text collisions such as Bars matching barbershops or Car repair matching car washes.
Location-aware category searches query three concentric local viewboxes constrained to the
provincial retrieval envelope, polygon-filter candidates, merge/deduplicate the pools and compute
exact distances, returning the nearest valid OSM types first.
Empty upstream names fall back to the first display-label component, and empty optional OSM
details are omitted so unnamed parks and parking features remain contract-valid. The phrase import
is additive and is reapplied after any replacement of the persistent Nominatim database.

Brunch and Delivery are not exposed as Explore filters because current open data does not identify
those attributes consistently enough to support accurate results. Users may still type those words
as ordinary searches, but NavOSS does not label the results as a verified category.

Named places rendered in the map's OpenMapTiles layers are tappable. NavOSS uses the visible name
and map coordinate to find the nearest same-name result through the self-hosted search service.
Nominatim `extratags` may provide a public address, place category, opening hours, business phone,
official website, and wheelchair-access tag. These community-maintained fields may be absent,
outdated, or expressed in raw OpenStreetMap syntax. NavOSS does not infer missing values.

For Alberta places and the known Kelowna local overlay, the phone can derive Open, Closing soon
(within one hour), or Closed from unambiguous weekly opening-hour rules using a known local time zone.
Holiday, seasonal, commented, and otherwise unsupported schedules retain their source text without a
guessed status. Missing hours remain missing, and community-maintained hours are not a guarantee
that a business is currently operating.
Other BC locations retain their raw hours: BC has multiple time zones and this code does not infer
one from the province name.

The place sheet's Parking action searches around the selected place, not the device's position.
It requires supported search coverage and does not start or replace a route. Text searches can
highlight up to three matching recent destinations from the current results; the remaining list
preserves relevance for unique names and nearest-first order for chains. This history remains on
the device. Submitting a search exposes map markers through a compact results strip, with Show
list available to return to the full list.

OpenStreetMap does not provide a Google-style review corpus. NavOSS does not scrape reviews, call
Google Maps Platform web services or other Core Services such as Places API text search (Google's
terms do not allow their content with a non-Google map), or add Google values to its open-data
result, shared contracts or server. Builds made with the `production-carplay-google` profile embed
only Google's Places UI Kit components (Essentials tier, GooglePlacesSwift 10.15.0), which Google
allows next to a non-Google map. On the phone place sheet for named places, businesses and landmarks
(not street addresses, streets, neighbourhoods or dropped pins), Place Details is queried by the
selected coordinate and shows Google's listing nearest that spot, with Google's own name for it and
every element that tier offers: photos, address, rating and rating count, type, price level,
accessible entrance, open-now status, opening hours, summary, website, phone number, type-specific
highlights, reviews, plus code and feature list. Google's callback carries no name, so the only
check NavOSS can make is distance: the panel is shown only when Google's listing is within 30 m of
the selection, and it is labelled as Google's nearest listing rather than the same business. **Find
this place on Google** shows Google's Place Search component for the place's name near the
coordinate; the listing the driver picks then loads in Place Details. Each component load (automatic
panel, search list, picked listing) takes an anonymous grant from the NavOSS server's
8,000-per-month counter and is billed by Google per load. Nothing from Google is kept. CarPlay shows
no Google content. The separate **More reviews on Google Maps** command is an explicit external
search and opens only after the user chooses it. The SDK's privacy manifest declares location,
Device ID, Other Data, performance, product interaction, and search history collection for analytics
and/or app functionality, with no tracking. Builds without the restricted Google key make no Google
place-details request and do not link that SDK.

## Live Traffic Routing

The North America coverage, infrastructure, and provider decision is recorded in
[`architecture/north-america.md`](architecture/north-america.md). V2 selects Alberta and British
Columbia while retaining Calgary-shaped v1 compatibility and staged Canada/US/Mexico quality gates.

NavOSS's own live traffic is built from opted-in driver speeds and is described under
[Community Traffic](#community-traffic). Commercial live traffic stays disabled until a provider
contract permits use in an open-source MapLibre app with CarPlay. The provider review reached
these conclusions on July 23, 2026:

- [Google Routes API terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
  prohibit Routes content in conjunction with a non-Google map, so Google traffic
  cannot be layered onto NavOSS's MapLibre map.
- Apple's `MKDirections` exposes an expected travel time, but not a comparable
  free-flow/typical duration or delay for the selected NavOSS route. Mixing an
  Apple ETA with different Valhalla geometry would misstate route-specific delay.
- TomTom's portal terms exclude navigation functionality and CarPlay/automotive
  usage without a separate written agreement. HERE's Base Plan excludes locating
  or routing a person/vehicle as an asset-management use case.
- [Mapbox Directions](https://docs.mapbox.com/api/navigation/directions/) with
  `mapbox/driving-traffic` returns route geometry, current traffic-aware duration,
  typical duration, instructions, and Canadian traffic coverage. Its
  [pricing terms](https://www.mapbox.com/pricing/) require a commercial
  application license for vehicle or in-vehicle use.

The API includes a disabled-by-default Mapbox adapter. It activates only when a
server-side access token and explicit vehicle-license confirmation are both
present. When active, the route's `durationSeconds` is the live total ETA and
`traffic.delaySeconds` is the nonnegative difference from typical conditions.
NavOSS displays that as, for example, `30 min` and `+5 min traffic`. It does not
send the provider token to the app or cache route responses. Production must not
enable this adapter until the license, privacy disclosure, attribution, cost
controls, same-time route-quality gate, and physical phone/CarPlay validation are
complete.

## Community Traffic

- Source id: `navoss-community`
- Supplier: NavOSS drivers who switched traffic sharing on
- Attribution shown with the layer: "Traffic from opted-in NavOSS drivers"
- Licence: NavOSS's own aggregate. Road geometry and segment identifiers come from OpenStreetMap
  ([ODbL](https://www.openstreetmap.org/copyright)) through the self-hosted Valhalla graph.
- Endpoints: `POST /v2/traffic/credentials`, `POST /v2/traffic/probes`, `GET /v2/traffic/flow`,
  `GET /v2/traffic/status`
- Design, parameters and threat model: [`architecture/community-traffic.md`](architecture/community-traffic.md)

The server is implemented and disabled by default (`COMMUNITY_TRAFFIC_MODE=off`); production has
not enabled it and no released app uploads driving observations. When enabled, a road edge on a
motorway, trunk, primary or secondary road is published only at a five-minute boundary, after at
least three App Attest installations drove it in the preceding 15 to 20 minutes, and stays up for
15 minutes. With few users little or nothing is shown, and the service publishes no count of how
much data it holds. NavOSS does not interpolate, predict, or fill gaps:
a road without enough recent contributors has no traffic colour, and a route without enough
observed length has no traffic-adjusted ETA.

### Official feeds reviewed for Alberta and British Columbia

Reviewed on November 12, 2026 for a free, redistributable, real-time speed or flow feed that an
open-source navigation app with CarPlay may use. None was added.

| Source                                                                                                                                           | What it offers                                                                                                                                                                                  | Terms read                                                                                                                                                                                                                                                                                                                    | Decision                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [511 Alberta API](https://511.alberta.ca/developers/doc)                                                                                         | Events, road conditions, cameras, alerts, ferries, rest areas. No road-speed or flow resource. Needs a registered account and developer key; 10 calls per 60 seconds.                           | [About 511 Alberta](https://511.alberta.ca/about/about), "Terms of Use": reproduction is allowed for personal and public non-commercial (educational) use; reproduction for commercial distribution needs written permission from the Government of Alberta. It is not published under the Open Government Licence – Alberta. | Not used. It has no flow data, and its terms do not clearly permit redistribution through an app whose AGPL licence lets anyone reuse it commercially. Alberta events would need written permission first. |
| [City of Calgary Travel Times](https://data.calgary.ca/Transportation-Transit/Travel-Times/aeb8-fh2w) (`aeb8-fh2w`)                              | Current car travel time in minutes for 68 named corridors, 20-minute resolution. No geometry, no segment references, no free-flow baseline. Metadata says it is collected with INRIX Analytics. | [Open Government Licence – City of Calgary](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa): copy, adapt and distribute for any lawful purpose with attribution; clause 6(c) excludes third-party rights the City is not authorised to license.                                                                          | Not used. Drawing it would mean inventing corridor geometry from text labels, and it cannot give per-segment congestion. Whether the INRIX-derived values fall under clause 6(c) is not stated.            |
| [City of Calgary Current Traffic Incidents](https://data.calgary.ca/d/4jah-h97u) and [Construction Detours](https://data.calgary.ca/d/w8zq-79bq) | Incident and construction points. No speeds.                                                                                                                                                    | Open Government Licence – City of Calgary (as above).                                                                                                                                                                                                                                                                         | Already used as event overlays ([Calgary Road Events](#calgary-road-events)); not a flow source.                                                                                                           |
| [DriveBC Open511 API](https://api.open511.gov.bc.ca/help)                                                                                        | Road events for provincial highways. No speed or flow resource.                                                                                                                                 | The API guidelines state use is governed by the [Open Government Licence – British Columbia](https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc).                                                                                                                                                   | Already used for Kelowna-area events; not a flow source.                                                                                                                                                   |

British Columbia's [Traffic Data Program](https://twm.th.gov.bc.ca/?c=tdp) publishes historical
counts, not live speeds. No other official live speed feed for either province was found. If one
appears, it must be added here with its licence before any code uses it, be labelled as its own
source in responses, and never be blended into `navoss-community` values.

## Calgary Road Events

NavOSS combines two City of Calgary Open Data feeds for informational phone-map overlays, at
`GET /v1/events` and in the Alberta response of
[Official Road Events by Province](#official-road-events-by-province):

- [Calgary Construction Detours](https://data.calgary.ca/d/w8zq-79bq), dataset ID
  `w8zq-79bq`, is official City construction information updated twice daily.
- [Current Traffic Incidents](https://data.calgary.ca/d/4jah-h97u), dataset ID
  `4jah-h97u`, is refreshed on a 10-minute cadence, but the City describes the information as
  unofficial and unverified. NavOSS preserves that posture in the API and labels incident markers
  as unverified.

Both sources use the [Calgary Open Data Terms of
Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa). Source timestamps, confidence, update
frequency, dataset links, and attribution are returned with every API response. Construction start
and end values are source-local civil times tagged as `America/Edmonton`; NavOSS does not reinterpret
them as UTC. The current incident feed uses UTC text timestamps and WKT points (or separate coordinate
columns); its UTC times are converted to Edmonton wall time, including daylight saving transitions.
Legacy local timestamps and GeoJSON points remain supported. Expired construction records and
malformed rows are excluded rather than guessed. An isolated malformed row or up to 10% of a feed is
dropped and counted; exceeding that threshold fails that dataset.

The API polls both feeds every five minutes even when no phone requests the endpoint and
deduplicates overlapping refreshes. It caches a validated snapshot for five minutes and individual
datasets for at most 24 hours. If one feed fails, it serves the other with the last valid data for
the failed feed within that bound, or without that feed if no valid data exists. Both `stale` and
`degraded` are true for an incomplete or partially invalid snapshot. The v1 contract still requires
both real source descriptors: if a descriptor cannot be fetched and no bounded cached descriptor
exists, or no feed is available, the endpoint fails closed. The phone refreshes every five minutes,
keeps its last validated response through a transient request failure, and visibly identifies a stale
or delayed snapshot. Phones do not send user location to Calgary Open Data.

Road-event markers are awareness information only. They do not change route selection, trigger
rerouting or speech, alter ETA, or represent road speeds or congestion. They are not an input to
[Community Traffic](#community-traffic). Construction uses an amber work-zone symbol, closures use a red
no-entry symbol, and incidents use a coral warning symbol. NavOSS does not ingest or display police
patrol, checkpoint, or speed-trap locations; there is therefore no police-location marker.

## Calgary Intersection Safety Cameras

NavOSS uses The City of Calgary's official **Intersection Safety Cameras** dataset for fixed enforcement-camera markers and alerts.

- Dataset: [Intersection Safety Cameras](https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx)
- Socrata dataset ID: `dv2f-necx`
- Supplier: Calgary Police Department through Calgary Open Data
- Update frequency: monthly
- Geometry: WGS84 points
- Terms: [Calgary Open Data Terms of Use](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)

The official description states that each Intersection Safety Camera detects vehicle speed and can detect failure to stop for a red light. NavOSS therefore labels every record as a combined `red-light` and `speed-on-green` camera. It does not infer separate enforcement types.

As of July 1, 2026, the source contains 57 camera records. Five records omit ward metadata; NavOSS retains those cameras without fabricating a ward. A record must still have valid coordinates, community, quadrant, and a recognizable enforced direction. Unknown direction data fails closed and the API returns a temporary-unavailable response rather than issuing potentially incorrect alerts.

The NavOSS API fetches and validates the dataset server-side and caches successful responses for six hours. The mobile client does not send user location to Calgary Open Data. The app displays all validated official locations on the map and includes visible City of Calgary attribution.

Tapping an enforcement-camera marker shows its published enforcement type and monitored traffic
direction. This direction is not the camera's optical facing, which the source does not publish.
Where a source does not provide a direction, the detail view says so rather than inferring it
from the road name or icon orientation.

During active guidance, an alert is eligible only when the camera:

- projects onto an upcoming segment of the selected route within 45 meters laterally, without
  extending the segment before its start or beyond its end;
- is ahead of current native route progress and no more than 450 meters away;
- has an enforced direction within 60 degrees of its closest upcoming route approach; and
- has not already been announced during the current trip.

At a shared turn vertex, the incoming segment determines the approach direction, not the outgoing
road. Camera-to-route association happens before direction filtering: a farther, direction-aligned
segment cannot override a nearer cross-street approach. Cameras genuinely farther along a road
reached after a turn can still warn; the current device compass does not override the planned
approach at the camera. These checks use published monitored traffic direction, not optical facing.

Eligible cameras produce a visible alert and the native iOS phrase, “Red light and speed camera ahead.” These alerts are informational. Drivers remain responsible for obeying posted signs, signals, and speed limits, and the official dataset may change between monthly updates.

## Toronto Red Light Cameras

NavOSS's first Ontario data integration uses the City of Toronto's official active **Red Light
Cameras** dataset.

- Dataset: [Red Light Cameras](https://open.toronto.ca/dataset/red-light-cameras/)
- Dataset ID: `9fcff3e1-3737-43cf-b410-05acd615e27b`
- Supplier: City of Toronto Transportation Services
- Update frequency: daily
- Geometry: WGS84 multipoints
- Terms: [Open Government Licence - Toronto](https://open.toronto.ca/open-data-licence/)

The API validates and caches the source for six hours and exposes it only through the additive
regional camera contract. The source identifies camera intersections but does not identify the
enforced approach direction, so Toronto records are red-light-only map markers and do not receive
direction-aware spoken warnings.

Toronto's Automated Speed Enforcement dataset is excluded from active NavOSS camera responses. The
City marks it as no longer updated because Ontario banned municipal speed cameras in November 2025;
raw historical rows that still say `Active` are not evidence of current enforcement.

As of July 30, 2026, the production endpoint returns 301 Toronto red-light cameras with a source
refresh timestamp from the same day. These are currently phone map markers only. Ontario routing,
search, spoken camera alerts, CarPlay camera overlays, and traffic-aware ETA are not enabled.

## Official Road Events by Province

Researched on 2026-11-15 from each publisher's own documentation. Crash and incident reports come
only from official traveller-information feeds and open-data portals; news sites and web pages are
never scraped. `GET /v2/events?region=alberta|british-columbia|ontario` returns every configured
source of that province, each loaded independently, with its own state: `current`, `stale` (the
latest refresh failed and the last valid copy, still inside the source's maximum age, is served),
`unavailable`, or `not-configured` (the source needs a key the server does not have). The endpoint
answers 503 only when no source of the province has data. `kelowna-bc` keeps its original
single-source DriveBC shape for shipped builds.

| Source                                                                                                                                                                                                        | Data used                                                                                                                                                                                                         | Endpoint                                                                                              | Access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Update interval                              | Licence / terms                                                                                                                                                                                                                                                              | Required attribution                                                                                                                                                                                          | Rate limit                                                                                                         | NavOSS                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [511 Alberta events](https://511.alberta.ca/help/endpoint/event)                                                                                                                                              | Province-wide collisions, closures, construction, special events, general information (`EventType`, `EventSubType`, `Severity`, `IsFullClosure`, Unix-time `Reported`/`LastUpdated`/`StartDate`/`PlannedEndDate`) | `https://511.alberta.ca/api/v2/get/event?format=json&lang=en&key=…`                                   | **Developer key required.** Without one the API answers HTTP 400 `<Error><Message>Invalid Key</Message></Error>` (observed 2026-11-15). To get one: create an account on 511.alberta.ca (or sign in with an Alberta.ca Account), then request a key on the [developer page](https://511.alberta.ca/developers/doc).                                                                                                                                                                                                                                                            | Not documented; NavOSS polls every 5 minutes | [About 511 Alberta, Terms of Use](https://511.alberta.ca/about/about): reproduction for personal and public non-commercial use is allowed; commercial distribution needs written permission from the Government of Alberta. Not under the Open Government Licence – Alberta. | None prescribed; NavOSS names "511 Alberta"                                                                                                                                                                   | 10 calls per 60 seconds                                                                                            | Implemented, **inert without `ALBERTA_511_API_KEY`**. The owner must also decide whether NavOSS's AGPL redistribution needs Alberta's written permission (see [Official feeds reviewed](#official-feeds-reviewed-for-alberta-and-british-columbia)). |
| 511 Alberta [road conditions](https://511.alberta.ca/help/endpoint/winterroads) and [cameras](https://511.alberta.ca/help/endpoint/cameras)                                                                   | Winter road-condition polylines; camera locations with image links                                                                                                                                                | `/api/v3/get/winterroads`, `/api/v2/get/cameras`                                                      | Same key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not documented                               | Same terms                                                                                                                                                                                                                                                                   | Same                                                                                                                                                                                                          | Same                                                                                                               | Not implemented.                                                                                                                                                                                                                                     |
| [Ontario 511 events](https://511on.ca/help/endpoint/event)                                                                                                                                                    | Province-wide `roadwork`, `closures`, `accidentsAndIncidents` with the same fields as 511 Alberta                                                                                                                 | `https://511on.ca/api/v2/get/event?format=json&lang=en&key=…`                                         | **Developer key required.** The "Invalid Key" answer is the key requirement, not a moved endpoint or a renamed parameter: the documented URI is unchanged and lists `key` as required. To get one: register an account on 511on.ca, then request a key on the [developer page](https://511on.ca/developers/doc). The request must give an organisation name and contact, a description of the service, and any third parties that will receive or display the data; the Ministry reviews requests case by case ([Developer Resources](https://511on.ca/developers/resources)). | Not documented; NavOSS polls every 5 minutes | Ontario 511 Developer's Access Agreement and the [Open Government Licence – Ontario](https://www.ontario.ca/page/open-government-licence-ontario); the agreement asks redistributors to pass on its accuracy disclaimer.                                                     | "Contains information licensed under the Open Government Licence – Ontario."; the agreement encourages a link to 511on.ca and restricts use of the 511 logo                                                   | 10 calls per 60 seconds                                                                                            | Implemented, **inert without `ONTARIO_511_API_KEY`**.                                                                                                                                                                                                |
| Ontario 511 [construction projects](https://511on.ca/help/endpoint/constructionprojects), [cameras](https://511on.ca/help/endpoint/cameras), [road conditions](https://511on.ca/help/endpoint/roadconditions) | Longer-term projects, camera views, condition segments                                                                                                                                                            | `/api/v2/get/…`                                                                                       | Same key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not documented                               | Same                                                                                                                                                                                                                                                                         | Same                                                                                                                                                                                                          | Same                                                                                                               | Not implemented.                                                                                                                                                                                                                                     |
| [DriveBC Open511 events](https://api.open511.gov.bc.ca/help)                                                                                                                                                  | Province-wide `CONSTRUCTION`, `INCIDENT`, `ROAD_CONDITION`, `WEATHER_CONDITION`, `SPECIAL_EVENT` with subtypes, `severity`, road `state` (`CLOSED`), `created`/`updated`, schedule intervals                      | `https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=500&offset=…`                   | Open, no key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Live; NavOSS polls every 5 minutes           | [Open Government Licence – British Columbia](https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc) and the [API Terms of Use](https://www2.gov.bc.ca/gov/content?id=D1EE0A405E584363B205CD4353E02C88)                                                | "Contains information licensed under the Open Government Licence – British Columbia."                                                                                                                         | At most 500 events per request; `limit`/`offset` pagination (NavOSS reads up to 8 pages). No call rate documented. | Implemented.                                                                                                                                                                                                                                         |
| [DriveBC HighwayCams catalogue](https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c)                                                                                                | Webcam locations and image links                                                                                                                                                                                  | `…/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv`                                | Open, no key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Monthly; NavOSS refreshes every 6 hours      | OGL-BC                                                                                                                                                                                                                                                                       | Same as above                                                                                                                                                                                                 | None documented                                                                                                    | Repaired (see [DriveBC Kelowna Traffic Webcams](#drivebc-kelowna-traffic-webcams)).                                                                                                                                                                  |
| [City of Calgary Current Traffic Incidents](https://data.calgary.ca/d/4jah-h97u)                                                                                                                              | Current incidents, **described by the City as unofficial and unverified**                                                                                                                                         | `https://data.calgary.ca/resource/4jah-h97u.json`                                                     | Open, no key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 10-minute resolution, continuous             | [Open Government Licence – City of Calgary](https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa)                                                                                                                                                                             | "Contains information licensed under the Open Government Licence – City of Calgary."                                                                                                                          | Socrata: anonymous requests are throttled by IP; an app token raises the limit                                     | Implemented (also `/v1/events`). Always labelled unverified.                                                                                                                                                                                         |
| [City of Calgary Construction Detours](https://data.calgary.ca/d/w8zq-79bq)                                                                                                                                   | Construction with floating Calgary wall times                                                                                                                                                                     | `https://data.calgary.ca/resource/w8zq-79bq.json`                                                     | Open, no key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Twice daily                                  | Same                                                                                                                                                                                                                                                                         | Same                                                                                                                                                                                                          | Same                                                                                                               | Implemented (also `/v1/events`).                                                                                                                                                                                                                     |
| [City of Edmonton Traffic Disruptions](https://data.edmonton.ca/d/k4tx-5k8p)                                                                                                                                  | Closures, construction, special events and traffic-incident disruptions with `impact`, street extent and **calendar dates only**                                                                                  | `https://data.edmonton.ca/resource/k4tx-5k8p.json?$where=status in ('Current','Revised','Emergency')` | Open, no key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | "X times per day", automated                 | [Open Government Licence – Edmonton](https://data.edmonton.ca/stories/s/Open-Government-Licence-Edmonton/msh8-if28) (version 1.0, July 2022)                                                                                                                                 | "Contains information licensed under the Open Government Licence – City of Edmonton." (the licence page is script-rendered; the statement follows the licence's template and should be confirmed by a person) | Socrata, as above                                                                                                  | Implemented.                                                                                                                                                                                                                                         |
| [City of Toronto Road Restrictions](https://open.toronto.ca/dataset/road-restrictions/)                                                                                                                       | Permitted closures, construction and hazards with current and maximum impact, Unix-millisecond times                                                                                                              | `https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json`                            | Open, no key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Real-time (catalogue)                        | [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/)                                                                                                                                                                                              | "Contains information licensed under the Open Government Licence – Toronto."                                                                                                                                  | None documented                                                                                                    | Implemented.                                                                                                                                                                                                                                         |
| City of Edmonton and City of Toronto live collision feeds                                                                                                                                                     | —                                                                                                                                                                                                                 | —                                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                            | —                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                             | —                                                                                                                  | Neither city publishes live collision or incident points as open data; Edmonton's "Traffic Incident" disruptions above are planned-impact records.                                                                                                   |
| News websites                                                                                                                                                                                                 | —                                                                                                                                                                                                                 | —                                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                            | —                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                             | —                                                                                                                  | Not used: no licence permits it and NavOSS does not scrape pages.                                                                                                                                                                                    |

### What each event keeps

Every event keeps the source's own description (markup and whitespace normalised), its type
(`collision`, `closure`, `construction`, `hazard`, `stalled-vehicle`, `road-condition`,
`special-event`, or `incident` when the source does not say which kind), severity only where the
source publishes one (511 `Severity`, DriveBC `severity`, Toronto `currImpact`, Edmonton's
`impact` level), start and planned end, the source's last-update time, location, affected road and
direction, and the source id and name for attribution. Types come from the source's own fields: the
511 `EventType`/`EventSubType`, DriveBC event type, subtypes and road `state`, Toronto `type`,
Edmonton `activity_type` and `impact`, and the leading phrase of a Calgary incident description
("Stalled vehicle. …"). Official sources are labelled official; Calgary current incidents stay
unverified. Official events and community reports are never merged.

### Time

- Unix times (511, Toronto) and offset timestamps (DriveBC `created`/`updated`, Calgary
  `*_dt_utc`) are instants.
- DriveBC schedule intervals carry no offset. On 2026-11-15 the interval start of 121 of 298 live
  events equalled the event's `created` time **in UTC**, and none equalled it as Pacific wall
  time, so offsetless interval times are read as UTC (this also corrects the Kelowna provider,
  which had read them as Pacific time).
- Calgary construction times are floating Calgary wall time and are converted with
  `America/Edmonton` daylight-saving rules; a repeated fall-back time resolves to its first
  occurrence.
- Edmonton publishes dates only (every value is local midnight). Those events carry `startsOn` and
  `endsOn` dates instead of invented clock times, and stay in effect through their last local day.

Events whose start is still ahead or whose planned end has passed are dropped, on the server and
again on the phone. Each source has a maximum age (one hour for 511, DriveBC, Toronto and Calgary
incidents; 24 hours for Calgary construction and Edmonton): past it the server stops serving that
source's last copy and the phone drops any copy it still holds. A source with more than 10%
malformed rows fails that refresh; fewer are dropped, counted and reported as incomplete.

### On the phone

The road-events line on the map opens a list of the province's events in effect, newest first by
the source's own update time (or report time, or start). Each row says how long ago its source last
changed it ("Updated 12 min ago"), never when NavOSS fetched it, with the source name and whether it
is official or unverified. A sources section names every source's state: not connected on this
server, unavailable, or not refreshing (showing the last copy). Map symbols keep the newest event on
top where they collide. Road events are awareness only: they do not change routes, ETA, rerouting or
speech, and CarPlay shows no official events.

### Deployment

No data build is needed. The server polls the feeds itself. Optional environment variables:

- `ALBERTA_511_API_KEY`: 511 Alberta developer key.
- `ONTARIO_511_API_KEY`: Ontario 511 developer key.

Without them those two sources report `not-configured` and the province is served from its open
sources. Keys travel only in the server's request URL and are never logged.

## Kelowna RCMP Public Facilities

The official [Kelowna RCMP contact page](https://rcmp.ca/en/bc/kelowna/contact) publishes fixed
public addresses and coordinates. NavOSS includes the Kelowna Main Detachment and Rutland Community
Police Office at `GET /v2/safety-facilities?region=kelowna-bc`. These markers identify public
service facilities only. NavOSS does not collect or display patrol, officer, checkpoint, dispatch,
or live police locations.

## Self-built regional offline data

The build pipeline in [`infra/offline`](../infra/offline/README.md) produces downloadable artifacts,
not an already-enabled phone/CarPlay offline feature. It uses public, dated Geofabrik Alberta and
British Columbia PBFs with matching OSM timestamps, provider MD5 verification and recorded SHA-256.
No tiles are bulk-scraped from OpenFreeMap's public endpoint.

| Component                                        | Source and licence                                                                                                                                                       | Required notices / limitations                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roads, places, POIs, addresses and routing graph | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), distributed by [Geofabrik](https://download.geofabrik.de/north-america/canada.html), **ODbL 1.0** | Visible OSM attribution; distribute derived search/routing databases under ODbL and retain the source/alteration information needed by that licence. OSM coverage is incomplete and not a live closure/traffic feed. |
| Download footprint boundaries                    | [Geofabrik clipping polygons](https://github.com/geofabrik/polygons_download.geofabrik.de), an **OSM produced work under ODbL 1.0**                                      | Attribute OpenStreetMap. These are buffered extract extents, **not official province boundaries**; NavOSS clips its download selections to them and adds a 20 km overlap.                                            |
| Vector tile schema                               | [OpenMapTiles](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md), **CC BY 4.0** design, **BSD-3-Clause** code                                         | Visible **OpenMapTiles** attribution with its link. The currently built schema is 3.16.0.                                                                                                                            |
| Low-zoom vector background                       | [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/), **public domain**                                                                                 | Source acknowledged in the bundle. Offline styles omit the optional online shaded-raster texture; no raster endpoint is needed.                                                                                      |
| Water/coastline polygons                         | [OSM Data](https://osmdata.openstreetmap.de/data/water-polygons.html), **OSM-derived ODbL 1.0**                                                                          | OSM attribution; retain the locked source snapshot.                                                                                                                                                                  |
| Lake centreline geometry                         | [OSM Lakelines](https://github.com/acalcutt/osm-lakelines), **ODbL 1.0** data / **MIT** processing                                                                       | OSM attribution; source v12 is checksum-pinned.                                                                                                                                                                      |
| Time-zone boundaries                             | [Timezone Boundary Builder](https://github.com/evansiroky/timezone-boundary-builder), **ODbL 1.0** OSM-derived data / **MIT** processing                                 | The locked 2026b snapshot is used for graph construction.                                                                                                                                                            |
| Liberty / Bright offline styles                  | [OpenFreeMap styles](https://github.com/hyperknot/openfreemap-styles), forks of OSM Liberty / OSM Bright                                                                 | **BSD-3-Clause** code, **CC BY 4.0** design; OpenFreeMap integration **MIT**. Original notices are included.                                                                                                         |
| Positron / Dark offline styles                   | [OpenFreeMap styles](https://github.com/hyperknot/openfreemap-styles), derived from Carto basemaps                                                                       | Carry **BSD-3-Clause / CC BY 4.0** notices and the underlying **CC BY 3.0** credit to Carto, Stamen and Paul Norman. Original style notices are included.                                                            |
| Noto Sans Regular, Bold and Italic glyphs        | [MapLibre demo glyphs](https://github.com/maplibre/demotiles/tree/gh-pages/font), **SIL Open Font License 1.1**                                                          | The original font licences remain inside the glyph directories. All 256 BMP ranges for each stack are packaged; these are the fonts used by the pinned OpenFreeMap styles.                                           |
| Sprites                                          | OpenFreeMap's bundled [Maki icons](https://github.com/mapbox/maki), **CC0 1.0**; right arrow **public domain**                                                           | Both 1× and 2× PNG/JSON sprite atlases are packaged with the original integration/style notices.                                                                                                                     |

`sources.lock.json` records the exact source URLs and hashes. `resources.tar.gz` includes the original
style/font licence texts, `ATTRIBUTION.txt`, and the source inventory. The manifest carries attribution
records; both phone and CarPlay must keep OSM and OpenMapTiles credits visible when displaying maps.

The builder uses [Planetiler](https://github.com/onthegomap/planetiler) (Apache-2.0) and
[Valhalla](https://github.com/valhalla/valhalla) (MIT). The pinned mobile wrapper,
[Rallista valhalla-mobile 0.6.4](https://github.com/Rallista/valhalla-mobile/tree/0.6.4) (MIT), embeds
Valhalla 3.9.1; offline graphs use that engine while the online Compose service remains on 3.8.2.
The numerical route comparison and compatibility results are documented in
[`architecture/offline.md`](architecture/offline.md), without claiming identical online/offline ETAs.

Offline resources are generated locally or obtained from licensed source archives, not under
OpenFreeMap's public-endpoint bulk-download allowance. Its
[terms](https://openfreemap.org/tos/) cap user offline downloads at 3,000 tiles or 50 MB and restrict
automated collection; these self-built province/region bundles do not rely on that allowance.

No user search text, device location, trip history or community speed samples are inputs to the
offline builder. Search coverage reflects OSM records only: no inferred missing address numbers,
private feedback, Google reviews, or proprietary traffic geometry are incorporated.
