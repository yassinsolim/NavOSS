# Regional route-quality reports and v2 guidance contract

Date: 2026-08-01

## Revival coverage and guidance validation

The service-area source now declares **Alberta and British Columbia**. The historical Calgary
measurements below are retained unchanged; they are not results for the new provincial matrix.
`apps/api/scripts/route-quality-alberta-bc.json` defines 11 reciprocal corridor families (22 directed
routes), including Edmonton, Red Deer, Lethbridge, Banff, Vancouver, Victoria, Kelowna, Kamloops,
Prince George, a Calgary interchange, and Calgary–Vancouver. Public anchors are not claimed to be
verified entrances. No production provincial-matrix result has been fabricated or recorded.

The matrix selects `/v2/routes`; existing regional/Calgary suites keep `/v1/routes`. The shared
script also reports actual lane/signpost maneuver counts, current-road-name coverage and
known/unknown/unlimited posted-limit segment counts. Its Calgary interchange corridor requires
at least one lane-bearing maneuver. All previous structural, access, duration and explicit
traffic-unavailable checks remain.

### Local API/image evidence

At `2026-11-13T01:31:38.981Z`, the API built by `infra/compose/api.Dockerfile` on
`http://127.0.0.1:3013` routed against the exact 3.8.2 image and the public Calgary extract.
Strict v1 configuration returned `calgary-ab`; v2 returned the two provincial service areas.
The real Deerfoot/Glenmore route had **7 lane-bearing maneuvers** and **423 posted-limit segments**.
At exit **248**, the two left straight lanes were invalid and the right-turn lane was valid/active
with `validIndication: "right"`. The HTTP break/through probes returned respectively two/one arrival
steps, and `/ready` was healthy.

Ten warm requests per endpoint, interleaved after one excluded warm-up each, measured:

| Local endpoint |   Median |      p95 |
| -------------- | -------: | -------: |
| `/v1/routes`   | 17.81 ms | 38.18 ms |
| `/v2/routes`   | 18.63 ms | 26.81 ms |

The observed median v2 overhead was **0.82 ms**. This small local sample is not a production SLA
or a regional quality verdict. The clean Docker build's frozen-lockfile install succeeded with
`protobufjs` postinstall denied; its deployed package excluded code-generation scripts/test
fixtures and loaded the light runtime successfully.

### Versioned compatibility and fields

Build 70's strict phone decoder rejects unfamiliar response keys. Therefore `/v1/config` retains
`calgary-ab` and `/v1/routes` retains its legacy shape and OSRM request path. `/v2/config` advertises
`/v2/routes`, and its service-area array contains sourced provincial polygons plus separately scoped
Calgary/Kelowna overlays. Phone/native migration to v2 and lane UI integration are client-wave work,
not claimed by the API change.

The optional v2 step fields are:

| Field                                          | Meaning                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentRoadName`                              | Sourced name/reference of the road driven along this step's geometry; use the current step, not the upcoming one.                                                           |
| `lanes`                                        | Left-to-right approach-lane array for the maneuver at the **beginning** of this step; count is `lanes.length`.                                                              |
| `lanes[].indications`                          | `none`, `uturn`, `sharp_left`, `left`, `slight_left`, `straight`, `slight_right`, `right`, `sharp_right`, `merge_left`, `merge_right`; empty when the source mask is empty. |
| `lanes[].valid` / `active` / `validIndication` | Usable lane, preferred lane, and the source-selected indication. Active implies valid; valid does not imply active.                                                         |
| `maneuverModifier`                             | Directional modifier for the maneuver; omitted for departure/arrival side-of-street flags.                                                                                  |
| `roundaboutExit`                               | Source roundabout exit count when present.                                                                                                                                  |
| `bearingBeforeDegrees` / `bearingAfterDegrees` | Source maneuver headings, clockwise from true north; missing stays missing.                                                                                                 |
| `exitNumber` / `junctionName`                  | Source exit/interchange text.                                                                                                                                               |
| `signpost`                                     | Readable text composed from native source sign elements.                                                                                                                    |
| `signpostBranch` / `signpostToward`            | Separate source string arrays; never guessed by splitting mixed OSRM `destinations` text.                                                                                   |

Optional `route.speedLimits` is geometry-segment-aligned, with elements
`{ status: "known", kph: number }`, `{ status: "unknown" }`, or `{ status: "unlimited" }`.
Known values are positive. The legacy `speedLimitsKph` array keeps zero for unknown/unlimited;
unaligned or malformed annotations are omitted, not shifted onto another segment.
V2 `waypoints[].type` accepts `break` or `through`, defaulting to `break`. A through/rejoin point
does not create an arrival/departure pair. V1 still rejects the extra waypoint field.

The v2-only route hook is now connected to community traffic. In `COMMUNITY_TRAFFIC_MODE=live`,
usable published flow adds geometry-aligned `route.congestion` (`unknown`, `free`, `slow`, `heavy`,
`stopped`) and `route.traffic.observedFraction`. `source.trafficSource` uses
`{ id: "navoss-community", attribution: "Traffic from opted-in NavOSS drivers" }`; only a result
with that source advertises community traffic as `live`. An alternative without `traffic` is
unavailable for that route, not implicitly free-flow-observed. The API returns the enrichment
service's order unchanged. Off/collecting modes preserve the previous v2 result; licensed traffic
is never double-adjusted with community speeds.

The provincial matrix below is a free-flow benchmark: run it with community traffic off, or expect
its explicit traffic-unavailable posture check to flag a live-annotated response.

### Real fixtures and exact serving version

`apps/api/test/fixtures/valhalla/` contains decoded, trimmed captures from the repository's public
FOSSGIS development endpoint (`https://valhalla1.openstreetmap.de/route`) and the exact local serving
image `ghcr.io/valhalla/valhalla-scripted:3.8.2`. Captures retain timestamps, source URLs, raw-response
hashes and only consumed protocol fields; tests re-encode those tags without changing route values.
Fixtures are compact and retain only incoming/current maneuver edge fields; unreferenced node
slots remain empty so recorded indices are unchanged. Trimming was checked against the normalized
consumer output for every capture.
Calgary Deerfoot/Glenmore and Metro Vancouver interchanges exercise multiple/valid/active lanes and
native branch/toward sign elements. Real directions-only output covers absent lane/speed metadata.
Real local break/through captures have respectively two/one legs and two/one arrival steps, with
424 posted-limit annotations aligned to 424 geometry segments. Roundabout fixtures deliberately
preserve the different public/local source exit counts; they do not assert physical-road parity.

V2 sends a **binary PBF request** with `Content-Type: application/x-protobuf`, asking for both
`directions` and `trip`. Valhalla 3.8.2 does not parse a JSON `pbf_field_selector`; JSON requests with
`format: "pbf"` otherwise return directions only. The checked-in protocol subset is generated from
the pinned 3.8.2 `.proto` files, with source hashes and the MIT notice. The API uses the light
protobuf runtime; source/code-generation scripts are not in the deployed API package.

