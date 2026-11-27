# North America coverage and traffic decision

Decision date: 2026-07-24

## Decision

North America coverage is possible, but it is not a bounds-only change. NavOSS must expand routing,
search, map operations, regional quality evidence, and support capacity together. The selected source
coverage is now Canada, not the whole continent. The legacy `/v1/config`
continues to identify Calgary for strict shipped clients; `/v2/config` declares all 13 provinces and territories.

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

## Alberta and British Columbia source milestone

The revival source aligns search and route eligibility with the documented Alberta+BC Nominatim and
Valhalla imports. One shared data registry contains Statistics Canada's simplified 2021 provincial
digital boundaries. Eligibility uses those polygons, including islands and coastal waters, not the
rectangular retrieval envelopes. Search results are polygon-filtered before limiting; every route
origin, waypoint and destination is checked. Calgary civic search/cameras and Kelowna/DriveBC
context remain separately labelled **local overlays**.

`/v1/config` and `/v1/routes` remain legacy-shaped for TestFlight build 70. Optional lane, signpost,
current-road, roundabout, bearing and posted-limit-status data is available at `/v2/routes`.
V2 waypoints accept `type: "break" | "through"` (default `break`) so a keep-route rejoin anchor need
not produce an intermediate arrival. Build 75 onward uses v2; lanes and signposts are shown only
when returned by the server.

Validation includes sourced border fixtures and real Calgary/Metro Vancouver Valhalla responses,
plus the exact production `valhalla-scripted:3.8.2` image with a local Calgary extract. The
22-directed-route provincial matrix covers Edmonton, Red Deer, Lethbridge, Banff, Vancouver,
Victoria, Kelowna, Kamloops, Prince George and Calgary–Vancouver. It passed 22/22 on both the
staged and live Canada service; it is not a province-wide quality verdict.
See [`../testing/route-quality.md`](../testing/route-quality.md) for contracts and reproduction.

## Clients follow what the server declares

Clients must keep working against every deployed server generation, so they read the config
leniently (`serverConfigFromPayload` in `packages/contracts/src/client-config.ts`, mirrored natively
by `NavigationServerConfig.swift`): fields newer than the oldest deployed server are optional,
unknown fields, endpoints and features are ignored, and anything absent or malformed means "not
available". `AppConfigResponseSchema` stays strict for what the current server emits.

