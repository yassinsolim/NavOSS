# City of Calgary travel times on routes

Routes that use Calgary's main roads get the delay The City of Calgary currently reports on them,
labelled as the City's traffic, and are re-ranked. Everything else in a route stays the routing
engine's free-flow estimate. This is **traffic on Calgary's main roads, from the City**,
not live traffic: `features.liveTraffic` stays `false`.

- Source id `calgary-travel-times`; attribution "Traffic on main roads from The City of Calgary"
  (`CALGARY_TRAVEL_TIMES_SOURCE_ID`, `CALGARY_TRAVEL_TIMES_ATTRIBUTION` in `@navoss/contracts`).
- Feed, licence and the pending written confirmation: [data sources](../data-sources.md#city-of-calgary-travel-times).
- Code: `apps/api/src/calgary-travel-times/` (feed, corridor table, placement, delay model,
  service); wired into `/v2/routes` in `apps/api/src/app.ts`.

## Switch

`CALGARY_TRAVEL_TIMES_MODE` (compose and `infra/compose/.env.example`), default `off`.

| Mode     | Feed polled, corridors placed | `/v2/routes`                                                                                        |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `off`    | no                            | exactly as before the feature (tested)                                                              |
| `shadow` | yes                           | unchanged; routes near a corridor are evaluated in the background for the counters only (see below) |
| `live`   | yes                           | applied, only for requests that declare `trafficSources: ["calgary-travel-times"]`                  |

`live` stays off until the City has confirmed the licence in writing.

`shadow` must not slow the routes it observes. At most one evaluation runs per process; a request
arriving meanwhile is not evaluated (`shadowSkipped`), nothing queues. A running evaluation gives
way to any route request that begins after it: before each walk it checks, and abandons itself
(`shadowYielded`) if one is in progress. `shadow` never asks for an avoid candidate.

Never applied when the routing provider has its own traffic (`source.traffic: "live"`), and never
together with community traffic: when community traffic adjusted anything in a response, the City
source is not consulted for it. A failure anywhere leaves the response as it would be without the
feature; it never fails a route request.

## Contract

- Request: `trafficSources` (optional, up to 8 strings of 1 to 64 characters). It lists the extra
  route traffic sources a client can present. Unknown ids are ignored, so a later client naming a
  source this server does not know is not refused. The production API before this change refuses
  the field with its contract-rejection 400; a client must then retry once without it, as it does
  for origin metadata.
- Response: `source.trafficSource` is the community object or
  `{ id: "calgary-travel-times", attribution: "Traffic on main roads from The City of Calgary" }`,
  with `source.traffic: "live"`. Route `traffic` and `congestion` keep the community shape and
  rules: `traffic.observedFraction` is the share of the route's length on placed corridors,
  `traffic.snapshotAt` the newest `last_update` of the feed answer used and
  `traffic.oldestObservedAt` the oldest `last_update` of the corridors the route used.
- A client that did not declare the source gets a response identical to today's; shipped builds
  80 to 87 decode `source.trafficSource` strictly as the community object
  (`packages/contracts/test/frozen-route-v2-response.ts` keeps that schema).

## Feed

`GET https://data.calgary.ca/resource/aeb8-fh2w.json?$limit=200`, about 68 rows of
`{corridor, road_segment, travel_time_mins, last_update}`.

- Polled every 3 minutes, never more often than every 2 minutes, with `If-None-Match` and
  `If-Modified-Since` from the previous answer (Socrata sends both). The City updates it about
  every 20 minutes. The request carries no user data.
- Whole rows are fetched and validated one by one: extra fields are ignored, a malformed row is
  dropped and counted, and an answer with more than a tenth malformed rows, or none valid, is
  rejected and the previous one kept (the City changed another dataset's schema without notice
  on 2026-11-13).
- `last_update` is Calgary wall time without a zone. It is converted with the
  `America/Edmonton` formatter the road-event provider uses, trying both offsets. The repeated hour
  in November takes the earlier instant (the older reading); the skipped hour in March is invalid.
- **Stale limit: 50 minutes.** A row whose `last_update` is older is not applied. That tolerates one
  missed City publication (two 20-minute intervals plus polling and a margin) but not two, so a
  jam that has cleared is not shown for more than about half an hour. A value more than five minutes
  in the future is malformed.

## Corridors

The feed has no geometry. `corridors.json` places each `road_segment` label by hand-checked
anchors: a start, any vias and an end, each on the carriageway in the direction of travel, with
the expected road names (as Valhalla reports names and refs) and the expected length.

Anchors were found from OpenStreetMap (Overpass, carriageway geometry of the main road crossed with
the named cross road) and the City's own travel-times page
(`https://www.calgary.ca/roads/conditions/travel-times.html`), then routed on the local
Alberta/BC graph. The expected length is the length measured there after the checks below passed.

`corepack pnpm --filter @navoss/api travel-times:corridors` places every corridor with the code
the API runs and checks each one:

- length within 6% (or 250 m) of the table;
- at least 90% of the length on the expected roads;
- the free-flow speed the baseline implies between 30 and 130 km/h.

At runtime the corridors are placed on the serving graph when the API starts, and again when
Valhalla's `/status` `tileset_last_modified` changes (checked every minute) or a placement could
not reach Valhalla. Edge ids of one graph mean nothing on another, so a detected graph change
drops the current placement at once: no City traffic is applied until the corridors are placed on
the new graph (never, if that fails), a placement started for an older graph is not published,
and a route evaluation that began on the old graph is discarded. Between the change and its
detection (at most a minute) the old placement is still used. A corridor that fails a check is
off; the rest work. A label the feed adds
later is ignored and counted (`unknownSegments`).

**On the local Alberta/BC graph (Valhalla 3.8.2), 56 of the 68 labels are placed; 0 fail.** The 12
left out, with the reason recorded in the table:

| Label                                                    | Why it is left out                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SB Crowchild Tr: 33 Ave SW to Deerfoot Tr SE             | Crowchild ends at Glenmore; the road on to Deerfoot is not stated            |
| WB Glenmore Tr: Odgen Rd SE to Bow Trail SW              | Glenmore does not meet Bow Trail; the road after Glenmore is not stated      |
| NB Macleod Tr: N of 25 Ave S to City Centre              | "City Centre" is not a point                                                 |
| WB Trans Canada Hwy: Hwy 22 to Kananaskis Village        | the village is off Highway 40 with no defined end; most of it is not the TCH |
| NB Macleod Tr: Anderson Rd SE to Crowchild Tr SW         | Macleod does not meet Crowchild                                              |
| NB Macleod Tr: Anderson Rd SE to Blackfoot Tr SW         | end not identifiable (23 min, more than the 14 min to downtown)              |
| WB 16 Ave: Stoney Tr NE to Valley Ridge Bv Via Stoney Tr | no defined start carriageway or path round the ring road                     |
| SB Deerfoot Tr: Balzac to Stoney Tr SE via Stoney Tr     | path and rejoining point ambiguous; the trial placement implied 124 km/h     |
| SB Deerfoot Tr: 8 Ave SE to Glenmore Tr SE               | 8 Ave SE does not meet Deerfoot (nearest 1.7 km away)                        |
| SB Deerfoot Tr: 8 Ave SE to Stoney Tr SE                 | as above                                                                     |
| NB Deerfoot Tr: 274 Ave S to City Centre via Deerfoot Tr | "City Centre" is not a point; 274 Ave is outside the city                    |
| NB Macleod Tr: 274 Ave S to City Centre via Macleod Tr   | as above                                                                     |

Placement details worth knowing: every anchor is a `break` location snapped to a non-ramp edge of
at least primary class within 45° of its heading, and each leg is walked on its own, because
Valhalla 3.8.2's `edge_walk` fails on a geometry that passes a `through` location; a leg that
ends part-way along an edge is walked again without its last vertex. Edge ids are kept in memory
only, never in the repository.

### Check on the serving Canada graph

On 2026-11-27 the same placement code was run read-only against the production Canada graph,
Valhalla 3.8.2, tileset `1795767579`, with the corrected speed profile. All 56 corridors passed
the length, road-name and plausible-speed checks; none were rejected. The 12 deliberately
omitted labels remain omitted.

Synthetic northbound Crowchild readings, held only on the development Mac, changed the route
recommendation for representative Aspen Woods, Signal Hill and Woodbine trips. The resulting
City source objects and v2 response envelopes validated. This proves the graph mapping and
delay application, not the quality of real traffic predictions.

The public-data recorder then held nine snapshots from 06:15 to 08:51 UTC: late evening and
overnight in Calgary, with no rush-hour observations. The three measured northbound Crowchild
corridors had no excess over their baselines. Live mode remains disabled pending the City's
written licence confirmation and a check against actual rush-hour data.

## Baselines

The feed has no free-flow value. Each corridor's `baselineMinutes` is the lower median of its
distinct readings between 22:00 and 05:00 Calgary time, at least two per corridor, from the
recorder on the production VM, which appends every change of the feed since 2026-11-27 06:15 UTC.
The method, the recorded period and the number of snapshots are in the table's `baselines` block.
Refresh them as recordings accumulate:

```sh
ssh navoss-prod 'cat ~/calgary-travel-times/*.jsonl' > /tmp/travel-times.jsonl
corepack pnpm --filter @navoss/api travel-times:baselines /tmp/travel-times.jsonl
corepack pnpm --filter @navoss/api travel-times:corridors   # speeds must stay plausible
```

At runtime a live value below the baseline is no delay. A corridor without a baseline is placed
but never applied.

## Delay model

Corridors nest (same start, different ends) and overlap, and the values are whole minutes.

1. **Bounds per corridor.** Live and baseline are each rounded to the minute, so a reading says
   only that the real excess lies within one minute either side of `live − baseline`, never below
   zero: between `max(0, live − baseline − 1)` and `max(0, live − baseline + 1)` minutes. A
   corridor whose real time equals its baseline can read one minute above it, so rounding alone
   never produces a delay.
2. **Sections.** The placed corridors cut the directed road edges into sections: stretches
   covered by the same set of corridors. Opposite carriageways are different directed edges, so
   they never share a section or a delay.
3. **Fit within the bounds, solved exactly.** With `x` the delay per section, every corridor
   requires `lower ≤ sum of its sections' x ≤ upper` and `x ≥ 0`. Per road direction (corridors
   that share no section are solved apart; tens of sections and rows) a dense two-phase simplex
   with Bland's rule solves a short sequence of linear programs; there is no iteration cap, only
   a pivot limit that would mean a bug (`fitSafetyStops`; that road direction then gets no delay).
   1. _Feasibility._ If no `x` meets every row, the phase-one optimum certifies that the rows
      contradict each other even as intervals (`fitContradictory`). Then upper bounds stay hard
      and every lower bound is scaled by the largest common share `t ∈ [0, 1]` that all rows
      allow (one more program, `t` a variable), so no stretch ever gets more delay than a row
      covering it supports.
   2. _Held sections_ (covered by a corridor whose reading allows zero): their total delay is
      minimised and fixed there.
   3. _Total delay_ is minimised and fixed there, so the model never reports more than the rows
      force.
   4. _Share by length:_ within those totals, lexicographic min-max of delay per metre: the
      largest delay per metre is minimised, the sections that cannot go below it are fixed at
      their jointly feasible solution values, and the rest repeat; first over the held sections,
      then over the others. Near ties never raise a section to an approximate rate ceiling.
      This allocation does not depend on the order of rows or sections.

   Four readings that earlier fits got wrong are regression tests. NB Stoney, baselines 6/9/14
   and live 8/9/17 (Peigan → McKnight, McKnight → Deerfoot, the whole): McKnight → Deerfoot gets
   0 and the whole 120 s (an exact-target fit put about 20 s on it). SB Deerfoot, Airport →
   Memorial 8 → 9, 64 Ave → Memorial 5 → 7, Airport → Anderson 17 → 23: Airport → 64 Ave gets 0.
   NB Stoney 6 → 7, 9 → 11, 14 → 19: 60 s on Peigan → McKnight and 180 s on McKnight →
   Deerfoot (the iterative fit gave about 96/144 s). Nearly tied section rates retain the required
   whole-corridor delay instead of making the fixed total infeasible. The simplex is checked
   against vertex enumeration on 400 small random programs, and a seeded test over the 56 placed corridors
   (their overlap on the local graph, edges renumbered; 100 independent random rush-hour
   readings, mostly contradictory, and 100 generated from a random true delay per section,
   always consistent) checks that contradiction is reported exactly when a separate feasibility
   program says so, that every bound holds when feasible and every upper bound always, that the
   held and total delays equal their linear-program minima, that no section is negative, that
   all-baseline readings give zero, and that shuffling rows and sections changes nothing. A model
   for all 56 corridors is built in about 8 ms (p50; 20 ms at worst) on the development Mac.

4. **Route.** Every metre a route drives on a section adds that section's delay per metre, added
   to the engine's own time for that part of the route. A route along a whole corridor with a real
   excess therefore gets about live − baseline (at least its lower bound, one rounding minute
   less); a route on part of it gets a share proportional to its length there.
5. **Absolute City minutes, not a ratio.** The delay is the City's own excess, independent of the
   engine's free-flow speed. A ratio to the engine's time would carry the engine's error into
   the delay: measured on production overnight (free flow), NB Macleod Anderson Rd → 7 Av SE is
   14 min from the City and 25.1 min (10.6 km) from NavOSS, NB Crowchild 50 Ave SW → Memorial
   4 against 7.3, NB Deerfoot 17 Ave → Stoney NE 11 against 13.3. A real +6 minutes on Macleod
   would have become about +11. The graph's arterial speeds are being corrected separately; this
   model does not change with them.

Congestion per geometry segment comes from live against baseline on the same section
(`free`/`slow`/`heavy`/`stopped` at the community thresholds of 70%, 45% and 20% of free-flow
speed); roads off the corridors are `unknown`.

Bounds kept from [community traffic](community-traffic.md#route-traffic): the delay cap (at most
100% of the route's typical duration) and the ranking bound (a route overtakes one ranked above
it only if faster with traffic and with at most 100 m more minor-road distance). There is **no
minimum coverage**: a route with 5 km of a jammed corridor in 25 km gets its delay.

A route that drives at least 100 m of placed corridors with a fresh reading is annotated, delay or
not: corridors with no delay give `delaySeconds: 0` and `free` congestion there, which says the City
reports them clear. A route that only crosses or touches a corridor end is left untouched. When
no route in a response is annotated, the response is untouched.

## Avoid candidate

Valhalla computes alternates on free flow, so all of them may share the jammed corridor. When
the recommended route (after the City delay is applied and ranked) carries at least **3 minutes**
of City delay, the server asks the routing provider once more for the same trip with
`exclude_locations`: points every 400 m (at most 40) along the delayed stretches of that route,
each with its heading and a 30° tolerance, so only that direction of travel is excluded. Each point
is the middle of its edge, at least 10 m from both edge ends (shorter edges are skipped), and is
sent with `node_snap_tolerance: 0`: with Valhalla's default of 5 m, a point near a fork snaps to
the node and excludes every edge within the heading tolerance there, including a clear exit the
avoiding route needs. Three
minutes is clearly beyond what whole-minute values and their rounding can produce, and below it a
detour rarely wins once its own distance is counted.

The candidate is annotated the same way and offered when it differs from every route already
offered and is faster with traffic than the recommended route; it is then ranked with the same
bound, within the routes the client asked for (`alternatives + 1`) and the contract's three.
Candidate computation, including official-closure checks and the walk that validates its traffic,
shares one 2.5 s deadline; any failure or timeout is ignored. At most one candidate is in flight
per process: a declared request that would ask while another is outstanding gets its
City-annotated routes without one (`avoidSkipped`), so a burst of reroutes cannot stack extra
routes on Valhalla. The slot is freed only when the underlying work settles, not at the deadline,
since a walk can outlive the response under its own per-chunk timeout.

The City callback uses `closureRouting.getCandidateRoutes`, not the raw routing provider.
With official-closure routing `on`, an unsafe or unverifiable candidate is omitted rather than
using the normal provider's fail-open route. Official barriers are never discarded to make room
for traffic exclusions: exceeding the combined 50-location limit declines the candidate and
retains the existing City-annotated alternatives. In `shadow` no candidate is requested.

`exclude_locations` was chosen over `exclude_polygons` because a polygon excludes both directions
of a road and every road crossing it; a point with a heading names one directed edge.

### Before and after on the local graph

Synthetic jam: the three NB Crowchild corridors (`Glenmore Tr SW to 24 Ave NW`,
`50 Ave SW to 24 Ave NW`, `50 Ave SW to Memorial Dr NW`) at baseline + 10 minutes, every other
corridor at its baseline. The fit puts 9 minutes on 50 Ave SW → Memorial Dr. Destination 4 St &
4 Ave SW; `alternatives: 2`; before = no declaration (today's answer), after = declared. Times are
the engine's on the local graph.

Re-run after the exact fit (the fit is unchanged for this jam: 9 minutes on each NB Crowchild
row's shared stretch, nothing elsewhere; small differences in engine minutes from the first run
are the origin and destination points, recreated for this run).

| Origin            | Before (order, min)                                         | After (order, min, City delay)                                                         |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| SW Evergreen      | Tsuut'ina–Crowchild 27.3; Stoney–16 Ave 39.3; Deerfoot 39.7 | unchanged order; Crowchild 34.4 (+7.1); 39.3; Deerfoot 39.7 (+0); candidate not faster |
| SW Woodbine       | Tsuut'ina–Crowchild 26.8; 38.8; Deerfoot 39.0               | **candidate** 33.1 (+0); Crowchild 33.9 (+7.1); 38.8                                   |
| SW Lakeview       | Crowchild–Bow Tr 17.2; 22.7; Deerfoot 24.3                  | Crowchild 24.3 (+7.1); Deerfoot 24.3 (+0); 25.4 (+2.6)                                 |
| SW Signal Hill    | Crowchild–Glenmore 18.1; Glenmore–Elbow 23.7; Deerfoot 24.4 | **Glenmore–Elbow 23.7 first**; Deerfoot 24.4 (+0); Crowchild 25.2 (+7.1)               |
| W Springbank Hill | Crowchild–Glenmore 21.9; 17 Ave 25.7; 28.2                  | **17 Ave 25.7 first**; 28.2 (+0); Crowchild 29.0 (+7.1)                                |
| W Aspen Woods     | 17 Ave–Crowchild 25.2; Bow Tr 27.6; 27.9                    | **Bow Tr 27.6 first**; 27.9; Crowchild 32.3 (+7.1)                                     |
| NW Tuscany        | Crowchild NW 27.8; 34.4; 34.8                               | unchanged order (Crowchild southbound is clear); third route 41.9 (+7.1)               |

Three avoid requests were made; one candidate was offered (Woodbine). Five of the seven
responses changed order.

### Added latency on the local graph

`/v2/routes` response times, in milliseconds, over the seven commutes above with the synthetic
jam: six rounds of the seven after one warm-up round, sent by 1 or 4 concurrent clients,
in-process API against the local Valhalla 3.8.2 on the development Mac. "No feature" and `shadow`
were each measured twice, interleaved, to show the noise between runs.

| Concurrency | Configuration                       | p50     | p95     | Counters                                    |
| ----------- | ----------------------------------- | ------- | ------- | ------------------------------------------- |
| 1           | no feature                          | 92/69   | 157/100 |                                             |
| 1           | `shadow`                            | 80/71   | 108/96  | 48 abandoned for a newer request            |
| 1           | `live`, declared (avoid candidates) | 99      | 170     | 21 candidates asked                         |
| 4           | no feature                          | 173/151 | 206/209 |                                             |
| 4           | `shadow`                            | 158/200 | 196/266 | 29-31 skipped, 17-19 abandoned              |
| 4           | `live`, declared (avoid candidates) | 220     | 354     | 11 candidates asked, 10 skipped (slot busy) |

Measured after the exact fit, with the Mac busier than in the first run (no feature is slower
too), so compare within the table. `shadow` stays within the noise of no feature at both
concurrencies; in `live` a declared request with a jam pays for its walks and candidate (about
+10-30 ms at p50 and +15-150 ms at p95 here). The candidate is bounded by its 2.5 s deadline and
one at a time. Building the delay model is not on the request path; it takes about 8 ms per feed
change.

## Limits

- Only the roads the City measures: Deerfoot, Stoney, Crowchild, Glenmore, Macleod, 16 Avenue
  and the Trans-Canada to Banff, on the 56 placed corridors. Every other road is assumed clear; a
  jam there is invisible.
- 20-minute data, whole minutes, corridor averages: a short severe jam inside a long corridor is
  spread over the stretch the corridors can localise, and anything under the one-minute rounding
  allowance is not shown.
- Baselines come from one night of recordings at first; they are refreshed by the script above.
- Nothing has been checked against a real rush hour yet.

## Operations

In `shadow` and `live` the API logs a `Calgary travel-times summary` line every 15 minutes with
counters only: routes evaluated, routes with delay, responses whose order changed (or would
change, in `shadow`), corridors placed and off by reason, corridors left out in the table,
unknown labels, feed age, fetch failures, malformed rows, rejected answers, shadow evaluations
skipped or abandoned for a route request, and avoid requests, inclusions, failures and skips. Feed failures are logged with the error
name only. Nothing about a route, a position or a driver is logged.