Base routing makes one upstream route request. Malformed/missing optional metadata is omitted while
the valid route remains. Transport failures (including body reads) and Valhalla error status use
the existing 503 path without retry. A received but undecodable base route gets exactly one legacy
format fallback; only `ValhallaDecodeError` is logged, and `/ready` reports extended guidance as
degraded-but-ready. A subsequent good PBF response clears that state. Through waypoint semantics
are preserved in the legacy-format fallback.

Regenerate the pinned descriptor, only when deliberately updating the serving protocol:

```sh
corepack pnpm --filter @navoss/api exec node scripts/generate-valhalla-protocol.mjs
```

Run the provincial matrix after deploying this API against a full Alberta+BC graph:

```sh
NAVOSS_API_URL=https://navoss-api.yassin.app \
  ROUTE_QUALITY_OUTPUT=artifacts/route-quality-alberta-bc-22.json \
  corepack pnpm --filter @navoss/api test:routes:alberta-bc
```

The local Calgary extract proves protocol compatibility, not Edmonton/BC/rural/ferry routing,
production deployment, or phone/CarPlay/head-unit behavior.

## Local provincial validation (local, graph dated 2026-11-11, not production)

Run on 2026-11-13 on the maintainer's Mac, **not** on the production VM. The API (`apps/api/dist`,
this branch, `NODE_ENV=production`, traffic `off`) routed against `ghcr.io/valhalla/valhalla-scripted:3.8.2`
(`valhalla_service`, 2 threads, 2 CPUs, 2 GiB, as in `infra/compose/compose.yaml`) serving the
real **Alberta + British Columbia** graph built by the offline-bundle pipeline (`graph.json`:
`valhallaVersion` 3.8.2, `dataDate` 2026-11-11, graph id `eeaa7a1d…`, OpenStreetMapSpeeds
profile `0a3f87cf…`; tiles mounted read-only). The image runs under amd64 emulation on Apple
silicon, so latencies are indicative only. There is no local Nominatim; search was not tested.

**22-route Alberta + BC matrix** (`route-quality-alberta-bc.json`, `alternatives: 1`):

- `/v2/routes`: **22/22 pass**; latency p50 16 ms, p95 170 ms.
- `/v1/routes`: 20/22 pass. The two failures are the Calgary interchange corridor's
  `minimumLaneManeuvers` gate: the frozen v1 contract carries no lane fields, so the gate is a v2
  gate and is not applicable to v1 (distances, durations and geometry are identical to v2).
  Latency p50 13 ms, p95 170 ms. The script now takes `ROUTE_QUALITY_PATH` to run a benchmark
  against another endpoint.

| Route                                                                                              |    km |   min | Avg km/h | Alternatives | Lane maneuvers | Signpost maneuvers | v2   | v1                                       | v2 ms | Review warnings                                 |
| -------------------------------------------------------------------------------------------------- | ----: | ----: | -------: | -----------: | -------------: | -----------------: | ---- | ---------------------------------------- | ----: | ----------------------------------------------- |
| calgary-interchange-north-to-calgary-glenmore-west                                                 |  17.8 |  20.7 |       51 |            2 |              7 |                  7 | PASS | FAIL (missing interchange lane guidance) |   170 | high circuity                                   |
| calgary-glenmore-west-to-calgary-interchange-north                                                 |  17.8 |  20.9 |       51 |            2 |              6 |                  9 | PASS | FAIL (missing interchange lane guidance) |    32 | high circuity                                   |
| edmonton-downtown-to-edmonton-university-area                                                      |   4.4 |  11.3 |       23 |            2 |              1 |                  0 | PASS | PASS                                     |    45 | —                                               |
| edmonton-university-area-to-edmonton-downtown                                                      |   4.4 |  11.7 |       23 |            2 |              5 |                  0 | PASS | PASS                                     |    16 | —                                               |
| red-deer-downtown-to-red-deer-south                                                                |   2.2 |   5.7 |       23 |            2 |              1 |                  0 | PASS | PASS                                     |    17 | —                                               |
| red-deer-south-to-red-deer-downtown                                                                |   1.7 |   4.1 |       25 |            1 |              0 |                  0 | PASS | PASS                                     |     7 | no alternate route                              |
| lethbridge-downtown-to-lethbridge-west                                                             |   5.1 |   5.6 |       55 |            1 |              0 |                  2 | PASS | PASS                                     |    16 | no alternate route, high circuity               |
| lethbridge-west-to-lethbridge-downtown                                                             |   4.3 |   5.0 |       51 |            1 |              0 |                  2 | PASS | PASS                                     |     7 | no alternate route                              |
| banff-downtown-to-banff-south                                                                      |   2.2 |   3.6 |       37 |            1 |              0 |                  0 | PASS | PASS                                     |     9 | no alternate route, destination entrance review |
| banff-south-to-banff-downtown                                                                      |   2.3 |   3.7 |       37 |            1 |              1 |                  0 | PASS | PASS                                     |     6 | no alternate route, origin entrance review      |
| vancouver-downtown-to-richmond-yvr-area                                                            |  13.0 |  21.5 |       36 |            2 |              6 |                  6 | PASS | PASS                                     |    84 | —                                               |
| richmond-yvr-area-to-vancouver-downtown                                                            |  13.1 |  24.4 |       32 |            2 |              2 |                  4 | PASS | PASS                                     |    84 | —                                               |
| victoria-downtown-to-victoria-university-area                                                      |   8.1 |  16.6 |       29 |            2 |              2 |                  0 | PASS | PASS                                     |    33 | destination entrance review                     |
| victoria-university-area-to-victoria-downtown                                                      |   7.7 |  15.9 |       29 |            2 |              2 |                  0 | PASS | PASS                                     |    15 | origin entrance review                          |
| kelowna-downtown-to-kelowna-airport                                                                |  15.1 |  19.0 |       48 |            2 |              1 |                  0 | PASS | PASS                                     |    30 | destination entrance review                     |
| kelowna-airport-to-kelowna-downtown                                                                |  15.1 |  18.5 |       49 |            2 |              1 |                  0 | PASS | PASS                                     |    13 | origin entrance review                          |
| kamloops-downtown-to-kamloops-west                                                                 |   4.0 |   8.8 |       27 |            2 |              3 |                  0 | PASS | PASS                                     |    17 | —                                               |
| kamloops-west-to-kamloops-downtown                                                                 |   3.8 |   8.2 |       28 |            2 |              2 |                  0 | PASS | PASS                                     |    12 | —                                               |
| prince-george-downtown-to-prince-george-west                                                       |   4.0 |   7.5 |       32 |            2 |              0 |                  0 | PASS | PASS                                     |    14 | —                                               |
| prince-george-west-to-prince-george-downtown                                                       |   4.0 |   7.6 |       32 |            2 |              0 |                  0 | PASS | PASS                                     |     8 | —                                               |
| calgary-downtown-to-vancouver-downtown                                                             | 973.8 | 652.4 |       90 |            2 |              5 |                  2 | PASS | PASS                                     |   211 | —                                               |
| vancouver-downtown-to-calgary-downtown                                                             | 973.9 | 653.8 |       89 |            2 |              6 |                  3 | PASS | PASS                                     |   163 | —                                               |
| Distances and durations are plausible against the anchors (Calgary–Vancouver 974 km in 10 h 52 min |
| at 90 km/h average; city routes 1.7–17.8 km at 23–51 km/h). Lanes appear on every motorway         |
| interchange route (Calgary Deerfoot/Glenmore 6–7 lane maneuvers, Vancouver–Richmond 2–6,           |
| Calgary–Vancouver 5–6) and signposts on the interchange, Vancouver–Richmond, Lethbridge and        |
| Calgary–Vancouver routes. Red Deer, Lethbridge and Banff returned no alternative; the anchor       |
| entrance and high-circuity warnings are review prompts, not failures.                              |

