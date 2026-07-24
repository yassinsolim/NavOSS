# North America coverage and traffic decision

Decision date: 2026-07-24

## Decision

North America coverage is possible, but it is not a bounds-only change. NavOSS must expand routing,
search, map operations, regional quality evidence, and support capacity together. Until those gates
pass, the API contract and app continue to report Calgary as the only supported production coverage.

The preferred architecture keeps the current MapLibre and native NavOSS navigation experience:

1. expand OpenStreetMap-backed Valhalla routing and search to Canada, the United States, and Mexico;
2. retain local and official regional datasets as additive overlays rather than continent-wide claims;
3. license live traffic with explicit mobile-navigation and CarPlay rights; and
4. activate traffic only when the provider, privacy, attribution, cost, and physical-road gates pass.

Mapbox is the first commercial traffic candidate. TomTom is the second quote. Google Routes and
Google Navigation content must not be mixed with the existing MapLibre map. Apple MapKit does not
expose a reusable live-traffic feed for the NavOSS server or MapLibre route geometry.

This is an engineering decision record, not legal advice. A signed provider agreement controls over
public documentation when they differ.

## Why the current stack is regional

- `AppConfigResponse` identifies coverage as `calgary-ab`, with Calgary bounds and driving mode.
- Production Valhalla and Nominatim import the Alberta Geofabrik extract.
- The Calgary business and parcel index improves local search but has no equivalent continent-wide
  source.
- Official safety-camera data is a Calgary overlay and must remain labelled as such outside the
  routing/search coverage decision.
- The production VM has 4 vCPU, 16 GiB RAM, and 160 GiB of artifact storage. It is appropriate for
  the current Alberta services, not a full North America geocoder import and blue/green update set.

As of 2026-07-24, Geofabrik's North America PBF is 17.9 GB: Canada is 6.0 GB, the United States is
11.2 GB, and Mexico is 607 MB. The compressed source is only the beginning of the storage budget.
Nominatim recommends flatnode storage for North America-sized imports with at least 75 GB free for
that file alone. It recommends fast NVMe, at least 64 GB RAM for large imports, and substantially
more working disk than the final serving database. Dynamic update tables consume roughly half of a
normal Nominatim database but are required for replication updates.

## Provider decision matrix

| Provider                            | What it can provide                                                                                              | Fit with current MapLibre/CarPlay app                                                                                                                                                  | Decision                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Google Routes / Navigation SDK      | Traffic-aware routes, ETAs, congestion, incidents, and a complete navigation SDK                                 | Google Maps Platform Service Specific Terms sections 12.2 and 19.2 prohibit Navigation SDK and Routes API content in conjunction with a non-Google map                                 | Reject for the current stack. Reconsider only as a deliberate full map/navigation-stack replacement |
| Apple MapKit / Maps Server API      | Apple routes and estimated travel time; traffic rendered by Apple map configurations                             | No documented reusable raw traffic feed. Combining an Apple ETA with different Valhalla geometry would not be route-specific traffic delay                                             | Reject as a NavOSS traffic feed. It remains an Apple-only full-map alternative                      |
| Mapbox Directions `driving-traffic` | Live traffic-aware duration, typical duration, congestion, incidents, closures, route geometry, and instructions | The existing server adapter already normalizes total ETA and delay. Mapbox also markets enterprise live/typical traffic matched to OSM or OpenLR for custom routing engines            | Preferred, subject to a written vehicle/CarPlay/open-source agreement and production pricing        |
| TomTom Traffic and Routing          | Minute-updated flow, current and free-flow speed, vector/raster flow tiles, incidents, and traffic-aware routes  | Technically suitable, but standard portal terms exclude Navigation Functionality and Automotive Usage, explicitly including CarPlay, unless TomTom grants a separate written agreement | Obtain a second enterprise quote; do not use under self-service portal terms                        |
| HERE Traffic and Routing            | Traffic flow/incidents, traffic-aware routing, maps, and a navigation SDK                                        | Technically credible, but MapLibre display, storage, open-source distribution, and CarPlay rights require product-specific written terms                                               | Keep as a third commercial fallback after Mapbox and TomTom                                         |
| Self-hosted OSM + Valhalla only     | Provider-independent route geometry, instructions, map matching, and regional customization                      | Best architectural fit and can cover North America, but OpenStreetMap does not include a live traffic feed                                                                             | Keep as the traffic-free fallback and routing control plane                                         |

## Traffic licensing request

Before a provider token or feed reaches production, written terms must explicitly cover:

