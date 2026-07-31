# Official Data Sources

## Calgary Place and Address Search

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
origins, selected results, routes, or user identities. Search results are ranked by exact text,
prefix and word-prefix matches, typo similarity, and then optional proximity.

Restaurants, Groceries, and Parks use a checked-in set of Nominatim special phrases that map the
visible category to explicit OpenStreetMap tags. The same strict mapping covers all 35 Explore
filters: every phone button has a shared contract category, every category has an exact server
allowlist, and every allowlist is checked against the repeatable Nominatim phrase source. This
prevents text collisions such as Bars matching barbershops or Car repair matching car washes.
Location-aware category searches query three concentric Calgary-bounded viewboxes, merge and
deduplicate the candidate pools, compute exact distances, and return the nearest valid OSM types
first. Empty upstream names fall back to the first display-label component, and empty optional OSM
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

OpenStreetMap does not provide a Google-style review corpus. NavOSS does not scrape reviews or add
Google values to its open-data result or shared contracts. An optional, key-gated Google Places UI
Kit component may receive a selected POI name and coordinate and render Google's photos, current
rating and rating count, review text, and required attribution in its own visually separated native
view. NavOSS checks the returned name and coordinate to prevent a mismatched place, but does not read
or persist the photo, rating, count, or review values. The separate **More reviews on Google Maps**
command is an explicit external search and opens only after the user chooses it. An enabled build
links GooglePlacesSwift 10.15.0; its underlying SDK privacy manifest declares location, Device ID,
Other Data, performance, product interaction, and search history collection for analytics and/or app
functionality, with no tracking. Builds without the Google key make no Google place-details request
and do not link that SDK.

## Live Traffic Routing

The North America coverage, infrastructure, and provider decision is recorded in
[`architecture/north-america.md`](architecture/north-america.md). It keeps Calgary as the only
current production claim while defining the staged Canada, United States, Mexico, and licensed
traffic gates.

NavOSS keeps live traffic disabled until a provider contract permits use in an
open-source MapLibre app with CarPlay. The provider review reached these
conclusions on July 23, 2026:

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

## Calgary Road Events

NavOSS combines two City of Calgary Open Data feeds for informational phone-map overlays:

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
them as UTC. Expired construction records and malformed rows are excluded rather than guessed.

The production API polls both feeds every five minutes even when no phone requests the endpoint and
deduplicates overlapping refreshes. It also caches a complete validated snapshot for five minutes.
If Calgary Open Data is temporarily unavailable, the API may return the last successful in-memory
snapshot for no more than 24 hours with both `stale` and `degraded` set to `true`. After that bound,
before any valid snapshot exists, or after an API restart during an upstream outage, the endpoint
fails closed. The phone refreshes every five minutes, keeps its last validated response through a
transient request failure, and visibly identifies a stale or delayed snapshot. Phones do not send
user location to Calgary Open Data.

Road-event markers are awareness information only. They do not change route selection, trigger
rerouting or speech, alter ETA, or represent road speeds or congestion. NavOSS still has no live
traffic or traffic-aware ETA. Construction uses an amber work-zone symbol, closures use a red
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

During active guidance, an alert is eligible only when the camera:

- is no more than 45 meters from the selected route geometry;
- is ahead of current native route progress and no more than 450 meters away;
- has an enforced direction within 60 degrees of route travel direction; and
- has not already been announced during the current trip.

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

## Ontario 511 Road Information

Ontario 511 publishes an official developer API under the
[Open Government Licence - Ontario](https://www.ontario.ca/page/open-government-licence-ontario).
The documented resources include traffic events, construction, road conditions, roadside cameras,
and alerts. The service is throttled to 10 calls per 60 seconds. NavOSS therefore polls the official
event endpoint server-side once every five minutes, deduplicates overlapping requests, and exposes
the normalized result at `GET /v2/events?region=ontario`. Phones never contact Ontario 511 directly
or send their coordinates to it.

The provider accepts only the documented `roadwork`, `closures`, and `accidentsAndIncidents`
taxonomy, maps those values to construction, closure, and incident markers, rejects malformed or
unknown source structures, removes expired records, and excludes points outside Ontario bounds. It
publishes source freshness, official confidence, API documentation, licence attribution, and stale
state. A last successful in-memory snapshot may be served for no more than 24 hours during an
upstream failure; after that bound or an API restart during an outage, the endpoint fails closed.

A direct production-equivalent probe on July 30, 2026 returned 623 source events and normalized 614
active in-province points: 602 construction events, 11 incidents, and one closure. It also returned
546 road-condition segments and 948 roadside cameras, which are not part of this first point-event
contract. These counts are observations, not fixed expectations.

Ontario 511 does not expose a general directed-edge current-speed feed through these documented
resources. The current phone overlay uses official construction, closure, and incident points only.
It does not alter route selection, trigger rerouting or speech, represent congestion speed, or
produce traffic-aware ETA. Ontario search and routing remain unavailable. Traffic-aware routing
remains gated on a licensed flow source integrated with Valhalla.