**Calgary 50** (`route-quality-calgary-50.json`): `/v1/routes` **50/50**, p50 23 ms, p95 33 ms;
`/v2/routes` **50/50**, p50 20 ms, p95 27 ms. No regression against the Calgary-only graph.

Reproduce: start the API against such a Valhalla on port 3015, then

```sh
NAVOSS_API_URL=http://127.0.0.1:3015 ROUTE_QUALITY_CASES=./scripts/route-quality-alberta-bc.json \
  ROUTE_QUALITY_PATH=/v1/routes node apps/api/scripts/route-quality.mjs
```

## Verdict

The fixed Calgary benchmark passed **50/50 directed routes in three consecutive runs** against the
production Valhalla deployment. All 150 responses had identical geometry hashes, distances, and
free-flow durations. Run p95 latency was 108 ms, 142 ms, and 136 ms. All three artifacts carry the
same SHA-256 benchmark-definition hash.

This proves deterministic, structurally valid free-flow routing. It does not prove Google Maps or
Waze parity: NavOSS has no live or historical traffic feed. Google Routes API comparison requires a
separate restricted credential and terms review. Waze exposes no public route-data API; consumer UI
scraping is not an acceptable substitute.

The benchmark surfaced actionable review candidates:

- 14 origins and 14 destinations need entrance/access review instead of accepting a POI centroid;
- 8 directed routes exceeded the 1.8 circuity review threshold; and
- 7 routes returned no meaningful alternate.

## Google Routes comparison

On 2026-08-01 the same 50 fixed public OD pairs were compared transiently with Google Routes API
using `TRAFFIC_AWARE_OPTIMAL`. This is not a claim about the Google Maps consumer app. The request
field mask included only distance, traffic-aware duration, and static duration; no polyline, steps,
or raw response was retained. The temporary Routes-only, IP-restricted key was removed after the run.

Aggregate result:

- distance median absolute difference: **2.5%**; signed median: **NavOSS +0.7%**;
- free-flow duration median absolute difference: **23.2%**; signed median: **NavOSS +23.2%**;
- NavOSS free-flow duration was higher on **46 of 50** routes;
- traffic-aware duration signed median: **NavOSS +21.8%**; and
- Google traffic delay over its static duration was **0.4% median**, **12.6% p95** during the run.

The route-distance result indicates that the typical route shape is reasonably close. The systematic
duration result indicates conservative Valhalla speed modeling is the larger ETA issue in this sample;
current traffic does not explain most of the gap. Google output is not used as a calibration target.
Production speed changes require independent observed-drive data or a licensed historical/live speed
feed, then a separate holdout benchmark.

## Alberta speed-model evaluation

The production graph build exposed a deterministic configuration defect: its admin database contains
Alberta and British Columbia polygons without an admin-level-2 Canada parent. Valhalla only resolves
a province speed record when the state row joins its country parent, so Calgary edges silently used
the global OpenStreetMapSpeeds profile instead of an explicit regional policy. The source speed file
is byte-identical to upstream commit `c9c6872` from 2022; no API-side ETA multiplier was tested.

Three isolated models were evaluated from the exact production PBFs and hash-bound 50-route corpus:

1. The unmodified `CA.AB` profile passed **50/50** and reduced median duration **16.1%**, but was
   rejected because a same-time public Google spot check showed the downtown route at **6.58 min**
   versus **10 min**. It overstates signalized urban movement speed.
2. A projected 13-second traffic-signal delay fixed downtown and airport spot checks but improved the
   corpus only **7.1% median** and left campus, industrial, and long routes **18-34%** slow. A custom
   Valhalla fork was therefore rejected.
3. The accepted hybrid preserves Alberta rural/suburban observations, uses the global urban profile
   for signalized streets, and raises only urban trunk from 35 to 50 km/h. Its deterministic profile
   SHA-256 is `0a3f87cfabf76c2428ee851e1d5b61f90ef21d6952e9a4a1d4759887713931d7`.

The hybrid candidate produced:

- **50/50** passing routes and **68 ms** p95 API latency;
- **5.45%** median duration reduction versus production;
- median reductions of **2.21% short**, **7.85% medium**, and **3.49% long**;
- effectively zero median distance change; and
- unchanged primary-road sequences on **40/50** routes.

Same-time public Google spot checks were **10 min** downtown versus NavOSS **9.77**, and **21 min**
downtown-to-airport versus NavOSS **20.38**. The remaining sampled routes stayed conservative:
campus **16.66 versus 13**, industrial **28.94 versus 20**, and long cross-city **47.58 versus 40**.
The latter three also carry entrance/access review warnings or need better historical/live speeds.
The hybrid was deployed on 2026-08-01 local time (2026-08-02 UTC) from the versioned artifact
`valhalla-alberta-british-columbia-260730-ca-parent`. The public post-cutover gate passed **50/50**
at **113 ms p95** and exactly matched the staged duration, distance, road sequence, and geometry hash
for every route. The previous artifact remains intact, with the mode-600 pointer backup at
/home/navoss/NavOSS/infra/compose/.env.pre-valhalla-hybrid-20260802T054114Z.

This is a bounded production improvement, not an exact-parity claim. Closing the remaining gap
requires reviewed entrance anchors plus independently observed or properly licensed historical/live
speeds; NavOSS still reports traffic as unavailable.

## Calgary arterial and freeway speeds

On 2026-11-27 the owner's commute into downtown Calgary was sent around the freeway loop (Stoney
Trail, Glenmore Trail, Crowchild Trail) instead of along Bow Trail. Route choice uses the graph's
static speeds only, so those speeds were read edge by edge on production (`valhalla-canada-261114`,
Valhalla 3.8.2, read-only `/route` and `trace_attributes` with `edge_walk` on the route's own
shape).