Search proximity, route eligibility and the coverage copy come from the server's declared service
areas: a server that declares "Calgary and Kelowna service areas" (the pre-#79 image) gets Calgary
and Kelowna; one that declares Alberta and British Columbia gets the provinces. A declared area is
checked against the boundary the server sent, otherwise its rectangle; the bundled StatCan polygons
are used only for a province the server declares without one. Before the config arrives nothing is
refused locally (the server still refuses what it does not serve), and native reroutes are never
refused for crossing uncovered roads. Recorded production and new-server configs live in
`apps/mobile/test/fixtures/server-config`.

## Canada-wide coverage

Decision date: 2026-11-15 (owner: Canada-wide, VM may grow). This replaces the Ontario-first plan in
"Staged rollout" step 2.

### Decision

- **One merged Canada extract, one graph and one index.** Geofabrik's `canada-261114.osm.pbf`
  (6,502,858,272 bytes, measured) feeds one Valhalla graph and one Nominatim database. Regional
  graphs would need one Valhalla process per graph and an API that picks one per request, and a
  route crossing two of them could not exist; one Canadian graph has the same serving shape as
  today with no new moving parts. Search is one database for the same reason (Nominatim cannot
  merge databases). Geofabrik's provincial extracts would need a merge anyway; the country file
  avoids it.
- **Registry plus declaration.** All 13 provinces and territories are in the registry
  (`packages/contracts/src/coverage-data.ts`) from the same Statistics Canada 2021 boundary query
  as Alberta and BC (those two re-fetched byte-identical). A server serves only what
  `NAVOSS_SERVICE_AREAS` declares (default `alberta,british-columbia`; production declares all 13). It
  fails closed: an unknown or repeated id refuses startup; with production search the
  `NOMINATIM_DATASET_VERSION` region must be `canada` or name every declared province; `/ready`
  fails when Valhalla `/locate` finds no road at a province's fixed public probe point or
  Nominatim `/reverse` does not place it in that province. Adding a province later is a registry
  entry (boundary, neighbours, certain time zones, probe) plus data.
- **Publish only what the data answers for** (`apps/api/src/coverage-publication.ts`). A declared
  province is published (in `/v2/config`, search, routes and community reports) only after its
  probes have answered once, so a half-applied cutover (Canada declared, search still Alberta+BC)
  publishes Alberta+BC, not 13 provinces. At startup the API retries for up to 20 s before
  listening; then it serves what answered and checks the rest every 30 s, and on requests at most
  every 5 s. While nothing has answered, `/v2/config`, `/v1/search` and both route endpoints answer
  `503` ("Service starting"), and each such request checks again first, so service resumes when
  the dependency answers, not at the next interval. A province is never removed: the installed
  data does not change while the API runs (a release recreates it), the phone keeps `/v2/config`
  for its launch and the native client for an hour, and a later outage already fails its own
  requests. `/ready` keeps probing live and stays `503` until every declared province is published,
  and `check-coverage.sh` (in `check-stack.sh`) requires `/v2/config` to declare exactly
  `NAVOSS_SERVICE_AREAS`, so a partial cutover fails the checks and is rolled back. `/v1/config`
  does not depend on it.
- **Copy from the declaration.** `/v2/config` names the declared provinces in registry order
  ("Alberta, British Columbia and Ontario"); all 13 are "Canada" (`id: canada`). The app already
  shows the server's name ("Search and directions cover Canada."). `/v1/config` stays the strict
  Calgary response for build 70 (tested byte-identical with and without more provinces).
- **Community traffic stays Alberta+BC** (`COMMUNITY_TRAFFIC_COVERAGE`): its verified serving graph
  and dead-end mask exist only for that extract. Collect mode keeps working on the Canada graph
  for Alberta+BC probes and refuses the rest.

### Provinces no road joins

The registry records which neighbours a road or scheduled vehicle ferry joins. When the
declared provinces do not connect, for example Alberta+BC and Ontario without Saskatchewan and
Manitoba, or Nunavut (no road to any neighbour), the API refuses before calling Valhalla:
`400`, title "No route between these provinces", detail "NavOSS can't plan a drive between
British Columbia and Ontario: no road it covers connects them." It names both places, blames
nothing and does not suggest a detour NavOSS cannot plan. With all of Canada declared, only Nunavut
is unreachable. The phone in builds 75 and 80 shows that detail as the route error. CarPlay in those
builds does not: their native client discards a `400` body, so it shows "Route unavailable" and
"Check your connection and try again", which is wrong for this answer. From build 81 the
native client reads a `400` in the problem shape as `routeRefused` with the server's title and
detail without retrying the refused request, and CarPlay shows them in a navigation alert like
"No road route" below; a `400` without that shape stays an invalid request.

Inside the declared provinces Valhalla itself can find no road (or ferry) route: Haida Gwaii with
ferries avoided, Toronto's Centre Island, between Nunavut communities. Valhalla answers `400` with
error 442 (protobuf and JSON alike, recorded in `toronto-island-no-path.json`); the API turns that
into `422`, title "No road route", detail "No road connects these places. Some are reached only by
air, by water or by a winter road." Other Valhalla failures stay `503` "Routing unavailable". `422`
is deliberate: builds 75 and 80 show the detail as the route error, while a `400` would make the
phone retry once without its optional fields and a `404` would send it to `/v1/routes`. CarPlay in
those builds shows its generic unavailable message for that status; from build 81 the native
client reads a `422` problem's title and detail and CarPlay shows "No road route" with the detail,
or its first sentence where the alert is narrow. A `422` without that shape stays "unavailable", and
it no longer triggers the offline-map fallback (the offline graph holds the same roads).

### Time zones

Valhalla's `timezones.sqlite` already holds every Canadian zone; `stage-coverage.sh` checks nine of
them before building. The app needs a zone only for "Open / Closing soon" place hours; the registry
declares one only where it is certain and otherwise the hours stay raw:

| Province or territory             | Declared zone                                                  | Not declared (hours stay raw)                                     |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Alberta, Northwest Territories    | America/Edmonton                                               | —                                                                 |
| British Columbia                  | none (Kelowna overlay: America/Vancouver)                      | five zones in use                                                 |
| Saskatchewan                      | America/Regina, 109.5° W to 102.5° W                           | Lloydminster, Creighton and other border towns                    |
| Manitoba                          | America/Winnipeg                                               | —                                                                 |
| Ontario                           | America/Toronto, south of 50° N and east of 90° W              | Kenora and the northwest; far-north First Nations on Central time |
| Quebec                            | America/Toronto west of 63° W                                  | Lower North Shore, Magdalen Islands (Atlantic)                    |
| New Brunswick                     | America/Moncton                                                | —                                                                 |
| Nova Scotia, Prince Edward Island | America/Halifax                                                | —                                                                 |
| Newfoundland and Labrador         | America/St_Johns (UTC−3:30) on the island and Labrador Straits | rest of Labrador (Atlantic)                                       |
| Yukon                             | America/Whitehorse (UTC−7 all year)                            | —                                                                 |
| Nunavut                           | none                                                           | four zones                                                        |

### Quebec: French names, signs and speech

Valhalla reads OSM `name`, which in Quebec is French; 3.8.2 does not substitute `name:en`, and
NavOSS asks for English narrative (`language: en-US`). A recorded Montreal route (fixture
`montreal-a520-a40-a15.json`) reads "Keep right to take exit 70 onto 15/Autoroute des Laurentides
toward Laval." with sign "15 Nord", and "Enter Rond-point Dorval…". That is what the driver sees on
the sign, so it is kept: no translation of street names or of French-only signs. Ontario's bilingual
guide signs ("401 East Express" and "401 Est Express" on one sign) are collapsed to the English
entry. The phone and CarPlay speak `spokenInstruction` with the best installed `en-CA` voice, so
French names are pronounced by an English voice. A French narrative and voice for Quebec is a
product decision (it changes every instruction a Quebec driver hears) and is not part of this change.

### Ferries, seasonal and ice roads

- Ferries stay in the graph and follow the existing `avoidFerries` preference. Marine Atlantic
  (North Sydney to Port aux Basques, all year; to Argentia, summer) is the only road link to the
  island of Newfoundland; Wood Islands (Prince Edward Island) is seasonal, the Confederation Bridge
  is not; BC Ferries serve Vancouver Island. The matrix's Halifax to St. John's case states it.
- Valhalla 3.8.2 interprets neither `ice_road`, `winter_road` nor `seasonal`, so a winter road over
  a frozen lake would be offered in July. NavOSS has no source for opening dates, so
  `filter-routing-pbf.sh` removes those ways from the routing input (search keeps them). Measured:
  4,456 ways in all Canada, 1,208 in Ontario, 47 in New Brunswick plus PEI (Geofabrik 261114);
  the Canada routing input passed check-refs. Date-conditional `access:conditional` closures are
  not modelled by this build; the matrix and tester reports are the check.

### Speed profile

The OpenStreetMapSpeeds province rows apply as published except where reviewed. Alberta keeps its
validated hybrid (global urban rows, urban trunk 50 km/h). Ontario's source urban trunk speed is
20 km/h, which would push routes off urban trunk roads, so the same hybrid is applied to Ontario
(the 2026-11-15 build used profile SHA-256 `e7348efa…`). Since 2026-11-27 Alberta alone also keeps
posted limits on suburban and urban motorways and its own urban primary speed
(`docs/testing/route-quality.md`, "Calgary arterial and freeway speeds"); Ontario's hybrid is
unchanged. A second, separable change sets Alberta's urban secondary to 32 km/h; the next build's
profile is `27bdcff0…` with it and `8f8e60ea…` without. The Ontario hybrid is a rule carried
over, not an Ontario calibration: Ontario, Quebec and the rest need same-time spot checks before
anyone claims ETA quality there.

### Sizing on the production VM (6 vCPU, 24 GiB, 260 GB artifact disk)

- **Canada extract:** 6.50 GB; Ontario 1.02 GB, Quebec 1.17 GB, measured for Geofabrik 261114.
- **Alberta+BC extract:** 1.60 GB (352 MB + 1,250 MB), measured; Canada is 4.06×.
- **Alberta+BC artifacts:** Nominatim 6.0 GiB; Valhalla 2.8 GiB, 3,344 tiles; serving tar 589 MB, measured on the VM.
- **Toronto–Hamilton sample (128 MB):** Nominatim 1.57 GB database + 2.0 GB WAL, 14 min on 4 Mac cores; Valhalla tar 214 MB, approximately 30 seconds per pass, measured locally 2026-11-15.
- **Canada inputs:** 9 minutes; 4,456 seasonal or ice-road ways removed; check-refs clean, measured on the production VM.
- **Canada Valhalla:** 8,767 tiles; 3.9 GB stage after cleanup; both passes approximately 35 minutes on 4 cores, measured on the production VM.
- **Canada Nominatim:** 147 minutes; 18 GB frozen database; 10 GiB container; `--osm2pgsql-cache 3000`, measured on the production VM.
- **Flatnode:** no; Nominatim recommends it for Europe, North America and planet imports, but it needs at least 75 GB whatever the extract.
- **Live after cutover:** limits Nominatim 8 GiB, Valhalla 4 GiB, API 0.75 GiB, reports 0.75 GiB, indexer 0.5 GiB and Caddy 0.2 GiB, totalling 14.2 GiB of 24.
- **Disk at peak:** about 89 GB; 60 GB used of 255 GB after cutover, measured on the production VM.

The first Nominatim attempt was OOM-killed after 10 minutes: the image ignored `OSM2PGSQL_CACHE`
and chose 12.4 GB. #124 passes `--osm2pgsql-cache 3000` explicitly.

Canada fits 24 GiB only with the steps run one at a time, which `stage-coverage.sh` enforces: the
import's 10 GiB plus the live stack (≈ 2.5 GiB in use) leaves more than the 4 GiB floor. If the
import shows sustained swap or the disk peak exceeds the estimate, the fallback is Canada routing
with search imported for fewer provinces (runbook, "Staged search"); since a province is declared
only with its search data, the app never offers a province whose search is missing. Importing all of
Canada faster or with update tables (replication) would need about 48–64 GiB and a 500 GB disk,
beyond what the homelab server can give the production VM today.

### Cutover and rollback

Runbook: [`infra/compose/README.md`](../../infra/compose/README.md#canada-coverage-release-geofabrik-261114).
Artifacts are versioned by release date (`valhalla-canada-261114`, `nominatim/canada-261114`,
`imports/canada-261114.osm.pbf`) beside the live `…alberta-british-columbia-260730…` ones. A staged
API on 127.0.0.1:18300 ran `stage-coverage.sh verify canada` and both matrices. The cutover at
15:44 UTC on 2026-11-15 changed the four artifact values, declaration and memory limits. The
image is from `4708d34`; rollback tag `navoss-api:pre-canada-registry`. Restore
`infra/compose/.env.pre-canada-20261115T154413Z` and run
`docker compose up -d --no-build --wait valhalla nominatim api caddy` for data rollback.
The Alberta+BC artifacts remain available.

### Route-quality matrix

`apps/api/scripts/route-quality-canada.json` (80 directed routes): the unchanged Alberta+BC 22;
Ontario (Toronto 403/401 interchanges with lanes, Hamilton, Ottawa, London, Windsor, Sudbury,
Thunder Bay); Quebec (Montreal autoroute interchanges with lanes, Quebec City, Gatineau,
Sherbrooke, Ottawa–Gatineau); the Prairies (Regina, Saskatoon, Winnipeg); Atlantic (Halifax,
Moncton, Saint John, Charlottetown, St. John's by ferry); the North (Edmonton–Yellowknife,
Whitehorse–Edmonton); one corridor inside each province otherwise crossed only by
inter-provincial routes (Halifax–Dartmouth, Charlottetown–Summerside, St. John's–Mount Pearl,
Winnipeg–Brandon, Whitehorse–Carcross, Yellowknife–Behchokǫ̀), which `check-coverage.sh` routes
when that province is declared alone; and Calgary–Winnipeg, Toronto–Montreal and Vancouver–Toronto (stress, 30 s
latency allowance). Ranges are review gates, not measurements. Staged and live runs passed the
Alberta+BC 22/22 and Canada 72/80 (475 ms p95 live). Eight failures were threshold artifacts:
straight rural segments of 2.1–9.0 km and Winnipeg–Brandon durations of 141–143 minutes.
A throttled public run at 15:53 UTC after adjusting the gap and duration checks passed 80/80
(652 ms p95; definition SHA-256 `0e4d88ff7baa41e8bac455811e9dbdb61d0fbd2934803d1e602242b6f600dc24`).
The gap rule retains 2 km for urban routes and scales with route length up to 10 km; Winnipeg–Brandon's
150-minute bound is supported by [Road Trip Manitoba](https://roadtripmanitoba.com/manitoba-route-guides/winnipeg-to-brandon/).

## Current stack and regional overlays

- `/v2/config` publishes all thirteen Canadian provinces and territories with sourced boundaries;
  `/v1/config` preserves the Calgary response for shipped clients.
- The Canada Nominatim and Valhalla artifacts are live; the prior Alberta+BC artifacts remain
  available for rollback.
- The Calgary business and parcel index improves local search but has no equivalent continent-wide
  source.
- Official safety-camera data is a Calgary overlay and must remain labelled as such outside the
  routing/search coverage decision.
- The production VM has 6 cores, 24 GiB RAM, a 60 GB system disk and a 260 GB artifact disk since
  2026-11-15, and its host cannot give it more today (sized for a staged Canada release, see above). It is not
  sized for a North America geocoder import.

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

### Self-hosted traffic pipeline

Valhalla already supports the server-side structures NavOSS needs, but it does not supply the
observations. A legitimate feed must be mapped to directed Valhalla edges before optimization can
begin:

1. ingest provider flow observations with source timestamp, direction, current speed, free-flow
   speed, confidence, and stable segment identifier;
2. conflate provider segments to the exact immutable Valhalla graph revision, preferably through
   licensed OSM/OpenLR references rather than coordinate proximity alone;
3. reject stale, low-confidence, direction-ambiguous, or graph-mismatched observations;
4. write live speeds into the fixed-size `traffic.tar` overlay and atomically publish it without
   rebuilding the base graph;
5. aggregate retained licensed observations into per-edge weekly 5-minute profiles and import them
   with `valhalla_add_predicted_traffic` during immutable graph builds;
6. route with current departure time, report feed coverage/freshness, and fall back explicitly to
   historical or free-flow speeds when live observations are absent; and
7. compare same-time routes and ETAs against held-out drives before exposing traffic colours or
   traffic-aware claims.

Public OSM `maxspeed` is suitable for known posted-limit display but is not a traffic feed. NavOSS
must not derive congestion from road class, speed limit, anecdotal drive times, or unconsented user
traces. Until a licensed source is contracted, the current `traffic: unavailable` response remains
correct.

### Location refinement

Place quality work should improve the existing self-hosted pipeline rather than scrape commercial
maps. Priorities are Nominatim replication freshness, entrance/driveway-aware arrival points,
Calgary business-to-OSM deduplication, category purity, closed-place suppression, address/unit
normalization, exact proximity ordering, and explicit source/freshness metadata. Add query and
destination fixtures for every reported bad result before changing ranking weights.

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

Alberta and British Columbia are the selected routing/search area. Toronto/GTA remains an
overlay-first future expansion: benchmark an Ontario Valhalla and Nominatim staging deployment and
regional route/search cases before adding its boundary to the shared service-area registry. Keep the
legacy `/v1` response stable; updated clients use the versioned coverage and routing contracts.

The first code milestone provides a validated and deployed `/v2/cameras?region=toronto-on` feed and
loads its markers only when the phone is inside Toronto bounds. On July 30, 2026, production returned
301 daily-refreshed red-light-camera locations. This is still an overlay, not Ontario search or
routing coverage. Ontario search and routing remain blocked on staging imports and
quality gates above.

Toronto's red-light-camera dataset identifies intersections but not enforced approach direction.
Those records may be displayed as official red-light-camera markers, but they must not trigger the
current direction-aware spoken alert. Ontario's municipal automated-speed-enforcement dataset is
historical after the provincial ban in November 2025 and must not be published as an active overlay.

The first Ontario 511 integration is implemented through `GET /v2/events?region=ontario`. The server
polls the official event feed every five minutes within the documented 10-calls-per-60-seconds
limit, normalizes source timestamps and closure state, filters expired or out-of-province points,
and retains a bounded 24-hour in-memory stale snapshot. The phone switches to this feed only when
its current coordinate is in Ontario and keeps Ontario 511 attribution visible. A July 30, 2026
production-equivalent probe normalized 602 construction events, 11 incidents, and one closure.
Road-condition polylines, roadside camera imagery, and province-wide alerts remain separate future
contracts rather than being silently flattened into point events.

Ontario 511 events and conditions are not a reusable directed-edge speed-flow feed. They can support
closure, construction, incident, condition, and camera overlays, but they must not be presented as
live congestion speeds or used to claim traffic-aware ETA. Traffic-aware routing still requires the
licensed flow pipeline described above.

## Staged rollout

1. **Alberta+BC source coverage:** deploy the polygon-enforced API, retain strict v1 compatibility,
   run the provincial route matrix and regional search gates, and validate rollback and client use.
2. **Canada expansion:** one staged Canada release (see "Canada-wide coverage"), verified by the
   80-route matrix and per-province search before `NAVOSS_SERVICE_AREAS` declares it; Toronto
   cameras and Ontario 511 stay source-labelled overlays.
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
- [Statistics Canada 2021 province/territory digital boundaries](https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Digital_boundary_files/MapServer/0)
- [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada)
- [Nominatim import](https://nominatim.org/release-docs/latest/admin/Import/)
- [Nominatim updates](https://nominatim.org/release-docs/latest/admin/Update/)
- [Valhalla](https://github.com/valhalla/valhalla)
