# Community traffic

Decision date: 2026-11-12 (revised twice the same day after two independent privacy and security
reviews, and again on 2026-11-14 after a third; the [enablement checklist](#enablement-checklist)
records what is still required)

NavOSS builds its own live traffic from the speeds of drivers who switch traffic sharing on. There
is no paid provider and, after review, no usable official flow feed for Alberta or British Columbia
(see [`../data-sources.md`](../data-sources.md#community-traffic)). This document describes the
server pipeline as built, the contract the app must follow, what the design does and does not
protect against, and what is deliberately left for later.

Status: the server is implemented and off by default (`COMMUNITY_TRAFFIC_MODE=off`). No released
app uploads anything yet. The v2 route hook now applies published community speeds and preserves the
service's returned route order; phone upload/switch and map-layer integration remain client work.
With few contributors very little will be published.

**This is not an anonymity system and makes no formal anonymity claim.** It is data minimisation
plus a contributor threshold. The section [What this does not protect against](#what-this-does-not-protect-against)
lists the limits, and [Enablement checklist](#enablement-checklist) what an operator must
establish before `collect` with real drivers and before `live`.

## Pipeline

```text
phone (sharing on, navigating, App Attest installation registered)
  ├─ POST /v2/traffic/credentials   one assertion -> opaque upload credential, valid 2 h
  └─ POST /v2/traffic/probes        one short batch: credential + positions + relative seconds
        │  network rate limit, credential check, per-installation rate limit,
        │  plausibility, trim 100 m off both ends (standing still there is kept as time only)
        ▼
   Valhalla trace_attributes   self-hosted, in-memory, local endpoint only; never sent a batch
                               that did not move
        │  matched edges: OSM way id, direction, class, use, edge speed, edge geometry
   Valhalla locate              the same local Valhalla; edge midpoints (map data) only
        │  access and dead-end flags for each candidate edge
   dead-end mask                graph-bound, topology-derived; required for live
        ▼
   one speed sample per whole, eligible road edge   the batch is dropped here; never written or logged
        ▼
   pending cohorts   API process memory only: per edge, contributor tag -> one speed
        │  every 5 minutes, on the boundary: an edge whose cohort holds >= 3 installations,
        │  all driven in the 15 minutes before it, is released as one coarse median, and that
        │  cohort is consumed
        ▼
   PostGIS traffic_releases   published values only, never served after 15 minutes
        ▼
   GET /v2/traffic/flow    the current epoch's completed snapshot as GeoJSON for a MapLibre layer
   GET /v2/traffic/status  mode and rules; no totals
   enrichRoutes()          delay, adjusted ETA and per-segment congestion for /v2/routes
```

Code lives in `apps/api/src/traffic/`; contracts in `packages/contracts/src/traffic.ts`. All four
routes are under `/v2`: nothing under `/v1` was added or changed, and no shipped client calls
them.

Traffic batches use the shared sourced Alberta/BC province polygons before trimming and matching,
the same eligibility predicate as search/routing and attested community reports. The optional
`COMMUNITY_TRAFFIC_BOUNDS` envelope may restrict that area but cannot authorize Saskatchewan, the
US, Yukon or the Northwest Territories. Recorded Liechtenstein replay tests inject an explicit
fixture-only area; there is no environment bypass of production province eligibility.

`/v2/routes` is connected to `TrafficService.enrichRoutes`: `route.congestion` aligns one-to-one
with route geometry segments, `route.traffic.observedFraction` states the released-data share,
and `source.trafficSource` identifies NavOSS community data. That source sets `source.traffic`
to `live`; a route without `traffic` in the same response is unavailable for that route.
Off/collecting modes return the original route fields and order without a community source.

## Contributors: attested installations, unlinkable in storage

Publication needs to count distinct contributors. Counting source networks is not that: one phone
has several networks (Wi-Fi, cellular, VPN), three cloud addresses can fake a road, and carrier
NAT merges strangers. Contributors are therefore the **App Attest installations** that community
reports introduced (`docs/architecture/community-reports.md`), used in a way that leaves nothing
in storage tying an upload to an installation.

1. The app registers an installation once (`POST /v2/community/installations`), as for reports.
2. Before uploading, the app asks for a challenge (`POST /v2/community/challenges`) and sends one
   assertion over the operation `traffic-credential` to `POST /v2/traffic/credentials`. The
   assertion client data is `navoss-community-v1\ntraffic-credential\n<challenge>`
   (`communityAssertionClientData`).
3. The server verifies the assertion against the installation row exactly as for a report (key,
   counter, one-use challenge, and attested trust unless `COMMUNITY_ATTESTATION_MODE` is
   `allow-development`). An installation registered less than **24 hours** earlier gets `403`
   with `retry-after` instead of a credential. Otherwise the server computes a **contributor
   seed**, `HMAC-SHA256(process key, installation id)` truncated to 16 bytes, seals the seed, an
   expiry and the end of the installation's seven-day **newcomer period** with AES-256-GCM under
   a second process key, and returns the result as the `credential`. The installation id is not
   kept anywhere after that call.
4. Every batch carries the credential. The server opens it, and for each road edge the batch
   yields it derives a **contributor tag**, `HMAC-SHA256(seed, segment key)`. A cohort holds at
   most one sample per tag.

Properties, each covered by a test:

- **One installation, one weight.** The seed depends only on the installation, so the same
  installation has the same tag on a given edge whatever network it uses and however many
  credentials it requests. One installation is not one handset: one iPhone can hold several App
  Attest keys, and after the admission controls below each counts separately.
- **Unattested uploads are refused.** A batch without a valid credential gets `401`; a
  credential needs a verified assertion from a registered installation; with
  `COMMUNITY_ATTESTATION_MODE=enforce` (the default) development keys are refused even if they
  were registered earlier. `status.probes.accepting` is `true` only when a contributor can
  actually be admitted: the mode is not `off`, a matcher is configured, and the report service
  has an App Attest verifier (`APP_ATTEST_TEAM_ID` and `COMMUNITY_INSTALLATION_SECRET` set).
  Otherwise the API issues no credentials (`503`) and `accepting` is `false`.
- **Fresh keys cannot vote, and new keys cannot stack on one network.** No credential for 24
  hours after registration, and during the seven days after it, each cohort counts at most one
  newcomer per network bucket (IPv4 /24, IPv6 /48). See
  [Admission controls](#admission-controls-against-one-handset-with-many-keys).
- **Nothing stored links a batch to an installation.** Seeds, tags and credentials are never
  written to the database or the log. The installation tables have no traffic column, and
  `traffic_releases` has no contributor column. Both keys exist only in process memory, so a
  restart invalidates every credential and makes the old seeds unrepeatable.
- **Tags do not join roads or consumed cohorts.** The per-edge tag is re-keyed, before anything is
  kept, under a random salt of that edge's cohort, so nothing held is equal across edges. The salt
  is replaced when the edge's cohort is consumed by a release, never on a clock, so an
  installation's tag is stable for the whole (up to 15-minute) life of a cohort and the one-weight
  rule holds throughout; a later cohort of the same edge sees a different tag. An earlier salt is
  kept, and checked, while a pending sample or partial coverage still uses it, so a cohort that
  straddles a release cannot count the same installation twice. While an edge is never released,
  its salt (and so the installation's tag on it) stays the same until its pending state empties or
  the API restarts. This only prevents joining by equality: anyone holding process memory holds
  the salts too.

What it is not:

- **Not an anonymous credential.** While a credential is valid (two hours), the API process, and
  anything that terminates TLS in front of it, can see that two batches carry the same
  credential. Nothing records it. Blind-signed tokens would hide that from the server too, but
  one-device-one-weight then needs per-segment tokens the phone cannot request without telling
  the server which roads it will drive; the simpler construction was chosen and its limit stated.
- **Not unlinkable to someone holding process memory.** With the process keys and the
  installation table, an installation's seed can be recomputed and matched against the pending
  cohorts.
- **Not Sybil-proof.** One physical iPhone can create many App Attest keys. App Attest proves a
  genuine device and app, not one key per device, and not that the phone was driving. The
  admission controls below make one handset with several keys slower and more awkward, not
  impossible: three keys kept for a week and uploading from three networks are three
  contributors. Apple's fraud-risk receipt metric, which would bound keys per device, is not
  used.
- **A bearer credential.** A credential is not bound to the phone that obtained it. Copied to
  another machine it can upload fabricated, plausible batches until it expires; deleting the
  installation does not revoke a credential already issued.
- **Credential requests are visible in the installation table.** Verifying the assertion
  advances the installation's counter and sets its `last_active_at`, as every attested write
  does. The database therefore shows when an installation last made an attested request, which
  for a traffic contributor is roughly when a trip (or a two-hour stretch of one) began.

### Admission controls against one handset with many keys

Both are cheap, need no new data, and only ever reduce what an installation can contribute:

- **Minimum installation age: 24 hours.** `POST /v2/traffic/credentials` verifies the assertion
  (consuming the challenge and advancing the counter) and then answers `403 forbidden` with
  `retry-after` set to the seconds remaining, until the installation is a day old. Keys made on
  the spot, or churned after being deleted, cannot vote immediately. The registration time
  already exists in `community_installations`; nothing new is stored.
- **Newcomer cap: one per network per cohort.** For seven days after registration the credential
  marks the installation as a newcomer. A newcomer's sample joins an edge's cohort only if no
  other newcomer from the same network bucket is already in it. One handset's new keys all
  upload from the network the handset is on, so they count once. The network is held only as a
  16-character marker on that pending sample, in memory, keyed under the edge's cohort salt like
  the tag, and dropped with it: markers of one network on two edges, or in two consumed cohorts
  of one edge, are not equal. The network-bucket space is small, so someone holding process
  memory (and so the salts) can still recover a newcomer's bucket by trying them all.

Why these and nothing heavier: the attacker they target holds one phone. They push the cost
from "three keys, now" to "three keys kept for a week" or "three networks at once". They do not
stop a patient attacker or two colluding people, and carrier NAT can cost real newcomers a vote
when several of them share a /24 in the same cohort. They are not a substitute for a device-level
signal (Apple's fraud metric) if `live` must resist more than that.

## What the app sends

`POST /v2/traffic/probes`

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-11-12T18:04:00Z",
  "credential": "pT3…opaque…",
  "points": [
    [-114.06312, 51.04471, 0],
    [-114.06281, 51.04492, 2]
  ]
}
```

- `points` are `[longitude, latitude, seconds since the first point]`: 10 to 240 points, the first
  at offset 0, offsets whole seconds rising by 1 to 15, at most 300 seconds in total.
- `capturedAt` is the UTC time of the first point rounded down to the minute. The server uses
  absolute time only to refuse stale or future batches and to expire samples sooner, and
  relative time only to compute speed. A batch whose `capturedAt` is more than 10 minutes old on
  arrival is refused, so send each batch promptly.
- `credential` is the string from `POST /v2/traffic/credentials`, unchanged.
- There is nothing else. The schema is strict, so a batch carrying an account, device,
  installation, trip, or batch-sequence field is rejected. Speed, heading and accuracy are not
  sent; the app filters poor fixes itself.
- Responses: `202 {"status":"accepted"}` whether or not anything was usable; `400` for a
  malformed or implausible batch; `401` when the credential is invalid or expired; `429` when
  rate limited; `503` when sharing is off, Valhalla is unavailable, or the matcher is busy. The
  app drops the batch in every case and never retries or stores it.
- `POST /v2/traffic/credentials` can also answer `403` with code `forbidden`, title
  `Installation too new` and a `retry-after` header (seconds): the installation is less than a
  day old.

### Client rules

The server advertises these in `GET /v2/traffic/status` (`probes.*`). The server cannot verify
rules 1, 2, 3 and 5; they are obligations on the app release, not properties of this server.

1. Upload only while turn-by-turn navigation is active and the user's traffic-sharing switch is
   on. The switch is off by default. Turning it off, ending navigation, or arriving stops
   collection and discards everything still in memory, including the credential.
2. Trim trip ends by `tripEndTrimMeters` (at least 400 m):
   - record nothing until the vehicle has travelled that far along its path from where navigation
     started, and is at least that far in a straight line from the route origin;
   - record nothing within that straight-line distance of the destination or any waypoint;
   - hold back the most recent stretch: only points at least that far of path behind the current
     position may be uploaded, so a trip that ends early never sends its last stretch.
3. Take one fix about every `sampleIntervalSeconds` (2 s), skip fixes with horizontal accuracy
   worse than 25 m, and round coordinates to five decimals.
4. Close a batch once it spans `batchTargetSeconds` (60 s) and `batchTargetMeters` (600 m) of path,
   or at `maxPoints` or `maxBatchSeconds`, whichever comes first. Each batch restarts its clock at
   zero. Batches never overlap and never share a point. Expect roughly one upload a minute in
   moving traffic and one every five minutes in a crawl. The server accepts at most 30 batches
   per installation in ten minutes.
5. Keep batches in memory only. Never write them to disk, never retry later, never attach an
   identifier beyond the credential.
6. Hold one credential in memory. Request it when navigation starts with sharing on, request a
   new one shortly before `expiresAt`, and after a `401` request one new credential and continue
   with the next batch (the failed batch is dropped). Do not request a credential per batch.
   After a `403` with `retry-after` from the credential endpoint, collect nothing for the rest of
   the trip and do not ask again before that many seconds have passed.
7. Stop uploading for the rest of the trip after a `429`, and for five minutes after a `503`.
8. Read `status.probes.accepting` before the first upload of a trip and do nothing when it is
   `false`.
9. Refresh the flow layer at `validUntil` of the last response, not sooner: it cannot change
   before then. A request made after `validUntil` waits for that boundary's snapshot to be
   complete; a `503` means the snapshot could not be published and the layer should keep its
   last response until it expires.

## What the server does with a batch

1. **Network rate limit.** 1,200 batches per ten minutes per network bucket (IPv4 /24, IPv6 /48,
   the same bucket community reports use), held as a salted in-memory fingerprint. It exists to
   stop a flood from one network, not to count contributors.
2. **Credential.** Open the credential; refuse with `401` if it is forged, expired, or from
   another process. Only a valid credential draws on the per-installation limit (30 per ten
   minutes) and the global limit (6,000 per ten minutes), so junk cannot exhaust what real
   drivers need.
3. **Plausibility.** The batch's last point (`capturedAt` plus the last offset) must be no more
   than 60 s ahead of the server clock, and its first point (`capturedAt`) no more than 10
   minutes behind it. Every point must be inside the Alberta and British Columbia box, and no
   two consecutive points may be more than 60 m/s apart.
4. **Server-side trim.** Drop every point within 100 m of path of either end of the batch. The
   server cannot tell which batch began or ended a trip, so it treats every batch as if it might
   have. A batch whose every point stays within 10 m of its first (it never moved, GPS jitter
   included) is not map matched at all. The standing still that the trim removes, the run of
   trimmed points within 10 m of the batch's first point and likewise of its last, or the whole of
   a batch that never moved, is kept as a **dwell**: its time and the mean of those points, used
   only to find the edge (see [Dwell across batch boundaries](#dwell-across-batch-boundaries)) and
   then dropped. A batch with fewer than five points left and no dwell is accepted and ignored.
5. **Map match** the remaining points with `trace_attributes` (`map_snap`) on the local Valhalla.
   A fix that Valhalla snapped from more than 35 m away, or for which it reports no snap
   distance, counts as unmatched. (Valhalla 3.8.2 reports `distance_from_trace_point` in metres
   for every matched point; checked against a real instance.) Then, for every edge of an
   aggregated road whose full length is at least 20 m, whole or partly matched, one `/locate`
   request to the same Valhalla asks what the graph knows at the midpoint of the matched part of
   the edge. That is a point on the road geometry Valhalla returned, never an uploaded fix; for a
   partly matched edge it can lie between a snapped position and a node. For a partly matched
   edge the answer also gives the whole edge's geometry, accepted only when it contains the
   matched part. See [Which roads](#which-roads).
6. **Derive pieces.** For each continuous run of matched fixes, movement between two fixes is
   spread over the edges between them by distance, at the average moving speed over the 150 m of
   path around it (so snapping noise on a short edge does not decide its speed), and time
   between two fixes that did not move is time spent standing on the edge where the vehicle
   stood. The result, per eligible edge, is a **piece**: the intervals of the edge driven (metres
   from the edge's start), the distance moved and the time spent. A run needs at least 5 s and
   either 100 m of travel or 30 s (so a crawl counts and two stationary fixes do not), and is
   dropped above 180 km/h. A piece records each step moved (from, to, moving time, and its batch
   offsets) and each stop (where, and its batch offsets). A batch boundary is not a trip end: the
   edges where a batch begins or ends contribute pieces like any other. Trip ends are protected by
   the client's 400 m trims, which the server cannot verify.
7. **Add to cohorts.** A contributor's pieces of an edge accumulate in memory, under that
   contributor's cohort tag, as the **union** of driven intervals, with distance and time each
   counted once (see [Coverage across batches](#coverage-across-batches)). Once the union covers
   300 m of the edge, or half of it when that is less, it becomes the contributor's one sample
   for the edge, at counted distance over counted time. The sample joins the edge's pending cohort,
   stamped with the publication epoch in which it was **completed** (server clock) and with the
   time its earliest piece's driving began (`capturedAt`, capped at the arrival time). Nothing in the batch decides
   which epoch it counts in; its start time can only make the sample expire sooner. A
   contributor already in the cohort is ignored, and so is a newcomer whose network already has
   a newcomer in the cohort.
8. **Discard.** The points, the match, the credential and the source address go out of scope.
   None of them is written to the database, a queue, a file, or the API log. Errors from
   Valhalla are counted, never logged, because they can quote request content.

### Which roads

An edge is credited, and can ever be published, only when all of these hold. Every rule is fixed
in code and cannot be configured.

1. **Road class and use.** `motorway`, `trunk`, `primary` or `secondary`, with use `road`,
   `ramp` or `turn_channel`. Tertiary, unclassified and residential roads, living streets,
   service roads, driveways, tracks, alleys, parking aisles and drive-throughs are excluded after
   matching, whatever the app sent. Tertiary roads are excluded because a sparse rural tertiary
   road can identify a household even at three contributors.
2. **Length.** At least **20 m**. Shorter edges are junction connectors and slivers between way
   splits (the recorded drive has some of 3 m). Publishing them would say which branch of a
   junction a cohort took. On the recorded 20 km Liechtenstein route this drops about 40% of
   aggregated edges by count and 10% by length.
3. **Open through road, as the graph says.** Valhalla 3.8.2 `trace_attributes` does not return
   `destination_only`, `not_thru`, `deadend` or access (verified against a real 3.8.2
   instance: requested, not returned), but verbose `/locate` does, from the same graph tiles.
   The edge is eligible only when `/locate` returns the driven direction of the same OSM way,
   that direction is open to cars, and no car-accessible edge of the way at that point, **in
   either direction**, is `destination_only` (Valhalla's reading of `access=private`,
   `destination`, `delivery` and similar), `deadend`, or `not_thru` (leads into a region with no
   other exit). Checking both directions keeps out the way **out of** a dead-end region as well
   as the way into it. Restrictions on other ways that meet the edge at a junction are ignored;
   the recorded answer has such a private dead-end side road. Anything `/locate` does not
   confirm is not eligible, and a `/locate` failure is a matcher outage (`503`).

Not enforced:

- **Long dead-end regions, without the mask.** Valhalla marks `not_thru` only within a bounded
  search. A dead-end valley with its own road network is not marked: the whole Malbun/Steg valley
  in Liechtenstein, a secondary road with one exit, comes back as through road (checked against a
  real instance). The topology-derived dead-end mask
  ([`infra/offline/dead-end-mask.md`](../../infra/offline/dead-end-mask.md)), built from the same
  extract and bound to the graph id, closes this: `live` refuses to start without a valid mask for
  `COMMUNITY_TRAFFIC_GRAPH_ID`, and an edge the mask does not place on the main network (excluded,
  or unknown, as BC 37A is because of extract clipping) is never published. `collect` may run
  without it, since it publishes nothing. The mask and its wiring are implemented; their
  independent review, and confirmation that the configured graph id is the graph the production
  Valhalla serves, are open checklist items.
- **Conditional access** (`access:conditional`, seasonal closures) is whatever Valhalla's build
  made of it.
- **Population density and household catchment.** Not checked.
- **The 400 m trip-end rule.** The server never learns where a trip starts or ends, and asking
  for that to verify the rule would collect more than the rule protects.
- Positions on excluded roads still reach the API and the local Valhalla before their
  observations are discarded; they are not stored.

## Segment key

The published unit is one **whole directed graph edge**: the stretch of an OpenStreetMap way
between two junctions, in one direction. Its key is `w<way id><f|b>-<digest>`, for example
`w142596972b-3833ec5bfe5b`: the way, the direction of travel relative to the way's node order, and
the first 12 hex digits of SHA-256 over the edge's own geometry at six decimals.

- **The threshold applies to exactly what is drawn.** An earlier design keyed on the whole way
  and drew the union of whatever edges individual batches covered, so a stretch one person drove
  appeared under a threshold other people had met elsewhere on the way. Now an edge is released
  only when three installations each drove at least 300 m of that edge (or half of it), and the
  line drawn is the whole edge, which runs node to node: a vehicle on an edge drives all of it
  unless its trip starts or ends there.
- **Geometry cannot be influenced by a batch.** The key commits to the geometry, which is map
  data. Every contributor who drives an edge derives the same key and the same line; a cohort
  keeps the line it was created with. There is no geometry update, before or after
  de-duplication.
- **The same key comes out of route walking.** `edge_walk` over a route returns the same edge
  shapes, so route traffic looks up the same keys (verified against recorded Valhalla responses).
- **No graph-internal id.** Valhalla's edge id would be shorter but means nothing outside one
  graph build.

A partly matched edge gets its key from the whole-edge geometry `/locate` returns, accepted only
when it contains the matched part (its node end is that edge's end, its interior vertices are
that edge's vertices, the lengths agree). On the Alberta/BC graph that geometry is identical to
the line `trace_attributes` returns when the edge is matched whole (99 of 99 edges compared), so
both give the same key. A way
edited in OpenStreetMap, or re-split by a new graph build, gets new keys; because the API erases
all releases on every start and the graph is only replaced with a restart of the stack, old keys
do not outlive a graph. A graph swapped without restarting the API would leave releases keyed to
the old graph for up to 15 minutes; the deployment procedure restarts the API.

The free-flow reference is the Valhalla speed of that edge (from `maxspeed` and the
OpenStreetMapSpeeds defaults NavOSS builds with).

## Aggregation and publication

### Coverage across batches

Batches are about a minute long, and in a jam a minute is 100–300 m. On the Alberta/BC graph most
through-road length is in edges longer than that: 70% of Calgary motorway length and 86–98% of
rural Alberta highway length is in edges over 400 m. Requiring one batch to drive an edge end to
end meant jams on long edges could never be published: three contributors at 12–24 km/h on
Deerfoot Trail published 0 of 17.7 km. Each contributor's pieces of an edge are therefore joined
across that contributor's batches.

- **Union of intervals, not summed lengths.** Coverage is the length of the union of driven
  intervals along the edge, so a replayed or overlapping batch adds nothing (tested: replaying
  every batch twice plus a half-overlapping copy credits exactly the same samples as driving
  once).
- **Evidence counts once, distance and time alike.** A step adds distance, and its moving time,
  only for the part of the edge no earlier piece of that contributor drove; the first report of a
  metre wins. Standing still is counted per place (stops within 25 m are one place; an honest
  contributor's stops in different batches are at least the two 100 m trims apart) and per
  claimed time: each stop is placed in time with its batch's `capturedAt` and offsets, a stop
  wholly inside time already counted at that place adds nothing, and an overlap of a minute or
  more adds only the time outside it. An overlap shorter than a minute is what two honest
  consecutive batches of one long stop can show, because `capturedAt` is rounded down to the
  minute, so such a stop counts in full. Before this, every upload's distance and time were
  summed: on a 1.5 km edge, 100 m in 50 s then 200 m in 10 s is 18 km/h (published 20), and
  replaying the slow piece nine times made it 8.6 km/h, so three such installations moved the
  release to 10 (regression-tested through the released median and the credit count).
- **Where time idempotence stops.** Distance is exactly idempotent. Standing time is not, because
  the upload carries only a minute-rounded start and the server cannot tell a re-batched copy of
  a stop from the next minute of the same stop: a client that re-cuts the same trace into
  batches with different starts can add up to just under a minute of standing per stop each time
  (an exact repeat adds nothing), and a client that fabricates `capturedAt` can claim any
  standing it likes. Closing this would need finer timestamps or a batch identifier, which the
  upload deliberately does not carry. Both cases are fabricated traffic, bounded only by the
  admission controls, the rate limits and the median.
- **Floor:** 300 m of the edge, or half of it when that is less. Then the pieces become one
  sample at counted distance over counted time, time standing still included: a stopped queue is
  the signal. The plausibility rules above still bound each run.
- **One weight.** A contributor that already has a sample on the edge in the cohort gets no
  second sample; the newcomer cap is applied when the sample is completed. Until the sample is
  released its evidence still grows, each metre and each standing time once, and its speed is
  read at the release, so a queue that forms after the 300 m floor was reached (or a stop
  confirmed later) is not lost. A released sample is consumed; nothing changes a published
  epoch.
- **Same identifier, no new linkage.** Partial coverage is keyed by the same cohort tag as
  samples, so it adds no identifier across edges or cohorts. It lives only in API process
  memory, alongside the pending samples, is never written or logged (the operator summary counts
  it as `pendingPartial`), and expires with its cohort: it is dropped at the first boundary more
  than 15 minutes after the earliest piece's driving began or arrived. Tested: the database is
  unchanged by uploads below the threshold, and the API log contains no segment key or tag.
- **Accuracy trade-off.** The published speed is measured on the part of the edge that was
  driven, at least 300 m or half, and is drawn for the whole edge. On the undriven remainder
  of a credited edge the speed is inferred, not observed: a queue that ends part-way along a
  1.5 km edge is drawn along all of it. Edges, not their parts, remain the published unit; three
  contributors are still needed on each.

#### Dwell across batch boundaries

Standing still at a batch boundary used to vanish: the 100 m trim removed every point of a batch
that never moved, and the stationary head or tail of a moving batch, so a five-minute stop between
two moving batches counted nothing and a prolonged queue could miss the freshness window. A dwell
is now **held**, as time only, and counted once the trip is seen going on:

- It is placed only on an edge where the same contributor already has pending movement: the
  nearest such edge whose map geometry is within 25 m of where it stood, at that distance along
  the edge. It never starts coverage of its own, so a stop on a road the contributor was not
  already driving, or a trip that begins standing still, never counts.
- It counts only when that contributor's own movement brackets it: movement on the same edge
  that ended before it, and movement that began after it and reaches at least **125 m** beyond it
  (the 100 m batch trim plus the 25 m placement uncertainty), either along the same edge or onward
  across its end node, through edges of one batch that each start where the previous ends. Both
  are judged on claimed time, allowing for the minute rounding. So a dwell is counted only once
  the contributor has demonstrably driven on at least as far as the trim protects. Movement that
  had already passed it before it began contradicts it, and it is dropped.
- Going on across the end node is recognised only for an edge whose whole map geometry starts at
  exactly the vertex (to six decimals) where the held edge's geometry ends; both geometries are
  graph data, never an upload. The contributor's state on the held edge is found with the
  current request's credential, exactly as for any edge, and nothing linking the two edges is
  kept. Coordinate equality is not graph node identity: two nodes at one coordinate (a
  grade-separated crossing modelled with coincident nodes) would read as connected. Proving node
  identity needs Valhalla's node id for each edge end (`edge.end_node`/begin node in
  `trace_attributes`), which the matcher does not request today.
- A dwell that is never followed by movement, because the trip ended or sharing was cancelled at
  the stop, is never counted. It expires with the contributor's partial coverage, within the same
  15-minute window, and nothing about it leaves memory. Holding it releases no part of the
  protected tail: its position is never kept, only its distance along an edge the contributor was
  already driving, and it changes only that contributor's time on that edge.
- It is counted like any other stop (once per place and claimed time), so an uploaded-twice
  stationary batch adds nothing. It counts on a contributor's pending sample as well as on partial
  coverage.

What does **not** count, precisely: standing where the trip then turns off onto an edge that does
not start at the held edge's end vertex, or goes on less than 125 m in total; going on whose
next edges are not eligible (they produce no piece to measure the continuation with); standing
whose bracketing movement does not fit inside one 15-minute cohort window (a stop-and-go on one
edge lasting longer than that publishes nothing); standing after the sample was released; and
standing in a moving batch's kept part that GPS jitter makes look like movement. Standing in the
middle of a moving batch counts as before.

Tested through `POST /v2/traffic/probes` on batches recorded against Valhalla 3.8.2 on the
Alberta/BC graph (one 1.18 km Deerfoot Trail edge, `apps/api/test/fixtures/valhalla-dwell-calgary.json`,
three contributors): two moving batches at 36 km/h with their trimmed standing publish 15 km/h
(35 before this change); a 98 s stationary batch between them publishes 10; the same stationary
batch uploaded twice still 10; a further, jittery stationary batch 5; the same trip ending at the
stop, or beginning more than 15 minutes before the boundary, publishes nothing. Stationary batches
are never sent to the matcher. A second recording stops 22 m before the end of that edge, after an
approach that already completed the contributor's sample (580 m), and goes on across the node
(`valhalla-dwell-next-edge-calgary.json`): the edge publishes 20 km/h with the standing trimmed off
the two moving batches, 10 with a stationary batch between them (also when that batch is
uploaded twice), and 35, its moving speed, when the trip ends at the stop.

**Flagged for the next independent review:** this subsection, [Coverage across
batches](#coverage-across-batches), the change to step 6 and the use of `/locate` geometry for
partly matched edges.

Measured on the same 40-route samples per area, with three contributors per route at 1.0, 1.1 and
1.2 times the stated speed (local, graph dated 2026-11-11):

| Area                                              | Eligible length on the routes | Jam, 15 km/h: before |     after | Free-flowing, 70 km/h: before |     after |
| ------------------------------------------------- | ----------------------------: | -------------------: | --------: | ----------------------------: | --------: |
| Calgary                                           |                        517 km |                 7.8% | **84.1%** |                         21.6% | **79.7%** |
| Rural Alberta (Mountain View / Red Deer counties) |                        959 km |                 2.3% | **96.8%** |                          8.0% | **97.2%** |
| Metro Vancouver                                   |                        506 km |                11.1% | **73.7%** |                         23.2% | **73.1%** |

Eligible length is the motorway-to-secondary edges of at least 20 m on the walked routes; the
share is the length of those edges published after one epoch. The rest is mostly where the
client's 400 m trip-end trims fall and edges the three contributors cover in their first or last
pieces. At 70 km/h every published edge was `free` except three in Vancouver (before: one or
two per area), so free-flow classification did not get worse.

Simulated on Deerfoot Trail / Glenmore Trail (17.7 km) through the service with the real
Valhalla:

| Contributors (km/h)                                                                      | Before: edges / km published |        After: edges / km published | Published levels after      |   Median published speed |
| ---------------------------------------------------------------------------------------- | ---------------------------: | ---------------------------------: | --------------------------- | -----------------------: |
| 12, 16, 24 (steady jam)                                                                  |                      3 / 0.5 |                          31 / 11.0 | 20 stopped, 9 heavy, 2 slow | 15 km/h (true median 16) |
| 5, 5, 5 stop-and-go (20 s moving, 20 s stopped)                                          |                     11 / 1.2 |                          46 / 14.6 | 42 stopped, 4 heavy         |                   5 km/h |
| 90, 95, 100 (free flow)                                                                  |                      3 / 1.5 |                          38 / 11.5 | 38 free                     | 95 km/h (true median 95) |
| 12, 16, 24, the first contributor sending every batch twice plus a half-overlapping copy |                            — | 31 / 11.0, identical samples (137) | as steady                   |                  15 km/h |

The 400 m trip-end trims, tertiary connectors and edges under 20 m make up the unpublished rest of
the 17.7 km.

| Parameter                | Value            | Configurable                            |
| ------------------------ | ---------------- | --------------------------------------- |
| Epoch                    | 300 s            | No                                      |
| Cohort driving window    | 900 s            | No                                      |
| Release lifetime         | 900 s            | No                                      |
| Batch age on arrival     | 600 s            | No                                      |
| Minimum contributors (k) | 3                | Upward only (3 to 50)                   |
| Published speed step     | 5 km/h           | No                                      |
| Congestion levels        | 0.70, 0.45, 0.20 | No (`free`, `slow`, `heavy`, `stopped`) |

- **Cohort.** Per edge, the set of contributors that have a pending sample: one speed each,
  whichever of their batches arrived first. Held in API process memory only.
- **Epoch boundary.** Every five minutes on the clock, the server closes the epoch: it drops
  pending samples whose driving began, or whose arrival epoch started, more than 15 minutes
  before the boundary, then releases every edge whose cohort holds at least k contributors.
  Every sample in a release therefore describes driving that **began within the 15 minutes
  before its boundary**.
- **Release.** One value: the median of the cohort's speeds, rounded to 5 km/h, with the
  boundary as its `observedAt` and an expiry 15 minutes later. The cohort is then consumed. A
  later change to that edge needs a new cohort of k; a single further contributor changes
  nothing that is published.
- **Estimator and threshold use the same cohort.** One contributor has one weight, so replaying
  a trace with different timestamps, or uploading every minute, adds nothing. With k = 3 the
  median follows two of three contributors.
- **Immutable epoch snapshots, within one process and one database lifetime.** Each epoch's
  publication is one promise: the cohorts are closed
  the moment it starts, and its releases are written in one transaction. Every reader of an
  epoch (flow, and route traffic) waits for that epoch's publication to finish, and starts it
  itself if the boundary has passed but the timer (one second later) has not run yet, so a
  request at 12:05:00.2 gets the 12:05 snapshot, never the 12:00 contents labelled 12:05.
  Publications run one at a time. A read that overlaps the next epoch's publication is repeated
  against that newer epoch rather than returned, so every response carries exactly the snapshot
  of the epoch it names. Route traffic reads all of a request's speeds in one such read, after
  the map matching, however long that took. No response carries a contributor or sample count.
- **Never another body under a published epoch's label.** An API (re)start erases the releases and
  has published nothing for the epoch it starts in, so that epoch is unavailable (flow `503`,
  routes untouched) until the next boundary is published; an earlier process may have served
  releases under that epoch's label. Every publication also writes, in its transaction, which
  epoch the stored rows are and how many there are (`traffic_publication`). A read is served only
  when that record names the epoch being read and the row count still matches, checked in the
  same statement, so a database crash (which empties both unlogged tables), an erased release
  table or a newer publication never reads as the previous snapshot or as a published empty one;
  the epoch is unavailable until a new boundary is published. A legitimately empty snapshot,
  published at a boundary, is served normally. Tested on PostGIS: a restart one minute into a
  nonempty epoch (`503`, then an empty snapshot labelled with the next boundary), both tables
  reset, and the release table alone emptied.
- **A failed publication is not served.** If storing an epoch fails, readers of that epoch get
  `503` (flow) or untouched routes (route traffic), never older contents under the new label.
  Its releases are offered again at the next boundary, with their original boundary and expiry,
  until they expire.
- **Logical expiry.** A release is visible from its boundary until the boundary 15 minutes
  later, unless a new cohort replaced it first. Every read filters on those two times, so an
  expired release is never served, whatever cleanup has done.
- **Deletion.** Expired rows are deleted by the next publication that succeeds, which is the
  expiry boundary itself unless the database was unavailable then. A failure is logged and the
  deletion happens at the next successful boundary.

#### Freshness and the stale-data budget

| Interval                                              | Bound                    |
| ----------------------------------------------------- | ------------------------ |
| Oldest driving in an accepted batch, on arrival       | 10 min                   |
| Oldest driving a release rests on, at its boundary    | 15 min                   |
| Release served after its boundary                     | 15 min                   |
| **Oldest driving behind a value while it is served**  | **30 min**               |
| Newest driving behind a value when it is first served | just before its boundary |

A served speed is therefore at most 15 minutes old as a release and rests on driving at most 30
minutes old. A jam that has cleared can stay visible, and lengthen route ETAs, for up to 30
minutes after the driving that showed it. Flow features carry their `observedAt` boundary, and an
adjusted v2 route carries `traffic.snapshotAt` and `traffic.oldestObservedAt` (see
[Route traffic](#route-traffic)); the phone and CarPlay credit show "as of" the oldest.

- **Collect mode.** Cohorts are formed, counted for the operator, and thrown away at the
  boundary. Nothing is written to the database and nothing is served.

### Storage

`traffic_releases` (migration `0002_community_traffic` in the shared runner,
`apps/api/src/migrations.ts`) holds published values only: segment key, road class, speed, free
flow, the two epoch boundaries, and the edge geometry. `traffic_publication` (migration
`0003_traffic_publication_marker`, also `UNLOGGED`) holds one row: the boundary the stored rows are
the snapshot of, and their count. It is rewritten at every boundary, uploads or not, and carries
nothing derived from a batch. Database constraints restrict the road
class to the four aggregated classes, the speed to 5 km/h steps, `released_at` to the five-minute
grid and the lifetime to 15 minutes.

- Nothing below the threshold is ever written. The database after two contributors is byte for
  byte the database before any upload (tested with a full dump including `xmin` and `ctid`).
- All releases of an epoch are written in one statement in one transaction, in key order. Row
  versions and physical order identify the epoch, not an upload.
- The table is `UNLOGGED`, so releases are not in the write-ahead log, are not replicated, and
  are lost on a database crash. They are excluded from `backup-reports-db.sh`.
- `UNLOGGED` means disk-backed but without ordinary write-ahead logging or replication: a crash
  clears the table, a clean shutdown does not. Expiry comes from the epoch filter and deletion
  described above, not from the database.
- Every API start erases the table, in every mode including `off`. With the mode `off` the API
  waits at most three seconds for that and then carries on, so this feature adds no unbounded
  wait on the database to startup. A failed purge is logged and **retried** (after 30 s, then
  doubling to every 5 minutes) until it succeeds. Until then the old rows are past expiry and
  never served, but not yet deleted; while the API is stopped nothing deletes them.
- Database work is bounded **by PostgreSQL**: `statement_timeout` 10 s, `lock_timeout` 5 s,
  `idle_in_transaction_session_timeout` 15 s, set on every connection of the traffic pool **and
  of the community pool** that issues traffic credentials (`BOUNDED_POOL_LIMITS`,
  `apps/api/src/bounded-pool.ts`), plus a 5 s connection timeout and a 15 s client-side margin,
  which together bound shutdown (`pool.end()` waits only for checked-out clients). A blocked epoch
  is cancelled on the server and its transaction aborted (tested against PostGIS with the table
  locked). A connection whose `ROLLBACK` cannot be confirmed is destroyed, never returned to the
  pool, in both pools. A credential assertion blocked on its installation's row lock fails with a
  retryable `503` after the lock timeout and rolls back its counter update; its challenge stays
  consumed. Tested on PostGIS: seven concurrent assertions against a held lock all fail within
  13 s, no session is left running or in a transaction, shutdown completes while one is blocked,
  the counter is unchanged, the burned challenges stay refused, and a fresh assertion and a new
  registration then succeed.

Run a **single API container** (see the [checklist](#enablement-checklist)). Cohorts, keys and rate limits are per process: a second replica
would not double-count anyone (each needs its own three contributors), but it would reject the
other's credentials, erase the shared table on start, and halve the data each sees. This is
documented, not enforced.

## Serving

### `GET /v2/traffic/flow?bbox=west,south,east,north`

- Every bound must be a multiple of 0.05° and each span at most 2°. The app expands its viewport
  outward with `snapTrafficFlowBounds` from `@navoss/contracts`. This keeps an exact viewport out
  of the URL. The grid coarsens the request only; returned geometry is exact road geometry.
- The response is a GeoJSON `FeatureCollection` usable directly as a MapLibre `geojson` source.
  Each feature is a `LineString` (one road edge) with `id` (the segment key) and `congestion`,
  `speedKph` (5 km/h steps), `freeFlowKph` and `observedAt` (the releasing epoch boundary).
  Top-level members carry `source` (id `navoss-community`, attribution "Traffic from opted-in
  NavOSS drivers"), `generatedAt` (the start of the current epoch), `validUntil` (the next
  boundary) and `coverage` (`minimumContributors`, `truncated`).
- The body for a given box is identical for every request in an epoch.
  `cache-control: public, max-age=30`.
- `503` when that epoch's snapshot could not be published (see above).
- At most 3,000 features, major roads first; `truncated` says when the cap was hit.
- `503` unless the mode is `live`. An empty `features` array is a normal answer.

### `GET /v2/traffic/status`

`mode` (`off`, `collecting`, `live`), the upload rules (`probes.*`, including
`credentialEndpoint`, `batchTrimMeters` and `tripEndTrimMeters`; `probes.accepting` is `true`
only when a contributor can actually be admitted, see above) and the publication rules
(`publication.epochSeconds`, `cohortSeconds`, `releaseSeconds`, `minimumContributors`). It
reports **no totals**. Service-wide counts of observed segments and samples were removed: read
before and after an upload, they told a caller whether a road had already been driven. Operator
metrics (batch counters, pending samples and segments, released segments, failures) are logged
every 15 minutes as `Community traffic summary` and are not reachable over HTTP.

### Route traffic

`trafficService.enrichRoutes(routes)` takes the routes the routing layer computed and returns
them with traffic applied. `/v2/routes` calls it and returns its routes in its order;
`/v1/routes` is frozen for shipped clients and never carries traffic fields.

If anything is published inside the routes' bounding box, it resolves **every** route's geometry
to edges with `trace_attributes` (`edge_walk`, one request per 100 km, sequential, at most
twelve), looks up published speeds for those edges, and:

- if published edges cover at least `COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE` (50%) of a route's
  length, sets `traffic.delaySeconds`, `traffic.typicalDurationSeconds` (the routing engine's
  duration), `traffic.observedFraction`, an adjusted `durationSeconds`, adjusted step durations,
  `congestion` (one of `unknown`, `free`, `slow`, `heavy`, `stopped` per geometry segment), and
  coarse freshness: `traffic.snapshotAt`, the epoch boundary whose snapshot supplied the speeds,
  and `traffic.oldestObservedAt`, the earliest release boundary of any speed applied to the route
  (older than `snapshotAt` when the route mixes releases). Both are on the five-minute grid; the
  response's `generatedAt` is the request time and is not traffic freshness. Both are optional in
  the v2 contract, so clients tolerate a server without them, and never on `/v1/routes`;
- otherwise returns the route untouched, which means **traffic is unavailable for that route**.

Delay is counted only below the free-flow band. An observed speed includes signals and turns the
routing engine already charges for, so a `free` edge adds nothing and a slower one adds only its
time beyond 70% of free flow. Delay is never negative.

Published speeds come from as few as three installations and can be wrong or planted, so their
effect is bounded twice:

- **Delay cap.** Traffic adds at most 100% of a route's typical duration, however slow the
  published speeds. (Uncapped, one kilometre at the 3 km/h floor added about 1,100 seconds.)
- **Ranking bound.** Ranking starts from the routing engine's order. A route moves ahead of one
  ranked above it only if it is faster with traffic (by the same whole-minute comparison the
  engine order uses) **and** its total minor-road distance is at most 100 m more than that of
  the route it overtakes. Minor means any class below tertiary: residential, unclassified,
  service. A route that could not be walked has unknown roads and is never promoted.

  The exact guarantee is that bound on **total** minor-road distance, nothing more. Two routes
  with equal minor-road distance can use different residential streets, and tertiary roads count
  as through roads. Fabricated or stale traffic can therefore double an ETA and reorder
  through-road alternatives; it cannot add more than 100 m of minor road to the recommendation.

`label` still marks the route with the lowest adjusted duration, which can be a route the
ranking bound refused to promote; the order is the recommendation, and clients must present
routes in the returned order and must not select by the `fastest` label or re-sort by
duration. When at least one route was adjusted the result carries `trafficSource`
(`navoss-community`). Any failure leaves every route untouched.

In `/v2/routes`, when `trafficSource` is set it becomes `source.trafficSource` with
`source.traffic: "live"`; routes without enough published flow carry no `traffic` or
`congestion`. Clients must present routes in the returned order and must not re-sort by
duration, or the ranking bound is lost.

### Config

`features.liveTraffic` in `/v2/config` is `true` only when the mode is `live` (or the licensed
Mapbox provider is active). `collect` does not set it. `/v1/config` is frozen and reports the
licensed provider only.

## What this does not protect against

| Threat                                              | What the code does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | What remains                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-identifying home or work from the ends of a trip | The server drops 100 m from both ends of every batch (standing still there counts only as time, on an edge already being driven, and only once the trip is seen going on), aggregates only motorway to secondary roads, and publishes no edge the graph marks destination-only, dead-end or no-through in either direction, nor, in `live`, one the graph-bound dead-end mask does not place on the main network. A partly driven edge is credited once 300 m (or half) of it is covered. The app is required to exclude 400 m at both trip ends | The 400 m rule is not verifiable by the server. A home on a secondary-or-larger through road is on an eligible edge, protected by the threshold only. The mask's results on the deployed graph await independent review                                                                                                                                                                |
| A published edge implies who drove it               | Three attested installations in one cohort; edge-level threshold; tertiary and lower roads excluded; no counts published                                                                                                                                                                                                                                                                                                                                                                                                                         | Three installations can be one household, or one person with three App Attest keys kept for a week or spread over three networks. Publication reveals that the edge was driven by at least three installations in the 15 minutes before a boundary, and a 5 km/h-coarse median                                                                                                         |
| Differencing between responses                      | Releases happen only at epoch boundaries, each from a consumed cohort of at least k; expiry is on a fixed schedule                                                                                                                                                                                                                                                                                                                                                                                                                               | An observer learns "at least k new contributions arrived on this edge before this boundary". That is a group fact, not an individual one, but on a quiet road the group may be guessable                                                                                                                                                                                               |
| Collusion: k-1 of a cohort are the attacker         | Median of the cohort, 5 km/h steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | With k = 3, two attacker installations bracket the third contributor: its presence on the edge in that window and its approximate speed are inferable, and pre-seeding adjacent branches shows which branch it took. No threshold scheme prevents this; the 20 m minimum only removes the shortest junction connectors                                                                 |
| Fabricated traffic                                  | Uploads need an attested installation at least a day old; newcomers capped per network per cohort; one installation one weight; plausibility bounds; per-installation and per-network rate limits; median; route delay cap and ranking bound                                                                                                                                                                                                                                                                                                     | Three attested keys a week old, which one ordinary iPhone can hold, or one copied bearer credential plus two keys, publish a false speed on an edge. It can lengthen an ETA by up to 100% and swap through-road alternatives; it cannot add more than 100 m of minor road to the recommended route                                                                                     |
| Linking batches into a trip                         | No trip or sequence id; minute-coarse start; nothing raw retained; per-edge tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Batches of one trip carry the same credential and come from the same address, so the API process and Cloudflare can link them while they arrive. Adjacent positions link consecutive batches anyway                                                                                                                                                                                    |
| Database or backup disclosure                       | The database holds published releases only, in an unlogged table excluded from backups                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A leak shows which major-road edges were published in the last 15 minutes: what the flow endpoint already serves. The installation table shows when each installation last made an attested request                                                                                                                                                                                    |
| Process memory disclosure                           | Keys and cohorts are memory-only; cohorts hold cohort-salted tags, speeds, counted evidence and held dwells (distances along the edge, claimed times) and, for newcomers, a cohort-salted network marker, for at most 20 minutes. Nothing held is equal across edges or consumed cohorts                                                                                                                                                                                                                                                         | With memory and the installation table, an installation can be matched to the edges it has pending samples on. The salts are in the same memory, so a newcomer's network bucket can be recovered by trying every bucket. Claimed times, unquantised speeds and insertion order are further correlation signals; batches and credentials sit unzeroed in request memory until collected |
| Location leaking through logs                       | API request logging is off; handlers log nothing from the body; matcher errors are swallowed; the summary has counters only; a test ingests batches, forces failures and scans the database and API log output                                                                                                                                                                                                                                                                                                                                   | **Not established for anything but the API process**: whether Valhalla logs request bodies, whether Caddy logs headers on proxy errors, swap, and core dumps. See below                                                                                                                                                                                                                |
| Viewport disclosure through flow requests           | Bounds snapped to a 0.05° grid, comparable to a map-tile request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The request still shows which ~4 km cell is on screen, as tile requests already do                                                                                                                                                                                                                                                                                                     |
| Traces sent to a third party                        | The matcher endpoint must be loopback, a private or link-local address literal, or a single-label host name (a Compose service); redirects are refused                                                                                                                                                                                                                                                                                                                                                                                           | An operator can still run a forwarding proxy at a local address. Single-label names are not resolved or pinned by the guard, and the address check does not prove same-machine processing or operator ownership                                                                                                                                                                        |

Established locally on the real Alberta/BC graph (see
[Local validation](#local-validation-on-the-albertabc-graph)), and therefore no longer unknown:
eligibility rates by road class, the `/locate` latency per batch, route walks over 100 km,
publication only after the threshold on real Calgary roads, `/v2/routes` congestion alignment and
the ranking bound on a real reordering, and that Valhalla 3.8.2 with its default logging writes
no positions (request line, status, size and error text only, including for failed matches).

Unproven, and to be established before `live`:

- **Valhalla logging on the production host.** Locally, Valhalla 3.8.2 logged no coordinates in
  8,369 lines covering matches, `/locate`, route walks and deliberately failing traces. The
  production container's log configuration and journald retention still need the same check.
- **Proxy, swap and crash artifacts.** Caddy access logging is off, but error-path logging of
  headers (which include the client address) and the absence of swap and core dumps for the API
  and Valhalla have not been verified. Production only.
- **Map-match quality on real GPS.** Synthetic traces built from real route geometry (with
  jitter, 2 s fixes, 5–100 km/h) match on the Alberta/BC graph; real phone traces, with urban
  canyon and tunnel noise, have not been run through the pipeline.
- **Speed on the undriven part of a credited edge.** Since coverage is joined across batches, a
  published speed is measured on at least 300 m (or half) of an edge and drawn for all of it.
  How far that misplaces the end of a real queue on long rural edges has not been measured
  against real traffic.
- **Long dead-end regions.** Measured: Valhalla's flags do not mark them (Alberta 66 and 546, BC 4
  and 37A). The graph-bound mask that does is built and wired, and required for `live`; it awaits
  independent review and a production graph-identity check.
- **Raw batch lifetime in memory.** The batch lives in the request body, local arrays and the
  matcher request until garbage collection; it is not zeroed, and the matcher request has a
  four-second timeout rather than a hard bound on that lifetime.
- **Load, and the production path.** Local latencies are single-client under CPU emulation. Load
  at the expected contributor count, and behaviour behind Cloudflare and Caddy, are untested.
- **Route ETA in a client.** `/v2/routes` returns adjusted routes with coarse freshness, and the
  phone route preview and CarPlay credit say "as of" the oldest release used. That is unit-tested
  only: no client has presented community-adjusted routes from a live server or on a rendered
  surface.
- **The admission controls in practice.** How often carrier NAT puts two genuine newcomers in one
  /24 within one cohort, and how much coverage the 24-hour wait costs, is unknown.

## Local validation on the Alberta/BC graph

Measured on 2026-11-13 on the maintainer's Mac, **local, graph dated 2026-11-11, not production**:
`ghcr.io/valhalla/valhalla-scripted:3.8.2` (`valhalla_service`, 2 threads, 2 CPUs, 2 GiB, amd64
emulation on Apple silicon) serving the real Alberta + British Columbia graph from the
offline-bundle pipeline (1,006,695 drivable ways, 3,949,177 directed drivable edges), the API from
this branch in `live` with `allow-development`, and PostGIS 16-3.5. Latencies are indicative only.

### Defects it exposed, fixed here

1. **Route walks failed for every route longer than 100 km, and for some short ones.** Valhalla
   3.8.2 `edge_walk` repeats the last vertex when a request ends part-way along an edge (every
   100 km chunk boundary) and can add a zero-length edge; `walkRoute` then saw one vertex too
   many and refused the whole route, so long routes never carried traffic and were never
   re-ranked. Before the fix 124 of 133 routes of the two benchmarks walked (all over 100 km
   failed); after it 131 of 133 (the two are 1,207 km alternatives beyond the twelve-request cap,
   by design). The walk now drops only a repeat that Valhalla added, and also checks that the
   echoed vertices equal the route's own coordinates, which the earlier review noted it did not.
   Regression tests replay recorded real walks (Calgary–Edmonton, four requests; Banff, whose
   route repeats its own first vertex).
2. **A crawl was answered with 503.** For some interpolated points Valhalla 3.8.2 returns
   `edge_index` 2^64 − 1 (no edge). That is outside JavaScript's safe-integer range, the schema
   refused the whole response, and one in six batches of a 12 km/h jam on Deerfoot Trail became
   a matcher outage, telling the app to stop for five minutes exactly when traffic is worth
   reporting. Such points now count as unmatched. Regression test on a recorded Calgary batch.
3. **Jams on long edges could never be published.** See
   [Coverage across batches](#coverage-across-batches): pieces of an edge are now joined across a
   contributor's batches.
4. **The replay script could not publish on a real route.** It dated a long drive's batches up
   to eight minutes back, which the 15-minute driving window (added with the freshness fix) then
   dropped before the second boundary. It now dates each batch as just driven, takes its drive
   from `/v2/routes`, and checks `/v2/routes` in `live` mode at the end.

### Eligibility on real roads

Forty random origin–destination routes per area, walked with `edge_walk`; every distinct edge on
them classified by the same rules the server applies (class/use, 20 m, then `/locate` for the
rest). Sampling by routes weights roads by how often trips use them.

**Calgary**

| Road class    | Edges |    km | Excluded: class/use | Excluded: < 20 m | Excluded: graph flags | Eligible (length) | Eligible (edge count) |
| ------------- | ----: | ----: | ------------------: | ---------------: | --------------------: | ----------------: | --------------------: |
| motorway      |  1049 | 363.0 |                0.0% |             0.1% |                  0.0% |             99.9% |                 98.1% |
| trunk         |   328 |  27.6 |                0.0% |             4.4% |                  0.0% |             95.6% |                 68.9% |
| primary       |   225 |  52.0 |                0.0% |             1.0% |                  0.0% |             99.0% |                 76.9% |
| secondary     |   958 |  92.6 |                0.0% |             3.5% |                  0.0% |             96.5% |                 65.9% |
| tertiary      |   684 |  74.3 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| unclassified  |    89 |  17.0 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| residential   |   328 |  21.6 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| service_other |    73 |  17.6 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |

**Rural Alberta (Mountain View / Red Deer counties)**

| Road class    | Edges |    km | Excluded: class/use | Excluded: < 20 m | Excluded: graph flags | Eligible (length) | Eligible (edge count) |
| ------------- | ----: | ----: | ------------------: | ---------------: | --------------------: | ----------------: | --------------------: |
| motorway      |    23 |  43.9 |                0.0% |             0.0% |                  0.0% |            100.0% |                100.0% |
| trunk         |    15 |  19.7 |                0.0% |             0.0% |                  0.0% |            100.0% |                100.0% |
| primary       |   768 | 430.5 |                0.0% |             0.3% |                  0.0% |             99.7% |                 85.8% |
| secondary     |   565 | 466.5 |                0.0% |             0.1% |                  0.0% |             99.9% |                 90.3% |
| tertiary      |    75 |  54.6 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| unclassified  |   271 | 211.0 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| residential   |    17 |   1.1 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| service_other |     7 |   1.5 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |

**Metro Vancouver**

| Road class    | Edges |    km | Excluded: class/use | Excluded: < 20 m | Excluded: graph flags | Eligible (length) | Eligible (edge count) |
| ------------- | ----: | ----: | ------------------: | ---------------: | --------------------: | ----------------: | --------------------: |
| motorway      |   603 | 193.2 |                0.0% |             0.1% |                  0.0% |             99.9% |                 97.0% |
| trunk         |  1269 | 113.9 |                0.0% |             4.3% |                  0.0% |             95.7% |                 61.6% |
| primary       |  2680 | 144.6 |                0.0% |             7.7% |                  0.0% |             92.3% |                 59.9% |
| secondary     |  1425 |  76.7 |                0.0% |             7.8% |                  0.0% |             92.2% |                 59.9% |
| tertiary      |   901 |  51.5 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| unclassified  |   255 |  18.8 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| residential   |   292 |  16.0 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |
| service_other |   115 |  13.4 |              100.0% |             0.0% |                  0.0% |              0.0% |                  0.0% |

- The graph flags almost never fire on routed through roads: on the sampled routes no eligible-
  class edge was destination-only, a dead end or no-through. Probing every secondary-or-larger
  edge near 4,000 random points per area found them on 5 of 8,809 edges in Calgary, 3 of 13,682
  in Edmonton, 12 of 18,553 in Metro Vancouver and none of 725 in rural Alberta (for example a
  dead-end stub of 130 Avenue SE in Calgary and unnamed destination-only connectors). The access check matters for traces that
  leave the network at a trip end, which is what it is for, not for coverage.
- What actually limits coverage is the class rule (tertiary and below: 100%) and the 20 m minimum:
  1–8% of trunk/primary/secondary length in the cities (up to 40% of edges by count), under 0.5%
  in rural Alberta.
- `/locate` costs one extra request per batch with a candidate edge: p50 5–6 ms, p95 6–16 ms for
  the 1.5–5 candidate edges a one-minute batch has (trace match p50 5 ms on the same batches),
  and p50 10 ms, p95 17 ms for 40 edges.

### Dead-end valleys on the real graph

`/locate` reported every secondary-or-larger edge on these roads as an open through road:

| Road                                                           | Kind                        | Length checked | Flagged |
| -------------------------------------------------------------- | --------------------------- | -------------: | ------: |
| Alberta 66, Elbow Falls Trail (Bragg Creek to Little Elbow)    | dead-end valley, primary    |          31 km |       0 |
| Alberta 546, Sheep River Trail (Turner Valley to the road end) | dead-end valley, secondary  |          28 km |       0 |
| Alberta 40, Kananaskis Trail (Highway 1 to Kananaskis Village) | through road (control)      |          29 km |       0 |
| BC 4, Pacific Rim Highway (Port Alberni to Tofino)             | dead-end peninsula, primary |         126 km |       0 |
| BC 37A, Glacier Highway (Meziadin Junction to Stewart)         | dead-end valley, secondary  |          62 km |       0 |

The weakness documented after the Liechtenstein check holds at provincial scale: Valhalla's
no-through search is bounded, so a valley with its own road network is a through road to it.
Anyone living along these roads is protected only by the app's trip-end trimming and the
three-contributor threshold.

**What a dead-end mask would cost.** The graph has 1.0 M drivable ways and 3.95 M directed edges;
Valhalla's own tools enumerate all of them in 2–5 s here (`valhalla_ways_to_edges`,
`valhalla_export_edges`). A mask needs node topology, so it would be built from the same OSM extract
(for example with osmium) rather than from those exports: find bridges of the drivable road graph
(Tarjan, linear time), take the side of each bridge that does not contain the main network as a
dead-end region, and add edges within 400 m along the network of a terminal. That is seconds of
CPU in C++ or a few minutes in Python per graph build, a mask of a few MB keyed by way and
direction (or segment key) versioned with the graph id, and a set lookup per candidate edge at
run time. The work is roughly one to two days for the build step, its tests and the fail-closed
check that the mask and graph versions match. It has since been built (about a minute and
418 KB for the Alberta/BC graph); see
[`infra/offline/dead-end-mask.md`](../../infra/offline/dead-end-mask.md). The checklist keeps it a
`live` precondition, with no waiver.

### End to end on Calgary

`traffic:replay` against the live API (this branch, `allow-development`, PostGIS) and the real
graph, three development installations driving the 17.8 km Deerfoot Trail / Glenmore Trail route
(`/v2/routes` geometry, 2 s fixes, the client's 400 m trims, batches closed at the advertised
60 s and 600 m) at 12, 16 and
24 km/h, the second also re-uploading from three more networks:

- After two installations and the epoch boundary: **0** published edges. With the third uploaded
  but the epoch open: **0**. At the next boundary: **24** edges (14 `stopped`, 8 `heavy`,
  2 `slow`). Before coverage was joined across batches the same replay published 0 edges at the
  boundary.
- `/v2/routes` for the same trip in `live` mode: `source.traffic: "live"` with the community
  source. The engine's first route (Deerfoot) carried the jam: +1,243 s, capped at 100% of its
  1,243 s, observed 0.61, and `congestion` with 423 entries for 424 geometry vertices. It moved
  from first to last; the two alternatives, unobserved and without `traffic`, moved ahead.
- The ranking bound held on that real reordering: all three routes have 1,352 m of minor road
  (the shared residential start), so neither promotion added minor road.
- Repeated on 2026-11-14 (local, same graph, Valhalla 3.8.2 serving `connected.tar` with id
  `eeaa7a1d…1857`) with this revision in `live`, which now requires the dead-end mask for that
  graph (the API refused to start without it): **0** edges after two installations and at the
  boundary, **0** with the third before the boundary, **29** at the next boundary (14 `stopped`,
  10 `slow`, 5 `heavy`); `/v2/routes` carried `snapshotAt` and `oldestObservedAt` at that
  boundary, distinct from its `generatedAt`. The start epoch answered `503`. A PostgreSQL
  immediate shutdown and restart inside the published epoch emptied both unlogged tables, and flow
  answered `503` for the rest of that epoch instead of an empty body under its label.
- Route walks over 100 km now succeed on the real graph: Calgary–Edmonton (299 and 306 km, three
  and four requests) and Calgary–Vancouver (974 km, ten requests) walked edge for edge with the
  route geometry, 38–107 ms. The 1,207 km Calgary–Vancouver alternative exceeds the
  twelve-request cap and is, by design, never walked or promoted.

## Enablement checklist

The operator checks every box for a mode before setting `COMMUNITY_TRAFFIC_MODE` to it. A box
that cannot be checked is a decision to stay at the previous mode. `collect` with synthetic or
internal drivers only needs the first group.

### Before `collect` with internal or synthetic traffic

- [ ] `node dist/migrate.js` has run; the API starts in `collect` (it refuses while a migration
      is pending).
- [ ] `APP_ATTEST_TEAM_ID`, `APP_ATTEST_BUNDLE_ID`, `APP_ATTEST_ENVIRONMENT=production` and a
      32-byte-or-longer `COMMUNITY_INSTALLATION_SECRET` are set, and `GET /v2/traffic/status`
      reports `probes.accepting: true` (`infra/compose/check-stack.sh` checks this).
- [ ] `VALHALLA_TRACE_URL` points at the stack's own Valhalla service (single-label name or
      private address), built from the same extract the routes use.
- [ ] Exactly one API container runs against the database (Compose `api` service, no
      `scale`/replicas). Nothing enforces this.
- [ ] The operator log is watched for `Community traffic maintenance failed`; a `purge` failure
      while `off` retries on its own, an `epoch` failure means the snapshot was not published.

### Before `collect` with real drivers

Collection receives exactly the inputs `live` does, so this group is about the inputs.

- [ ] `COMMUNITY_ATTESTATION_MODE=enforce` (the default). `allow-development` admits software
      keys and must never run with real drivers.
- [ ] The app release that uploads has been audited against the [client rules](#client-rules):
      switch off by default, upload only during navigation, the 400 m trip-end trimming and
      hold-back, memory-only batches, handling of `401`, `403`, `429` and `503`.
- [ ] Valhalla's container logs, at its configured level, contain no request bodies for
      `trace_attributes` and `/locate`, including on errors (send a malformed trace and read the
      journal). Established locally for 3.8.2 at its default logging; repeat on the host.
- [ ] Caddy logs no request headers or client addresses on proxy errors.
- [ ] Swap is off or encrypted, and core dumps are disabled, for the API and Valhalla
      containers.
- [ ] The database's availability is monitored: `/ready` reports `database: not_ready` when it
      is unreachable, and deletion of expired releases waits for the next successful boundary.
- [ ] The privacy policy in force matches [`docs/privacy.md`](../privacy.md) at this revision.

### Before `live`

Everything above, and:

- [ ] Real GPS traces, from the app release, have been run through the pipeline on the Alberta/BC
      graph: snap distances and the share of each road class published have been looked at.
      (Synthetic traces on real routes: done locally.)
- [ ] The topology-derived dead-end mask, built from the same extract and bound to the graph
      Valhalla serves, is configured (`COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH`,
      `COMMUNITY_TRAFFIC_GRAPH_ID`); the API refuses `live` without it. There is no operator
      waiver. `COMMUNITY_TRAFFIC_GRAPH_ID` has been confirmed to be the SHA-256 of the graph the
      production Valhalla actually serves.
- [ ] An independent privacy and security review has passed on the exact commit to be deployed,
      covering at least idempotent distance and time evidence, dwell across batch boundaries,
      cohort-salted tags and newcomer markers, the bounded community pool, epoch-label
      immutability across restart and database loss, route freshness, and the dead-end mask and
      its graph binding. The 2026-11-14 review's findings are repaired in code but not yet
      re-reviewed.
- [ ] Load: Valhalla answers routes within their budget while probes, `/locate` and route walks
      run at the expected contributor count (`maxConcurrentMatches` stays 1). Single-client
      latencies are measured locally; load is not.
- [ ] `/v2/routes` presents community-adjusted routes only after its own review: returned order
      preserved, `fastest` label not used to select, `traffic.oldestObservedAt` shown wherever
      community traffic is credited (implemented in the phone and CarPlay, unit-tested only).
- [ ] The residual risks below are accepted in writing, or admission is strengthened first.

### Accepted residual risks

Enabling `live` means accepting these plainly:

- **One handset, several keys.** One iPhone can hold any number of App Attest keys. After a week,
  three of them uploading from three networks are three contributors and can publish a false
  speed on an edge, doubling an ETA and reordering through-road alternatives. The 24-hour wait
  and the newcomer cap only make that slower.
- **Two colluding contributors.** With k = 3, two cooperating installations on an edge learn,
  from a release, that a third installation drove it in that window and its speed to within
  5 km/h. Pre-seeding adjacent branches shows which branch the third took.
- **Client-side trip-end trimming.** Only the app trims the first and last 400 m of a trip and
  the stretch around stops. The server cannot verify it; a modified or faulty app would send
  trip ends, and the server's own 100 m batch trim and road rules are all that stand behind it.
- **Bearer credentials.** A credential copied off a phone works from anywhere until it expires.
- **Process memory.** Keys, salts, pending cohorts, held dwells and in-flight batches live
  unzeroed in API process memory. Anyone who can read it (a core dump, swap, a debugger) can
  match pending samples to installations with the installation table, and recover newcomers'
  network buckets by trying them all.
- **Stale values.** A served speed rests on driving up to 30 minutes old.

## Retention

| What                                                                                                                                                                                                                                                          | Where                                    | How long                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uploaded positions, offsets, `capturedAt`                                                                                                                                                                                                                     | Request memory                           | Until the request finishes (not zeroed)                                                                                                                                                      |
| Pending sample: cohort tag, arrival epoch, driving start, cohort salt, and its evidence (as for partial coverage, below); newcomers also a cohort-salted network marker                                                                                       | API process memory                       | Until released, or dropped at the first boundary more than 15 min after its driving began or its arrival epoch: at most 20 min                                                               |
| Partial coverage: cohort tag, driven intervals along the edge (metres), counted distance and time, each batch's driven span (metres, claimed times), stops and held dwells (distance along the edge, claimed times), earliest arrival epoch and driving start | API process memory                       | Until it completes a sample, or dropped at the first boundary more than 15 min after its earliest piece: at most 20 min                                                                      |
| Publication record: the boundary the stored rows are, and their count                                                                                                                                                                                         | `traffic_publication`                    | Rewritten at every boundary; erased on every API start                                                                                                                                       |
| Release: edge, speed, boundaries, edge geometry                                                                                                                                                                                                               | `traffic_releases`                       | Never served after the boundary 15 min after release. Deleted by the first successful publication at or after that boundary; erased on every API start, and retried until erased while `off` |
| Credential and seed                                                                                                                                                                                                                                           | Phone memory; never stored by the server | Credential valid 2 h; unusable after an API restart                                                                                                                                          |
| Network and installation rate-limit fingerprints                                                                                                                                                                                                              | API process memory                       | Salted hash and request times; removed within 11 minutes of the last request; cleared on shutdown                                                                                            |

Logical visibility and physical deletion differ. Everything derived from a batch is out of
memory within 20 minutes of its arrival and no longer served within 35 minutes. A published row
is physically deleted at its expiry boundary **if** that boundary's publication succeeds;
otherwise at the next one that does, or, while `off`, by the purge that is retried until it
succeeds. Nothing deletes rows while the API is stopped, and a clean database shutdown does not
clear the unlogged table. A failed job is logged (`Community traffic maintenance failed`).

Not derived from batches but kept longer: the operator summary logs cumulative counters (batches,
samples, released segments, failures) every 15 minutes, held as long as the operational logs
(seven days). They contain no road, position, address or installation. Credential issuance
updates the installation's counter and `last_active_at`, as every attested request does.

## Configuration

| Variable                                                                      | Default               | Notes                                                                                                                              |
| ----------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `COMMUNITY_TRAFFIC_MODE`                                                      | `off`                 | `off`, `collect` (form cohorts, publish and store nothing), `live`                                                                 |
| `VALHALLA_TRACE_URL`                                                          | from `VALHALLA_URL`   | `trace_attributes` endpoint; must be a local endpoint when the mode is not `off`                                                   |
| `COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS`                                          | `3`                   | 3 to 50                                                                                                                            |
| `COMMUNITY_TRAFFIC_TRIP_TRIM_METERS`                                          | `400`                 | 400 to 2,000; advertised to the app                                                                                                |
| `COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE`                                        | `0.5`                 | 0.1 to 1                                                                                                                           |
| `COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL`                                         | `6000`                | Authenticated batches per 10 minutes                                                                                               |
| `COMMUNITY_TRAFFIC_BOUNDS`                                                    | Alberta + BC          | `west,south,east,north`; can only narrow the provincial coverage, never extend it                                                  |
| `COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH`, `COMMUNITY_TRAFFIC_GRAPH_ID`          | unset                 | The dead-end mask and the SHA-256 of the graph it was built for; required for `live`, optional for `collect`, not read while `off` |
| `APP_ATTEST_*`, `COMMUNITY_ATTESTATION_MODE`, `COMMUNITY_INSTALLATION_SECRET` | see community reports | Required for uploads: without them no credential is issued                                                                         |
| `PGHOST` and the other `PG*` variables                                        | unset                 | Unset uses an in-memory release store, and no attestation, for development only                                                    |

The privacy limits are enforced when the service is built (`assertTrafficPrivacyLimits`), not
only when the environment is read: k below 3, a trip trim below 400 m, a batch trim below 100 m,
an epoch below 300 s, or a cohort or release lifetime above 900 s make the API refuse to start.
The epoch, the lifetimes, the batch trim, the batch age, the road classes, the 20 m edge
minimum, the 24-hour installation age and the seven-day newcomer period have no environment
variable.

The API never applies migrations. `node dist/migrate.js` (the same command as community reports)
creates `traffic_releases`; in `collect` or `live` the API refuses to start while a migration is
pending. Deployment steps are in
[`infra/compose/README.md`](../../infra/compose/README.md#community-traffic).

## Feeding Valhalla's own routing: later

Observed speeds adjust the ETA of routes Valhalla has already chosen. They do not change which
route Valhalla chooses. That is a decision, not an omission:

- **Sparse data biases route choice.** Valhalla treats an edge without live speed as free flow.
  With partial coverage it would steer drivers off the roads NavOSS has observed and onto roads
  nobody has reported on, which is the opposite of what a driver wants and would also starve the
  observed roads of contributors.
- **Valhalla's live traffic has no write API.** It is a memory-mapped `traffic.tar` laid out like
  the graph tiles, with one record per edge addressed by Valhalla's internal edge id. Writing it
  needs a native process built against the same Valhalla version, running beside the server,
  sharing the file.
- **Edge ids change with every graph build**, so the writer needs its own mapping from NavOSS
  segments to the active graph.
- **Live speeds only apply to "leave now" requests.** NavOSS sets `date_time` only when no
  alternatives are requested, and changing that affects every route.
- **Stale speeds are worse than none.** An entry that is not cleared when its bucket expires
  freezes a jam into the graph.

The design for when it is worth doing:

1. Gate on coverage, not on a date: enable per region once published segments cover most
   motorway, trunk and primary length there during daytime for a sustained period.
2. Build the graph with a traffic extract (`valhalla_build_extract --with-traffic`), set
   `mjolnir.traffic_extract`, and mount `traffic.tar` read-only into the Valhalla container and
   read-write into a writer.
3. Add `edge.id` to the attributes requested during ingestion and keep a
   `segment_key -> edge id` table keyed by the graph's `tileset_last_modified`, dropped when the
   graph changes.
4. Add a writer sidecar: at every epoch boundary it reads `traffic_releases` (which holds only
   published values), writes speed and congestion for those edges, and clears every edge it
   wrote earlier that is no longer published.
5. Send `date_time: {type: 0}` on route requests, rerun the route-quality gates with and without
   the extract, and keep a switch that empties the extract.
6. Once Valhalla costs with live speeds, stop adding delay in `enrichRoutes` for those edges, or
   the same slowdown is counted twice.

Nothing for this is wired today. `traffic_name` stays blank in `infra/compose/compose.yaml`, no
edge ids are stored, and there is no exporter. The seam is the release store's read queries.
Feeding the cost function would also remove the re-ranking bound described under
[Route traffic](#route-traffic): Valhalla would choose residential detours on its own, so this
step additionally needs a defence against planted speeds that the current design does not have.
Historical speed profiles (Valhalla's predicted traffic) would need long-term retention and are
out of scope for the same privacy reasons that keep retention at about half an hour.

## Testing

- `apps/api/test/traffic-logic.test.ts`: evidence idempotence (the reviewed 1.5 km replay case
  through the released median, a replay claiming another speed, repeated, re-batched and separate
  stops), dwell holding and confirmation (continuation required, trip ends and trip starts never
  counted, a contradicted dwell dropped, several stationary batches, the 15-minute window),
  trimming, plausibility (the last-point future check and
  the first-point age), credentials, cohorts (threshold, one weight per contributor, consumed
  cohorts, per-edge threshold, immutable geometry, the driving window, the newcomer cap),
  privacy limits, observation derivation (road classes, the first-edge sliver), eligibility
  (20 m minimum; destination-only, dead-end, no-through and car-closed ways in either
  direction; failing closed), route delay cap and ranking bound, the matcher (redirects, snap
  distance present and absent, the 2^64 − 1 edge-index sentinel), coverage across batches
  (union of intervals, replays and overlaps, standing time, the floor on short edges, expiry,
  per-edge tags, the newcomer cap at completion), whole-edge geometry for partly matched real
  edges, recorded real Alberta/BC route walks (repeated chunk-end vertices, a zero-length edge, a
  route that repeats its own vertex, coordinate equality), the release store's handling of an
  unconfirmed rollback, and the multi-request walk of a 260 km route, with no external service.
- `apps/api/test/traffic-app.test.ts`: the HTTP surface, modes, credentials, the minimum
  installation age and the newcomer cap, rate limiting, epoch snapshots (read before the epoch
  job runs, readers waiting on a slow store, a failed publication answered with `503`, a route
  walk that spans a boundary, a restart inside a published epoch, a store that lost its
  snapshot), dwell through the probe endpoint on recorded Alberta/BC batches, the configured
  service and the dead-end mask (live refuses without a valid mask for its graph, collect runs
  without, the built matcher applies it), the off-mode purge retry, `accepting` with a report service that
  has no verifier, the total-free status and route enrichment on the in-memory store.
- `apps/api/test/app.test.ts`: the API keeps running against a database that refuses
  connections; `/ready` reports `database: not_ready` and the Google budget answers `503`.
- `apps/api/test/traffic-postgres.test.ts`: the same pipeline on PostGIS with the shared
  migration runner, including: nothing stored below the threshold, one transaction per epoch, no
  uploaded position, address or credential in the database or API log, purge on start in every
  mode, credentials issued against real installation rows with a test App Attest authority
  (including the 24-hour age and the newcomer cap), a blocked epoch cancelled by the
  server's lock timeout without serving its stale rows, partial coverage kept out of the
  database and the log, a restart inside a published epoch and lost unlogged tables answered with
  `503`, and credential assertions against a held installation lock on the bounded community
  pool.
- `apps/api/test/community-transactions.test.ts`: a lock wait cancelled by the server is a
  retryable `busy`, and a connection whose rollback cannot be confirmed is destroyed.
  It needs PostGIS on `127.0.0.1:5442` (or `NAVOSS_TRAFFIC_TEST_DATABASE_URL`) and skips when
  that is not reachable unless `NAVOSS_REQUIRE_TEST_DATABASE=1`:

  ```sh
  docker run -d --name api-traffic-postgis -p 127.0.0.1:5442:5432 \
    -e POSTGRES_DB=navoss -e POSTGRES_USER=navoss -e POSTGRES_PASSWORD=navoss \
    postgis/postgis:16-3.5-alpine
  ```

- Valhalla is stubbed with responses recorded from Valhalla 3.8.2
  (`apps/api/test/fixtures/traffic-drive.json`: `trace_attributes` with snap distances, the
  route walk, and the trimmed verbose `/locate` answer, with whole-edge shapes, for the drive's
  candidate edges), and from the Alberta/BC graph (`valhalla-walks-alberta-bc.json`,
  `valhalla-crawl-calgary.json`); the 260 km walk uses a synthetic matcher.
- `corepack pnpm --filter @navoss/api traffic:replay` registers development installations
  against a local API with PostGIS and Valhalla, replays a synthetic drive, and fails unless
  edges stay hidden for two installations (however often one of them uploads, from whatever
  network) and until the epoch closes, then appear at the boundary after the third, and
  `/v2/routes` returns them as congestion aligned to the route geometry.
  `TRAFFIC_REPLAY_SPEED_KPH` sets the contributors' speed (12 reproduces a Deerfoot jam). It needs
  `COMMUNITY_ATTESTATION_MODE=allow-development` and the API's `PG*` variables (it dates its
  installations two days back, past the 24-hour minimum), and takes five to ten minutes because
  it waits for real epoch boundaries; the script header lists the commands.