### What the graph holds

The 2026-11-15 Canada build is not defective: every edge reports admin `CA`/`AB`, the staged
`default_speeds.json` is the `AB ON` hybrid (`e7348efa…`), and suburban edges carry Alberta's
suburban observations, which only resolve through the repaired Canada parent.

A local rebuild of the same pipeline from Geofabrik `alberta-261111` (production is
`canada-261114`, three days newer) was compared with production on the fifty-route benchmark: 47
of 50 durations agree within one second. Shepard Industrial to Manchester and back keep their
roads and differ by 9 and 3 seconds. Airport Industrial to Foothills Industrial is recommended a
different road: its two candidates take 30.28 and 29.50 minutes on both builds, but the second is
1770.1 s on production (30 whole minutes, a tie, so the shorter 22.07 km route is ranked first)
and 1769.9 s locally (29 minutes, so the 23.08 km route is). Every "before" below is that local
build, so before and after differ by the profile alone.

The cause is how Valhalla applies a speed profile. With `use_default_speeds_config` a configured
class speed **replaces** the posted limit (`SpeedAssigner::UpdateSpeed` in 3.8.2 sets the speed
and marks it `classified` before it looks at a tagged `maxspeed`). Every edge below had a posted
limit and was served as `classified`:

| Road (production, quiet hour)                    | Class     | Posted limit | Served speed | Edge time | Transition time | Signals |
| ------------------------------------------------ | --------- | -----------: | -----------: | --------: | --------------: | ------: |
| Bow Trail SW (commute alternative, 7.1 km urban) | secondary |        60–70 |           25 |       98% |              2% |         |
| NB Macleod Trail, Anderson Rd to 7 Ave (10.9 km) | primary   |        50–70 |           27 |     98.4% |            1.6% |      33 |
| NB Deerfoot Trail, Glenmore to Stoney (23.7 km)  | motorway  |      100–110 |        85–88 |      100% |              0% |       0 |
| SB Stoney Trail, Peigan to Macleod (22.5 km)     | motorway  |          100 |       85–101 |      100% |              0% |       0 |
| WB Glenmore Trail, Ogden to Crowchild (9.2 km)   | motorway  |           80 |        85–88 |      100% |              0% |       0 |
| NB Crowchild Trail, Glenmore to 24 Ave (8.5 km)  | motorway  |        60–80 |           85 |       99% |              1% |       5 |
| same, signalised part                            | trunk     |        60–70 |           50 |           |                 |         |

Speeds in km/h. Density decides the row: Valhalla's density 0–5 is rural, 6–10 suburban, 11–15
urban. Transition, signal and turn costs are 0–2% of every route measured, so they are not the
cause. Three things follow:

1. **Limits ignored on freeways.** Deerfoot and Stoney Trail are served 12–20% below their posted
   limit and Glenmore and Crowchild 6–42% above it. One class value cannot describe both.
2. **The global urban row on Calgary arterials.** The hybrid replaced Alberta's urban row with the
   global one to slow signalised downtown streets. In Calgary 95% of primary kilometres are
   posted at 60 km/h or more (77% at 70–80) and 70% of secondary kilometres at 60 or more, and
   they are served at 27 and 25 km/h. Macleod Trail at its posted limits takes 11.0 minutes; the
   graph says 23.9.
3. **Not a cause:** the admin join, the profile file, density and transition costs.

### What changed

`prepare-valhalla-speeds.sh` keeps the hybrid and adds reviewed Alberta exceptions:

- **Motorway, suburban and urban:** left unset, so Valhalla's own rules apply. A motorway with a
  posted limit is served at it (`tagged`). One without is served at Valhalla's default: 105 km/h
  at density 6–8 and 89 at density 9–15. Sampled every 400 m on the baseline build, 1.3 of
  Alberta's 712 suburban and urban motorway kilometres (0.2%) have no limit. Motorway **ramps**
  are not affected: they keep the configured ramp values (74 and 68 km/h suburban, 62 and 60
  urban, signed exit and other), with or without a limit. Rural motorway keeps Alberta's
  observation (101).
- **Urban primary:** Alberta's own OpenStreetMapSpeeds observation (43 km/h) instead of the
  global urban value (27).

Neither number is fitted to anything: one is the posted limit and the other is the upstream
Alberta row the hybrid had overwritten. Ontario's hybrid, British Columbia and every other row
are unchanged (the test fixture asserts it). Profile SHA-256: `aa86c824…` for `AB`, `8f8e60ea…`
for `AB ON`.

### Check against the City of Calgary Travel Times feed

The City's quiet-hour values (dataset `aeb8-fh2w`, whole minutes, collected with INRIX) were used
**only as a check**, never to choose a number. Three snapshots recorded between 23:03 and 23:43
Calgary time on 2026-11-26 were reduced to the minimum per row. Each row was placed by finding
where the named road passes the two named cross roads in OpenStreetMap, per carriageway, and
routing between them; a row is kept only if at least 90% of the route is on the named road. 46 of
68 rows were placed. Left out and counted: 7 rows naming a route or a place instead of two cross
roads ("via", "City Centre", "N of", "Balzac"), 11 whose cross road does not meet the road in
OpenStreetMap within 40 m, 2 whose route leaves the named road, and 2 outside the build
(Trans-Canada Highway west of Highway 22). Times are `trace_attributes` over one fixed shape per
row. Both commits give the same times on every row: no placed row uses a secondary road.

| Rows (NavOSS against City)             | Before                        | After                     |
| -------------------------------------- | ----------------------------- | ------------------------- |
| Freeway, 39 rows: median error         | 13.1%                         | 5.2%                      |
| Freeway: signed median, worst          | +9.4%, +35.1%                 | −1.8%, −25.0%             |
| Freeway rows of 8 min or more (25)     | 13.5% median, +35.1% worst    | 5.2% median, +19.1% worst |
| Arterial, 7 rows: median error         | 8.3%                          | 10.1%                     |
| Arterial: signed median, worst         | +4.9%, +70.8% (Macleod Trail) | +10.1%, +17.1%            |
| NB Macleod Trail, Anderson Rd–7 Ave    | 23.9 min against 14           | 15.4 min against 14       |
| Deerfoot Trail, 15 rows: signed median | +11.0%                        | −7.9%                     |
| Stoney Trail, 20 rows: signed median   | +14.1%                        | +2.4%                     |

"Freeway" is a row with at least 90% motorway. The seven arterial rows are Macleod Trail and six
Crowchild Trail rows that mix motorway with the signalised trunk part. Limits of this check:

- A whole-minute value carries up to ±12% rounding on a 4-minute row and ±6% on an 8-minute row.
- One night only. Southbound Deerfoot rows imply 82–89 km/h where northbound rows imply 96–106;
  the build is now 16.7–20.9% faster than three southbound rows (17 Ave SE to Stoney Trail,
  8 Ave SE to Glenmore Trail, Airport Trail to Memorial Drive) and 17% faster than one
  northbound row (17 Ave SE to Airport Trail).
