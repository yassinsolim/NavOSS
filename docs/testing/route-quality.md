# Calgary route-quality report

Date: 2026-08-01

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

NavOSS requests up to two Valhalla alternates for a route preview, producing up to three route choices when reasonable alternatives exist. Valhalla may return fewer than requested, and its official documentation says alternates are not supported for time-dependent routes. NavOSS therefore ranks the available free-flow routes by exact duration first and exact distance second. Rounded minute labels never determine ordering.

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