- consumer turn-by-turn navigation on iPhone;
- Apple CarPlay phone projection, separate from embedded automotive software;
- display with the current MapLibre/OpenStreetMap map, or an approved replacement map stack;
- server-side proxying from the NavOSS Fastify API;
- live and typical traffic for Canada, the United States, and Mexico;
- route geometry, congestion, incidents, closures, and traffic-delay display rights;
- caching, retention, derived-data, road-conflation, and reroute rights;
- an open-source client with a private server token;
- required attribution, privacy disclosures, telemetry, deletion, SLA, quotas, and pricing; and
- a development/test allowance that includes real phone and CarPlay validation.

Mapbox should quote two products separately:

1. Directions API `mapbox/driving-traffic`, which is the shortest path with the existing adapter; and
2. enterprise Traffic Data in OSM/OpenLR form, which could feed a custom Valhalla pipeline and reduce
   route-provider lock-in at substantially higher engineering and operations cost.

## Expansion architecture

### Routing

Build North America Valhalla graph artifacts on a dedicated import machine, validate them, and swap
immutable serving artifacts. The current production VM should serve a tested graph, not perform the
initial continent build. Preserve Valhalla as the no-traffic fallback even when a traffic provider is
enabled.

### Search

Do not simply point the current two-worker Nominatim container at the North America PBF. Benchmark a
dedicated Nominatim import and serving tier with:

- 64-128 GiB RAM;
- fast NVMe with at least 1-2 TB working capacity for import, update data, and blue/green copies;
- flatnode storage;
- Wikipedia/Wikidata importance for named-place ranking;
- US TIGER housenumbers and postcode enrichment where licence and quality allow;
- replication updates and a rehearsed rollback; and
- separate search-quality cases for Canadian, US, Mexican, rural, Indigenous, bilingual, unit, and
  recently opened addresses.

The exact production size must come from a benchmark import. These are planning envelopes, not a
claim that every deployment requires the same host.

### Maps

The existing map style already renders beyond Calgary through OpenFreeMap. That visual availability
does not imply supported search or routing. Keep map attribution visible and evaluate a paid tile SLA
or self-hosted vector tiles before claiming continent-wide production reliability.

### Regional overlays

Safety cameras, parking, closures, and municipal place enrichment remain source-specific. The API
must publish their individual coverage and freshness rather than treating a Calgary dataset as a
North America feature.

## Staged rollout

1. **Provider and capacity benchmark:** obtain Mapbox and TomTom written proposals; benchmark Canada
   and North America graph/search imports on dedicated NVMe infrastructure.
2. **Canada internal coverage:** generalize the coverage contract, deploy Canadian routing/search,
   and add cross-province, bilingual, rural, ferry, winter-road, and border-adjacent route cases.
3. **United States internal coverage:** add TIGER/postcode search enrichment, interstate/toll/express
   lane cases, unit-address cases, and multi-time-zone route checks.
4. **Mexico internal coverage:** add Spanish search/instructions, toll-road, address-format, border,
   and regional route-quality cases.
5. **Licensed traffic beta:** enable the provider only in a separate production environment; verify
   traffic attribution, total ETA, typical ETA, delay, incidents, closures, rerouting, privacy, cost,
   and failover on phone and CarPlay.
6. **Public coverage claim:** change the API coverage contract and website only after the regional
   gates, monitoring, rollback, and support procedures pass.

## Activation gates

North America is not ready to claim until all of the following are true:

- continent graph and search imports are reproducible and updated;
- blue/green rollback is rehearsed;
- regional route/search suites pass with documented manual comparisons;
- public map/search/routing capacity is monitored under load;
- traffic terms are executed and the server token remains private;
- privacy policy, App Store privacy answers, and in-app attribution match the provider path;
- no-traffic fallback remains explicit and tested; and
- physical phone, locked-screen, wired CarPlay, and wireless CarPlay runs pass in more than one
  region and time zone.

## Primary sources

- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
- [Google Routes policies](https://developers.google.com/maps/documentation/routes/policies)
- [Apple `MKDirections`](https://developer.apple.com/documentation/mapkit/mkdirections)
- [Apple MapKit traffic display](https://developer.apple.com/documentation/mapkit/mkmapview/showstraffic)
- [Mapbox Directions API](https://docs.mapbox.com/api/navigation/directions/)
- [Mapbox Traffic Data](https://www.mapbox.com/traffic-data)
- [Mapbox CarPlay guide](https://docs.mapbox.com/ios/navigation/guides/carplay/)
- [TomTom Traffic Flow](https://developer.tomtom.com/traffic-api/documentation/traffic-flow/traffic-flow-service)
- [TomTom portal terms](https://docs.tomtom.com/legal/terms-and-conditions)
- [Geofabrik North America extracts](https://download.geofabrik.de/north-america.html)
- [Nominatim installation](https://nominatim.org/release-docs/latest/admin/Installation/)
- [Nominatim import](https://nominatim.org/release-docs/latest/admin/Import/)
- [Nominatim updates](https://nominatim.org/release-docs/latest/admin/Update/)
- [Valhalla](https://github.com/valhalla/valhalla)