- Crowchild rows moved from −0.1% to +10.3% signed median: its motorway parts are now served at
  their posted 60–80 instead of 85, and its signalised trunk part stays at 50 under limits of
  60–70. No trunk value was fitted.
- The City has not yet confirmed in writing that these INRIX-derived values may be used. Nothing
  in the profile depends on them.

**The one downtown row.** "NB Macleod Tr: N of 25 Ave S to City Centre" is 3 minutes. It names
no end, so it was not placed among the 46. The northbound carriageway from 25 Avenue is 1.56 km
to 9 Avenue, 1.77 km to 7 Avenue (where the Anderson Road row ends) and 2.09 km to its end at
4 Avenue, all `primary` posted at 50. Three minutes over those lengths is 31–42 km/h, and 27–50
with the rounding of a whole minute. So a downtown one-way at a quiet hour runs at roughly
30–40 km/h. The build serves this stretch at 27 before (3.98 minutes to 7 Avenue) and at 43
after (2.52 minutes), which is at the fast end of that range or past it. The secondary value of
32 (below) sits at its slow end. A check only; nothing was changed for it.

### Benchmark and spot routes

Fifty-route benchmark through the API (`test:routes:calgary-50`), each row against the local
"before" build:

| Fifty-route benchmark           | Commit 1                                  | Both commits                               |
| ------------------------------- | ----------------------------------------- | ------------------------------------------ |
| Passing                         | 50/50                                     | 50/50                                      |
| Median duration change          | −3.1% (short 0.0, medium −0.9, long −6.2) | −6.3% (short −5.2, medium −6.0, long −6.7) |
| Median distance change          | 0.0%                                      | 0.0%                                       |
| Unchanged primary-road sequence | 40/50                                     | 38/50                                      |

| Spot route from the August evaluation   | Before | Commit 1 |  Both | August reference |
| --------------------------------------- | -----: | -------: | ----: | ---------------: |
| Downtown (Central Library to Sunalta)   |   9.77 |     9.77 |  8.02 |               10 |
| Downtown to airport                     |  20.38 |    18.57 | 18.34 |               21 |
| Campus (Mount Royal to University)      |  16.66 |    17.33 | 16.88 |               13 |
| Industrial (Foothills to Airport)       |  28.80 |    25.82 | 26.91 |               20 |
| Long cross-city (Mahogany to Sage Hill) |  47.92 |    45.44 | 45.14 |               40 |

Minutes. The August references were same-time Google spot checks in daytime traffic; they are a
guard against overstating signalised streets, not a target. The airport route is now 12% under
its reference because Deerfoot Trail is served at its limit. Known costs of the first commit:
Bridgeland to Stampede rose from 7.41 to 8.43 minutes (Valhalla now prefers 1 Street SE, a
50 km/h downtown primary served at 43, and returns no alternative), and the 4% of primary
kilometres posted at 50 km/h or less are now too fast.

**The industrial route gets slower with the second commit, and the profile is not why.** Valhalla
minimises its own cost, not time, and the API ranks only the routes Valhalla returns. On both
builds Valhalla's lowest-cost route is Deerfoot–Glenmore (26.19 km), and a 20.40 km route over
Barlow Trail takes 25.82 minutes at a slightly higher cost. That route has no secondary road, so
its time and cost (2035) are identical on both builds. After the first commit Valhalla returns
it as an alternative (best cost 2023) and the API ranks it first. After the second the best
cost falls to 1990 and Valhalla returns other alternatives instead, so the API can only offer
the 26.19 km route at 26.91 minutes: 1.1 minutes and 5.8 km worse than a route that still
exists. This is a limit of ranking over Valhalla's alternatives, not a defect of the profile or of the
comparator: neither Valhalla's cost nor the ranking code changed.

### Urban secondary: a judgement, in its own commit

Bow Trail, Sarcee Trail, Blackfoot Trail and most of Calgary's `secondary` kilometres are posted
at 60–80 km/h (70% of them at 60 or more); the downtown grid is `secondary` at 50 with a signal
every block. No source here measures the two apart: the City feed has no secondary road, and
Google is not a calibration target. The second commit sets Alberta's urban secondary to the
midpoint of the two upstream observations, the global urban value (25) and Alberta's own (39):
**32 km/h**. It is not fitted to City values and it is not a measurement. It can be held or
reverted without the first commit. Profile SHA-256 with it: `4d493000…` for `AB`, `27bdcff0…`
for `AB ON`.

**Downtown holdout.** Twelve routes chosen for this check and not in the benchmark: eight wholly
inside the downtown and Beltline grid and four that cross it. Minutes of the route the API
recommends (`/v2/routes`, `alternatives: 2`):

| Route                                          | Before | Commit 1 |  Both | Recommended roads                       |
| ---------------------------------------------- | -----: | -------: | ----: | --------------------------------------- |
| 8 St & 5 Ave SW to 1 St & 12 Ave SE            |   5.62 |     5.06 |  4.29 | 9 Ave, then 5 Ave–1 St SE from commit 1 |
| Eau Claire to 8 St & 17 Ave SW                 |   6.58 |     6.58 |  5.74 | 5 St SW–17 Ave                          |
| City Hall to 14 St & 12 Ave SW                 |   9.07 |     8.43 |  7.02 | 1 St SE–11 Ave                          |
| 11 St & 6 Ave SW to East Village               |   8.41 |     8.41 |  6.99 | 9 Ave                                   |
| 4 St & 17 Ave SW to 4 St & 4 Ave SW            |   3.45 |     3.45 |  2.75 | 4 St SW                                 |
| 1 St & 10 Ave SW to 10 St & 4 Ave SW           |   5.35 |     5.35 |  4.57 | 1 St SW–6 Ave–4 Ave                     |
| Victoria Park to 8 St & 8 Ave SW               |   6.47 |     6.04 |  4.69 | Macleod–10 Ave, then 11 Ave with both   |
| 14 St & 17 Ave SW to 3 St & 6 Ave SE           |   8.88 |     8.00 |  6.61 | 17 Ave–Macleod                          |
| Kensington to Mission (crosses)                |   8.77 |     8.77 |  7.07 | 8 St–12 Ave–4 St SW                     |
| Bridgeland to Sunalta (crosses)                |  15.01 |    14.11 | 12.52 | 1 St SE–11 Ave                          |
| Crescent Heights to Macleod & 25 Ave (crosses) |  10.20 |     8.60 |  7.42 | Centre St–1 St SE                       |
| Inglewood to Bankview (crosses)                |  17.49 |    17.08 | 13.75 | 9 Ave–11 Ave–17 Ave                     |

Median change against before: −4.2% after the first commit, −20.8% after both (range −12.8 to
−27.5%); the median average speed over a route goes from 23.5 to 24.1 to 29.7 km/h. No route
moves onto residential, unclassified or service roads: their kilometres on each recommended
route are identical on all three builds, and the two road changes are between parallel one-way
avenues. What this shows: the second commit does not send drivers through the grid's side
streets, and it makes every downtown time about a fifth shorter. At a quiet hour that is inside
what the one City row implies (30–40 km/h on a downtown one-way). In daytime traffic it is
optimistic: Central Library to Sunalta is 8.02 minutes against the August daytime reference of
10, where the unmodified Alberta profile was rejected at 6.58.

**Other values.** Recommended route by the API's own ranking (whole minutes first, then
distance), all on the first commit's motorway and primary values:

| Urban secondary                       | 25 (commit 1)             | 30                    | 32 (both)             | 35                       |
| ------------------------------------- | ------------------------- | --------------------- | --------------------- | ------------------------ |
| Aspen Woods                           | loop, 21.7 km, 25.6       | Bow Trail, 11.9, 23.9 | Bow Trail, 11.9, 22.8 | Bow Trail, 11.9, 21.3    |
| Aspen Woods, the other of the two     | Bow Trail, 27.5           | loop, 24.5            | loop, 24.2            | loop, 23.7               |
| Sage Hill                             | Stoney–Deerfoot, 31.5     | Symons Valley, 23.7   | Symons Valley, 23.7   | Symons Valley, 23.7      |
| Tuscany                               | Crowchild–16 Avenue, 22.6 | 16 Avenue             | 16 Avenue             | Crowchild–Memorial, 21.5 |
| Benchmark: unchanged road sequences   | 40/50                     | 38/50                 | 38/50                 | 37/50                    |
| Benchmark: median duration            | −3.1%                     | −5.9%                 | −6.3%                 | −6.7%                    |
| Downtown (Central Library to Sunalta) | 9.77                      | 8.67                  | 8.02                  | 7.44                     |
| Downtown holdout, median change       | −4.2%                     | −16.1%                | −20.8%                | −26.7%                   |

The Aspen Woods result does not depend on the exact value: Bow Trail is recommended at 30, 32
and 35, by 0.6, 1.4 and 2.4 minutes. At 29 the two are 0.2 minutes apart. The other ten commutes
keep the same recommendation at 30, 32 and 35.

### Commutes

Route the API recommends to 4 Street and 4 Avenue SW (`/v2/routes`, `alternatives: 2`, first
route; the API orders by whole minutes, then distance, then seconds). Kilometres, then minutes:

| From                 | Before                                | Commit 1                          | Both commits                                      |
| -------------------- | ------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Aspen Woods (W)      | Stoney–Glenmore–Crowchild, 21.7, 25.2 | same, 25.6                        | **Bow Trail, 11.9, 22.8**                         |
| Signal Hill (SW)     | Glenmore–Crowchild–Bow, 14.2, 19.4    | same, 19.9                        | same roads, 13.9, 18.0                            |
| Discovery Ridge (SW) | Glenmore–Crowchild–Bow, 16.1, 21.6    | same, 22.1                        | same, 20.7                                        |
| Evergreen (S)        | Stoney–Glenmore–Crowchild, 24.7, 27.1 | same, 27.2                        | same, 25.7                                        |
| Tuscany (NW)         | Crowchild–16 Avenue, 22.6, 26.9       | same, 27.4                        | same, 26.1                                        |
| Dalhousie (NW)       | Crowchild–Memorial, 11.7, 20.2        | same, 19.9                        | same, 18.1                                        |
| Panorama Hills (N)   | Country Hills–Deerfoot, 21.2, 26.6    | same, 25.2                        | same, 23.5                                        |
| Sage Hill (N)        | Stoney–Deerfoot, 31.5, 33.5           | same, 31.2                        | **Symons Valley–Beddington–Deerfoot, 23.7, 30.7** |
| Saddle Ridge (NE)    | Stoney–16 Avenue, 21.1, 29.8          | **McKnight–Deerfoot, 18.9, 27.6** | same, 25.6                                        |
| Skyview Ranch (NE)   | Airport Trail–Deerfoot, 23.0, 27.9    | **Stoney–Deerfoot, 26.0, 25.8**   | same, 25.2                                        |
| Forest Lawn (E)      | 17 Avenue–Memorial, 8.2, 16.8         | same, 16.5                        | same, 14.9                                        |
| McKenzie Towne (SE)  | Deerfoot–Memorial, 24.2, 24.7         | same, 22.7                        | same, 22.0                                        |
| Mahogany (SE)        | Deerfoot–Memorial, 30.4, 34.8         | same, 32.5                        | same, 31.7                                        |

Two rows turn on the whole-minute rule. Sage Hill after both commits: Stoney–Deerfoot is 30.6
minutes and Symons Valley 30.7, both 31 whole minutes, so the route 7.8 km shorter is ranked
first. Skyview Ranch before: Stoney–Deerfoot was 27.8 minutes and Airport Trail 27.9, both 28.

**The first commit alone does not move the owner's commute.** Bow Trail is `secondary`, still
served at 25 km/h, and the freeway loop stays recommended from Aspen Woods. With the second
commit Bow Trail is recommended. From Signal Hill, Discovery Ridge and Evergreen the loop over
Crowchild Trail is recommended on every build.

### Limits

- A class table cannot tell a 70 km/h arterial from a signalised downtown street of the same
  class. Telling them apart needs a speed per edge from the posted limit and the signals on it
  (Valhalla can load per-edge speeds without a fork), or measured speeds. Neither is built.
- From Signal Hill, Discovery Ridge and Evergreen the loop over Crowchild Trail is the fastest
  free-flow route under every profile tried. Only traffic data changes that recommendation.
- The API can only rank what Valhalla returns (the industrial route above).
- Two of fifteen local builds ended with a segmentation fault in Valhalla's `enhance` stage, one
  with no other Valhalla container running; each identical rerun succeeded. Local builds ran on
  six cores, production's on four. Not reproduced on demand and not diagnosed.
- Only Alberta was built. The Canada graph, and Ontario's hybrid, which has the same two
  properties, were not examined.
- Offline bundles are built with the same script, so the next bundle build picks the profile up;
  the published bundles keep the old one until then.

## Wired CarPlay spot check

On 2026-08-02 UTC, a wired iPhone 15 Pro Max and Apple's standalone CarPlay Simulator compared the
same current-location trip to Calgary International Airport without retaining the origin. Google Maps
showed **34 min / 38 km** with slower-than-usual traffic, and Waze showed **32 min / 23 mi**. The
deployed NavOSS route from the corresponding public Aspen Glen street segment was **33.77 min /
38.40 km**. This is a single same-time spot check, not a replacement for the hash-bound corpus.

The installed TestFlight build 35 still contains the older broad idle-map/location behavior and did
not produce a trustworthy live-origin NavOSS preview. The current source fixes route-origin freshness,
idle recentering, and old-API fallback, but it still requires a new signed CarPlay build and another
wired/wireless physical check before end-to-end client parity is claimed.

Waze is not included in the automated result because Waze exposes no generally available OD route
data API. Deep Links launch the consumer app but return no geometry or ETA. Consumer UI/OCR/network
scraping is not an acceptable substitute. Add Waze only with written Transport SDK/benchmark access.

Official references:

- [Google Routes API](https://developers.google.com/maps/documentation/routes/overview)
- [Google Routes policies](https://developers.google.com/maps/documentation/routes/policies)
- [Waze Deep Links](https://developers.google.com/waze/deeplinks)
- [Waze Transport SDK](https://developers.google.com/waze/intro-transport)

The route request now accepts bounded origin heading and horizontal accuracy. Phone routing rejects
cached samples older than 15 seconds or less accurate than 100 m, includes heading only above 2 m/s,
and refreshes idle foreground location every 25 m. Native CarPlay planning and rerouting forward the
same correlation metadata. This reduces wrong-carriageway and wrong-ramp starts; it cannot replace
traffic data or authoritative entrance coordinates.

During backend rollout, phone and native clients retry once without the two optional correlation
fields only when an older strict API returns HTTP 400. Other failures are not retried. Updated APIs
therefore receive the metadata immediately without breaking routing against the previous production
schema.

## Fifty-route benchmark

The benchmark defines 25 reciprocal Calgary corridor families, expanded to exactly 50 directed
origin/destination cases. It covers short inner-city trips, one-way grids, river crossings, campuses,
hospitals, malls, industrial districts, airport access, Deerfoot Trail, Stoney Trail, and edge
communities.

Each result checks:

- production, non-degraded, explicitly traffic-unavailable source metadata;
- valid alternatives with unique geometry hashes;
- plausible speed, duration, and circuity;
- route/step/geometry consistency within 3%;
- endpoint road-access offsets;
- geometry continuity and instruction coverage; and
- latency below 5 seconds.

Artifacts retain aggregate metrics, road-name sequences, warnings, and SHA-256 geometry hashes only.
They do not retain route geometry or generated competitor links.

## Automated result

The table below is the earlier 2026-07-20 spot-check and is retained for historical comparison. The
50-route benchmark above is the current production gate.

| Corridor                         | Mode           | Distance |      ETA | API latency |
| -------------------------------- | -------------- | -------: | -------: | ----------: |
| Downtown to Airport              | Default        |  19.1 km | 22.5 min |       73 ms |
| Downtown to Airport              | Avoid highways |  16.4 km | 38.2 min |       70 ms |
| Downtown to University           | Default        |   8.4 km | 20.2 min |       48 ms |
| Downtown to Chinook              | Default        |   6.5 km | 17.1 min |       39 ms |
| Downtown to East Hills           | Default        |  18.9 km | 29.0 min |       45 ms |
| Downtown to East Hills           | Avoid highways |  12.2 km | 30.0 min |       49 ms |
| Downtown to Canada Olympic Park  | Default        |  14.5 km | 27.2 min |       54 ms |
| Downtown to South Health Campus  | Default        |  28.5 km | 29.9 min |       46 ms |
| Downtown to South Health Campus  | Avoid highways |  25.4 km | 53.2 min |       60 ms |
| Crowfoot to Saddletowne          | Default        |  33.4 km | 30.8 min |       38 ms |
| Crowfoot to Saddletowne          | Avoid highways |  23.8 km | 52.1 min |       42 ms |
| Foothills to South Health Campus | Default        |  31.3 km | 32.0 min |       47 ms |
| East Hills to Westhills          | Default        |  28.5 km | 32.5 min |       39 ms |
| East Hills to Westhills          | Avoid highways |  22.0 km | 54.0 min |       52 ms |
| McKenzie Towne to Airport        | Default        |  34.7 km | 29.2 min |       36 ms |
| Rockyview to University          | Default        |  12.3 km | 21.7 min |       40 ms |
| Stampede to Foothills            | Default        |   8.5 km | 19.9 min |       44 ms |

Historical summary: 17 passed, 0 failed, p95 API latency 73 ms.

The gate checked:

- plausible corridor-specific distance and duration ranges;
- one to three alternatives and a credible average speed;
- route and step distances agreeing within 3%;
- origin/destination road-access offsets within case-specific tolerances;
- no geometry gap over 2 km and at least 20 geometry points;
- spoken-instruction coverage of at least 75%;
- avoid-highways geometry changing where that variant is requested;
- latency below 5 seconds; and
- an explicit `traffic: unavailable` posture.

Observed geometry and step totals differed by at most 0.2%. Spoken-instruction coverage ranged from 88.9% to 94.7%. Canada Olympic Park had the largest accepted destination offset at 187.9 m because its point-of-interest centroid is well inside the site rather than on the access road.

## Manual comparison protocol

1. Capture all three products within two minutes, from the same coordinates, with driving mode selected.
2. Record local date/time and whether Apple or Google reports traffic disruption.
3. Record distance, ETA, primary roads, first maneuver, and any closure or restriction warning.
4. Compare the default route shape and road choices. Do not treat NavOSS ETA as live-traffic parity; NavOSS currently has no traffic feed.
5. Flag a route for investigation if it is illegal, inaccessible, uses a closed road, misses the requested destination, differs by more than 15% in distance, or differs by more than 25% in ETA without an obvious traffic explanation.
6. Have a passenger collect results. Do not interact with three navigation apps while driving.

Apple and Google agreement is a useful signal, not ground truth. Posted signs, restrictions, and direct road observation take precedence.

## Routing research and ranking policy

NavOSS requests up to two Valhalla alternates for a route preview, producing up to three route choices when reasonable alternatives exist. Valhalla may return fewer than requested, and its official documentation says alternates are not supported for time-dependent routes. NavOSS ranks the available free-flow routes by their whole-minute duration estimate, with distance breaking tied estimates. Consequently, a small change across a rounding boundary can change the recommended route.

This policy is comparable to the non-traffic baseline offered by larger routing products, but it cannot guarantee a faster real-world route than Google Maps or Apple Maps:

- Google Routes supports `TRAFFIC_AWARE_OPTIMAL`, departure time, traffic speed intervals, and traffic-aware route duration. Those requests use a paid preferred tier.
- Apple MapKit can request reasonable alternate routes. Apple documents `MKRoute.expectedTravelTime` as travel time under ideal conditions, while the consumer Apple Maps product may use additional proprietary signals.
- Valhalla supports historical and live traffic when suitable traffic data is imported. The current NavOSS graph has neither feed, so its API correctly reports `traffic: unavailable`.

The next route-speed milestone is not a larger highway preference: Valhalla's neutral `use_highways` default is already `0.5`. It is to acquire a licensed Calgary traffic source, import historical/live speeds and closures into Valhalla, then benchmark same-time route choices using the manual protocol above. Until then, route safety and legality take precedence over claiming competitor parity.

## Comparison worksheet

Fill the blank cells after opening the links on the same device and at the same time.

| Corridor                         | NavOSS             | Apple Maps                                                                                       | Apple result | Google Maps                                                                                                                      | Google result | Primary-road / first-maneuver notes | Verdict |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------- | ------- |
| Downtown to Airport              | 19.1 km / 19.6 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.13157,-114.01055&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.13157,-114.01055&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |
| Downtown to University           | 8.4 km / 15.1 min  | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.07795,-114.13073&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.07795,-114.13073&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |
| Downtown to Chinook              | 6.4 km / 12.6 min  | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=50.99865,-114.07367&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=50.99865,-114.07367&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |
| Downtown to East Hills           | 12.2 km / 21.0 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.04112,-113.9132&dirflg=d)      | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.04112,-113.9132&travelmode=driving)      | REQUIRED      | REQUIRED                            | Not run |
| Downtown to Canada Olympic Park  | 14.7 km / 20.6 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=51.0809235,-114.2164025&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=51.0809235,-114.2164025&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Downtown to South Health Campus  | 28.5 km / 27.6 min | [Open](https://maps.apple.com/?saddr=51.04427,-114.06309&daddr=50.8822452,-113.9526766&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04427,-114.06309&destination=50.8822452,-113.9526766&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Crowfoot to Saddletowne          | 33.4 km / 28.5 min | [Open](https://maps.apple.com/?saddr=51.1236422,-114.208115&daddr=51.12075,-113.94678&dirflg=d)  | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.1236422,-114.208115&destination=51.12075,-113.94678&travelmode=driving)  | REQUIRED      | REQUIRED                            | Not run |
| Foothills to South Health Campus | 31.2 km / 30.9 min | [Open](https://maps.apple.com/?saddr=51.06534,-114.13308&daddr=50.8822452,-113.9526766&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.06534,-114.13308&destination=50.8822452,-113.9526766&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| East Hills to Westhills          | 28.4 km / 29.3 min | [Open](https://maps.apple.com/?saddr=51.04112,-113.9132&daddr=51.0157721,-114.1693872&dirflg=d)  | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.04112,-113.9132&destination=51.0157721,-114.1693872&travelmode=driving)  | REQUIRED      | REQUIRED                            | Not run |
| McKenzie Towne to Airport        | 34.7 km / 29.1 min | [Open](https://maps.apple.com/?saddr=50.9164994,-113.9643527&daddr=51.13157,-114.01055&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=50.9164994,-113.9643527&destination=51.13157,-114.01055&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Rockyview to University          | 12.9 km / 19.0 min | [Open](https://maps.apple.com/?saddr=50.9908499,-114.0971138&daddr=51.07795,-114.13073&dirflg=d) | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=50.9908499,-114.0971138&destination=51.07795,-114.13073&travelmode=driving) | REQUIRED      | REQUIRED                            | Not run |
| Stampede to Foothills            | 9.3 km / 14.9 min  | [Open](https://maps.apple.com/?saddr=51.03746,-114.05193&daddr=51.06534,-114.13308&dirflg=d)     | REQUIRED     | [Open](https://www.google.com/maps/dir/?api=1&origin=51.03746,-114.05193&destination=51.06534,-114.13308&travelmode=driving)     | REQUIRED      | REQUIRED                            | Not run |

## Reproduce

Against the production API:

```sh
NAVOSS_API_URL=https://navoss-api.yassin.app \
	corepack pnpm --filter @navoss/api test:routes:live

NAVOSS_API_URL=https://navoss-api.yassin.app \
	ROUTE_QUALITY_OUTPUT=artifacts/route-quality-calgary-50.json \
	corepack pnpm --filter @navoss/api test:routes:calgary-50
```

The regional smoke cases live in `apps/api/scripts/route-quality-cases.json`. The fixed Calgary
benchmark is `apps/api/scripts/route-quality-calgary-50.json`; the shared gate is
`apps/api/scripts/route-quality.mjs`.

## Production API image, 2026-11-27

The API image from `941db62` (City travel times #196, official-closure routing #199, their
integration #200, and the dependency refresh #148) was deployed at 11:28 UTC with both new modes
`off`. No migration was pending. Rollback: `navoss-api:pre-routing-traffic`.

- `check-stack.sh` passed with the deployed settings in its environment.
- The public API passed the 50-route Calgary gate (p95 131 ms), the 80-route Canada matrix and the
  22-route Alberta/BC matrix; reports are in `artifacts/deploy-20261127-routing/`.
- `/v1/config` is strict v1, `/v2/config` lists 13 areas with `liveTraffic: false`, and the
  lane-bearing Deerfoot/Glenmore fixture returns exit 248 with lanes.
- A `/v2/routes` request in the shape build 87 sends returns 200. A request declaring
  `trafficSources: ["calgary-travel-times"]` now returns 200 instead of the earlier contract 400,
  with `source.traffic` `unavailable` and no route traffic; an unknown source id is ignored.

Both modes were then set to `shadow` from 11:32 to 11:34 UTC and set back to `off`: the change
had been made without the VM snapshot the operating rules require first, and the storage pool was
over its limit, so no snapshot could be taken. In those two minutes the closure counters showed 12
requests, none near a closure, no route that would change and no failure; the City summary (every
15 minutes) was not reached. Shadow evidence and a rush-hour check are still outstanding.

## Production speed-profile cutover, 2026-11-27

The speed correction from PR #195 was deployed at 08:21 UTC on a rebuilt Canada graph,
`valhalla-canada-261114-speeds-261127`, profile SHA-256
`27bdcff01efae5f6c0506cd08000bdff9a8f4a6645f2854d23e1cf5f6e1b4a10`.
The previous graph was retained; the deployment snapshot was removed after client-side checks.

- `check-stack.sh` passed when re-run at 11:34 UTC with the deployed `COMMUNITY_TRAFFIC_MODE` and
  `NAVOSS_OFFLINE_MANIFEST_DIR` in its environment. The run at cutover was made without them, so
  its traffic-status check could not pass, and its exit code was not read.
- The public API passed the 50-route Calgary gate and 80-route Canada matrix.
- Calgary p95 latency was 149 ms.
- For the public intersection anchor at 4 Street and 4 Avenue SW, Aspen Woods and West Springs
  probes recommended Bow Trail rather than the Stoney–Glenmore–Crowchild loop.
- Signal Hill and Discovery Ridge probes still preferred Crowchild under the free-flow model.

These checks show the revised model is served and changes route choice; they do not establish
same-time ETA accuracy or congestion avoidance. City travel-times enrichment and official
closure avoidance are separate changes, disabled until their respective rollout checks pass.
