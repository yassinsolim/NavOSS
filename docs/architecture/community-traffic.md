# Community traffic

Decision date: 2026-11-12 (revised the same day after an independent privacy and security review)

NavOSS builds its own live traffic from the speeds of drivers who switch traffic sharing on. There
is no paid provider and, after review, no usable official flow feed for Alberta or British Columbia
(see [`../data-sources.md`](../data-sources.md#community-traffic)). This document describes the
server pipeline as built, the contract the app must follow, what the design does and does not
protect against, and what is deliberately left for later.

Status: the server is implemented and off by default (`COMMUNITY_TRAFFIC_MODE=off`). No released
app uploads anything yet. The phone switch, the upload client, the map layer and the `/v2/routes`
wiring are later work. With few contributors very little will be published.

**This is not an anonymity system and makes no formal anonymity claim.** It is data minimisation
plus a contributor threshold. The section [What this does not protect against](#what-this-does-not-protect-against)
lists the limits; read it before enabling `live`.

## Pipeline

```text
phone (sharing on, navigating, App Attest installation registered)
  ├─ POST /v2/traffic/credentials   one assertion -> opaque upload credential, valid 2 h
  └─ POST /v2/traffic/probes        one short batch: credential + positions + relative seconds
        │  network rate limit, credential check, per-installation rate limit,
        │  plausibility, trim 100 m off both ends
        ▼
   Valhalla trace_attributes   self-hosted, in-memory, local endpoint only
        │  matched edges: OSM way id, direction, class, use, edge speed, edge geometry
        ▼
   one speed sample per whole road edge   the batch is dropped here; never written or logged
        ▼
   pending cohorts   API process memory only: per edge, contributor tag -> one speed
        │  every 5 minutes, on the boundary: an edge whose cohort holds >= 3 installations is
        │  released as one coarse median, and that cohort is consumed
        ▼
   PostGIS traffic_releases   published values only, deleted 15 minutes after release
        ▼
   GET /v2/traffic/flow    the current epoch's snapshot as GeoJSON for a MapLibre line layer
   GET /v2/traffic/status  mode and rules; no totals
   enrichRoutes()          delay, adjusted ETA and per-segment congestion for /v2/routes
```

Code lives in `apps/api/src/traffic/`; contracts in `packages/contracts/src/traffic.ts`. All four
routes are under `/v2`: nothing under `/v1` was added or changed, and no shipped client calls
them.

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
   `allow-development`). It then computes a **contributor seed**,
   `HMAC-SHA256(process key, installation id)` truncated to 16 bytes, seals the seed and an
   expiry with AES-256-GCM under a second process key, and returns the result as the
   `credential`. The installation id is not kept anywhere after that call.
4. Every batch carries the credential. The server opens it, and for each road edge the batch
   yields it derives a **contributor tag**, `HMAC-SHA256(seed, segment key)`. A cohort holds at
   most one sample per tag.

Properties, each covered by a test:

- **One device, one weight.** The seed depends only on the installation, so the same phone has
  the same tag on a given edge whatever network it uses and however many credentials it
  requests.
- **Unattested uploads are refused.** A batch without a valid credential gets `401`; a
  credential needs a verified assertion from a registered installation; with
  `COMMUNITY_ATTESTATION_MODE=enforce` (the default) development keys are refused even if they
  were registered earlier. Without App Attest configured the API issues no credentials and
  `status.probes.accepting` is `false`.
- **Nothing stored links a batch to an installation.** Seeds, tags and credentials are never
  written to the database or the log. The installation tables have no traffic column, and
  `traffic_releases` has no contributor column. Both keys exist only in process memory, so a
  restart invalidates every credential and makes the old seeds unrepeatable.
- **Tags do not join roads.** A tag is specific to one edge, so the cohorts held in memory
  cannot be joined into a path by tag equality.

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
  genuine device and app, not one key per device. Three keys on one phone are three
  contributors. Registration is rate limited per network; Apple's fraud-risk receipt metric,
  which would bound keys per device, is not used.
- **Credential requests are visible in the installation table.** Verifying the assertion
  advances the installation's counter and sets its `last_active_at`, as every attested write
  does. The database therefore shows when an installation last made an attested request, which
  for a traffic contributor is roughly when a trip (or a two-hour stretch of one) began.

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
  absolute time only to refuse stale or future batches and relative time only to compute speed.
- `credential` is the string from `POST /v2/traffic/credentials`, unchanged.
- There is nothing else. The schema is strict, so a batch carrying an account, device,
  installation, trip, or batch-sequence field is rejected. Speed, heading and accuracy are not
  sent; the app filters poor fixes itself.
- Responses: `202 {"status":"accepted"}` whether or not anything was usable; `400` for a
  malformed or implausible batch; `401` when the credential is invalid or expired; `429` when
  rate limited; `503` when sharing is off, Valhalla is unavailable, or the matcher is busy. The
  app drops the batch in every case and never retries or stores it.

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
7. Stop uploading for the rest of the trip after a `429`, and for five minutes after a `503`.
8. Read `status.probes.accepting` before the first upload of a trip and do nothing when it is
   `false`.
9. Refresh the flow layer at `validUntil` of the last response, not sooner: it cannot change
   before then.

## What the server does with a batch

1. **Network rate limit.** 1,200 batches per ten minutes per network bucket (IPv4 /24, IPv6 /48,
   the same bucket community reports use), held as a salted in-memory fingerprint. It exists to
   stop a flood from one network, not to count contributors.
2. **Credential.** Open the credential; refuse with `401` if it is forged, expired, or from
   another process. Only a valid credential draws on the per-installation limit (30 per ten
   minutes) and the global limit (6,000 per ten minutes), so junk cannot exhaust what real
   drivers need.
3. **Plausibility.** The batch's last point (`capturedAt` plus the last offset) must be no more
   than 60 s ahead of the server clock and no more than 10 minutes behind it. Every point must be
   inside the Alberta and British Columbia box, and no two consecutive points may be more than
   60 m/s apart.
4. **Server-side trim.** Drop every point within 100 m of path of either end of the batch. The
   server cannot tell which batch began or ended a trip, so it treats every batch as if it might
   have. A batch with fewer than five points left is accepted and ignored.
5. **Map match** the remaining points with `trace_attributes` (`map_snap`) on the local Valhalla.
   A fix that Valhalla snapped from more than 35 m away counts as unmatched.
6. **Derive samples.** For each stretch the batch drove on one way and direction, speed is
   distance along the matched edges between the first and last point there, divided by the
   elapsed time. A sample needs at least 5 s and either 100 m of travel or 30 s (so a crawl
   counts and two stationary fixes do not). Speeds above 180 km/h are dropped. That speed is
   credited to every **whole edge** of the stretch; the partly driven first and last matched
   edge of a batch are never credited.
7. **Add to cohorts.** One sample per contributor per edge joins that edge's pending cohort,
   stamped with the publication epoch in which it **arrived** (server clock). Nothing in the
   batch decides which epoch it counts in. A contributor already in the cohort is ignored.
8. **Discard.** The points, the match, the credential and the source address go out of scope.
   None of them is written to the database, a queue, a file, or the API log. Errors from
   Valhalla are counted, never logged, because they can quote request content.

### Which roads

Only `motorway`, `trunk`, `primary` and `secondary` roads whose use is `road`, `ramp` or
`turn_channel` are aggregated. The list is fixed in code and cannot be configured. Tertiary,
unclassified and residential roads, living streets, service roads, driveways, tracks, alleys and
parking aisles are excluded after matching, whatever the app sent. This is how long rural
driveways and cul-de-sacs are kept out: they are not through roads. Tertiary roads are excluded
for now because a sparse rural tertiary road can identify a household even at three contributors,
and the server has no density or catchment signal it can check.

Not enforced:

- **Access tags.** Valhalla 3.8.2 does not return `destination_only` from `trace_attributes`
  (checked against a real instance), so a private or destination-only road is excluded only when
  it is mapped as one of the excluded classes or uses, which is the usual case. A secondary road
  tagged `access=private` would be aggregated.
- **Dead-end components, population density, household catchment.** Not checked.
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
  only when three installations drove that edge end to end.
- **Geometry cannot be influenced by a batch.** The key commits to the geometry, which is map
  data. Every contributor who drives an edge derives the same key and the same line; a cohort
  keeps the line it was created with. There is no geometry update, before or after
  de-duplication.
- **The same key comes out of route walking.** `edge_walk` over a route returns the same edge
  shapes, so route traffic looks up the same keys (verified against recorded Valhalla responses).
- **No graph-internal id.** Valhalla's edge id would be shorter but means nothing outside one
  graph build.

Cost: an edge is short, so speed is measured over the batch's run on the way and credited to its
whole edges, and edges where batches happen to begin and end are credited less often. A way
edited in OpenStreetMap, or re-split by a new graph build, gets new keys; because the API erases
all releases on every start and the graph is only replaced with a restart of the stack, old keys
do not outlive a graph. A graph swapped without restarting the API would leave releases keyed to
the old graph for up to 15 minutes; the deployment procedure restarts the API.

The free-flow reference is the Valhalla speed of that edge (from `maxspeed` and the
OpenStreetMapSpeeds defaults NavOSS builds with).

## Aggregation and publication

| Parameter                | Value            | Configurable                            |
| ------------------------ | ---------------- | --------------------------------------- |
| Epoch                    | 300 s            | No                                      |
| Cohort lifetime          | 900 s            | No                                      |
| Release lifetime         | 900 s            | No                                      |
| Minimum contributors (k) | 3                | Upward only (3 to 50)                   |
| Published speed step     | 5 km/h           | No                                      |
| Congestion levels        | 0.70, 0.45, 0.20 | No (`free`, `slow`, `heavy`, `stopped`) |

- **Cohort.** Per edge, the set of contributors that have a pending sample: one speed each,
  whichever of their batches arrived first. Held in API process memory only.
- **Epoch boundary.** Every five minutes on the clock, the server closes the epoch: it drops
  pending samples whose arrival epoch started more than 15 minutes before the boundary, then
  releases every edge whose cohort holds at least k contributors.
- **Release.** One value: the median of the cohort's speeds, rounded to 5 km/h, with the
  boundary as its `observedAt` and an expiry 15 minutes later. The cohort is then consumed. A
  later change to that edge needs a new cohort of k; a single further contributor changes
  nothing that is published.
- **Estimator and threshold use the same cohort.** One contributor has one weight, so replaying
  a trace with different timestamps, or uploading every minute, adds nothing. With k = 3 the
  median follows two of three contributors.
- **Immutability.** Flow and route traffic read "as of the current epoch": a release is visible
  from its boundary until the boundary at which it expires. Between boundaries nothing changes,
  whatever arrives. No response carries a contributor or sample count.
- **Expiry.** A release disappears on schedule, not because of any individual: 15 minutes after
  its boundary, unless a new cohort replaced it first. The row is deleted at that boundary; if
  that job fails the row is still not served, and the failure is logged.
- **Collect mode.** Cohorts are formed, counted for the operator, and thrown away at the
  boundary. Nothing is written to the database and nothing is served.

### Storage

`traffic_releases` (migration `0002_community_traffic` in the shared runner,
`apps/api/src/migrations.ts`) holds published values only: segment key, road class, speed, free
flow, the two epoch boundaries, and the edge geometry. Database constraints restrict the road
class to the four aggregated classes, the speed to 5 km/h steps, `released_at` to the five-minute
grid and the lifetime to 15 minutes.

- Nothing below the threshold is ever written. The database after two contributors is byte for
  byte the database before any upload (tested with a full dump including `xmin` and `ctid`).
- All releases of an epoch are written in one statement in one transaction, in key order. Row
  versions and physical order identify the epoch, not an upload.
- The table is `UNLOGGED`, so releases are not in the write-ahead log, are not replicated, and
  are lost on a database crash. They are excluded from `backup-reports-db.sh`.
- Every API start erases the table, in every mode including `off`. With the mode `off` the API
  waits at most three seconds for that and then starts anyway, so a stuck database cannot keep
  the production API down; a failed purge is logged. Database connections and statements for
  this table are bounded at 5 s and 10 s.

Run a **single API container**. Cohorts, keys and rate limits are per process: a second replica
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
- At most 3,000 features, major roads first; `truncated` says when the cap was hit.
- `503` unless the mode is `live`. An empty `features` array is a normal answer.

### `GET /v2/traffic/status`

`mode` (`off`, `collecting`, `live`), the upload rules (`probes.*`, including
`credentialEndpoint`, `batchTrimMeters` and `tripEndTrimMeters`) and the publication rules
(`publication.epochSeconds`, `cohortSeconds`, `releaseSeconds`, `minimumContributors`). It
reports **no totals**. Service-wide counts of observed segments and samples were removed: read
before and after an upload, they told a caller whether a road had already been driven. Operator
metrics (batch counters, pending samples and segments, released segments, failures) are logged
every 15 minutes as `Community traffic summary` and are not reachable over HTTP.

### Route traffic

`trafficService.enrichRoutes(routes)` takes the routes the routing layer computed and returns
them with traffic applied. **It has no HTTP surface yet**: `/v1/routes` is frozen for shipped
clients and never carries traffic fields, and `/v2/routes` lives on another branch. It is a
self-contained function plus schema fragments (`RouteTrafficAnnotationSchema`,
`RouteCongestionLevelSchema`, `CommunityTrafficSourceSchema`).

If anything is published inside the routes' bounding box, it resolves **every** route's geometry
to edges with `trace_attributes` (`edge_walk`, one request per 100 km, sequential, at most
twelve), looks up published speeds for those edges, and:

- if published edges cover at least `COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE` (50%) of a route's
  length, sets `traffic.delaySeconds`, `traffic.typicalDurationSeconds` (the routing engine's
  duration), `traffic.observedFraction`, an adjusted `durationSeconds`, adjusted step durations,
  and `congestion`: one of `unknown`, `free`, `slow`, `heavy`, `stopped` per geometry segment;
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
  engine order uses) **and** it does not use more than 100 m more minor-road distance than the
  route it overtakes. Minor means any class below tertiary: residential, unclassified, service.
  A route that could not be walked has unknown roads and is never promoted. Traffic can
  therefore swap one through-road route for another, but it is never the reason a driver is
  sent down residential or service streets.

`label` still marks the route with the lowest adjusted duration; the order is the
recommendation. When at least one route was adjusted the result carries `trafficSource`
(`navoss-community`). Any failure leaves every route untouched.

**Merge seam for `/v2/routes`** (unchanged by this revision):

1. Call `trafficService.enrichRoutes(routes)` in the v2 handler and return its `routes`.
2. When `trafficSource` is set, put it on `source.trafficSource` and report
   `source.traffic: "live"`.
3. The v2 route schema needs optional `route.congestion` (aligned to geometry segments, includes
   `unknown`), `route.traffic.{delaySeconds, observedFraction, typicalDurationSeconds}` and
   `source.trafficSource`, and must allow routes without `traffic` under a live community source.
4. `trafficService` is a local in `buildApp`; the v2 handler needs it in scope.
5. Clients must present routes in the returned order and must not re-sort by duration, or the
   ranking bound is lost.

### Config

`features.liveTraffic` in `/v2/config` is `true` only when the mode is `live` (or the licensed
Mapbox provider is active). `collect` does not set it. `/v1/config` is frozen and reports the
licensed provider only.

## What this does not protect against

| Threat                                              | What the code does                                                                                                                                                                                             | What remains                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-identifying home or work from the ends of a trip | The server drops 100 m from both ends of every batch, never credits a partly driven edge, and aggregates only motorway to secondary roads. The app is required to exclude 400 m at both trip ends              | The 400 m rule is not verifiable by the server. A home on a secondary-or-larger road is on an aggregated edge, protected by the threshold only                                                                                   |
| A published edge implies who drove it               | Three attested installations in one cohort; edge-level threshold; tertiary and lower roads excluded; no counts published                                                                                       | Three installations can be one household, or one person with three App Attest keys. Publication reveals that the edge was driven by at least three installations in the 20 minutes before a boundary, and a 5 km/h-coarse median |
| Differencing between responses                      | Releases happen only at epoch boundaries, each from a consumed cohort of at least k; expiry is on a fixed schedule                                                                                             | An observer learns "at least k new contributions arrived on this edge before this boundary". That is a group fact, not an individual one, but on a quiet road the group may be guessable                                         |
| Collusion: k-1 of a cohort are the attacker         | Median of the cohort, 5 km/h steps                                                                                                                                                                             | With k = 3, two attacker installations bracket the third contributor: its presence on the edge in that window and its approximate speed are inferable. No threshold scheme prevents this                                         |
| Fabricated traffic                                  | Uploads need an attested installation; one installation one weight; plausibility bounds; per-installation and per-network rate limits; median; route delay cap and ranking bound                               | Three attested keys, which one ordinary iPhone can create, publish a false speed on an edge. It can lengthen an ETA by up to 100% and swap through-road alternatives; it cannot route drivers onto minor roads                   |
| Linking batches into a trip                         | No trip or sequence id; minute-coarse start; nothing raw retained; per-edge tags                                                                                                                               | Batches of one trip carry the same credential and come from the same address, so the API process and Cloudflare can link them while they arrive. Adjacent positions link consecutive batches anyway                              |
| Database or backup disclosure                       | The database holds published releases only, in an unlogged table excluded from backups                                                                                                                         | A leak shows which major-road edges were published in the last 15 minutes: what the flow endpoint already serves. The installation table shows when each installation last made an attested request                              |
| Process memory disclosure                           | Keys and cohorts are memory-only; cohorts hold tags and speeds for at most 20 minutes                                                                                                                          | With memory and the installation table, an installation can be matched to the edges it has pending samples on                                                                                                                    |
| Location leaking through logs                       | API request logging is off; handlers log nothing from the body; matcher errors are swallowed; the summary has counters only; a test ingests batches, forces failures and scans the database and API log output | **Not established for anything but the API process**: whether Valhalla logs request bodies, whether Caddy logs headers on proxy errors, swap, and core dumps. See below                                                          |
| Viewport disclosure through flow requests           | Bounds snapped to a 0.05° grid, comparable to a map-tile request                                                                                                                                               | The request still shows which ~4 km cell is on screen, as tile requests already do                                                                                                                                               |
| Traces sent to a third party                        | The matcher endpoint must be loopback, a private or link-local address literal, or a single-label host name (a Compose service); redirects are refused                                                         | An operator can still run a forwarding proxy at a local address                                                                                                                                                                  |

Unproven, and to be established before `live`:

- **Valhalla request logging.** The matcher receives trimmed positions and relative times.
  Whether the production Valhalla container writes request bodies to journald has not been
  checked on the production host.
- **Proxy, swap and crash artifacts.** Caddy access logging is off, but error-path logging of
  headers (which include the client address) and the absence of swap and core dumps for the API
  and Valhalla have not been verified.
- **Map-match quality.** Apart from the 35 m snap limit, a poor match is accepted as Valhalla
  returns it. Real GPS traces have not been run through the pipeline.
- **Raw batch lifetime in memory.** The batch lives in the request body, local arrays and the
  matcher request until garbage collection; it is not zeroed, and the matcher request has a
  four-second timeout rather than a hard bound on that lifetime.
- **Behaviour on an Alberta/BC graph, under load, and behind Cloudflare and Caddy.** Tested
  against Valhalla 3.8.2 on a Liechtenstein extract only.

## Retention

| What                                             | Where                                    | How long                                                                                          |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Uploaded positions, offsets, `capturedAt`        | Request memory                           | Until the request finishes (not zeroed)                                                           |
| Pending sample: tag, speed, arrival epoch        | API process memory                       | Until released, or dropped at the first boundary more than 15 min after its epoch: at most 20 min |
| Release: edge, speed, boundaries, edge geometry  | `traffic_releases`                       | Deleted at the boundary 15 min after release; erased on every API start                           |
| Credential and seed                              | Phone memory; never stored by the server | Credential valid 2 h; unusable after an API restart                                               |
| Network and installation rate-limit fingerprints | API process memory                       | Salted hash and request times; removed within 11 minutes of the last request; cleared on shutdown |

Everything derived from a batch is therefore gone within 35 minutes of its arrival, provided the
epoch job runs; a failed job is logged (`Community traffic maintenance failed`) and its rows are
not served. A batch may describe driving up to 10 minutes before it arrived.

## Configuration

| Variable                                                                      | Default               | Notes                                                                            |
| ----------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `COMMUNITY_TRAFFIC_MODE`                                                      | `off`                 | `off`, `collect` (form cohorts, publish and store nothing), `live`               |
| `VALHALLA_TRACE_URL`                                                          | from `VALHALLA_URL`   | `trace_attributes` endpoint; must be a local endpoint when the mode is not `off` |
| `COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS`                                          | `3`                   | 3 to 50                                                                          |
| `COMMUNITY_TRAFFIC_TRIP_TRIM_METERS`                                          | `400`                 | 400 to 2,000; advertised to the app                                              |
| `COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE`                                        | `0.5`                 | 0.1 to 1                                                                         |
| `COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL`                                         | `6000`                | Authenticated batches per 10 minutes                                             |
| `COMMUNITY_TRAFFIC_BOUNDS`                                                    | Alberta + BC          | `west,south,east,north`; for local testing against another graph                 |
| `APP_ATTEST_*`, `COMMUNITY_ATTESTATION_MODE`, `COMMUNITY_INSTALLATION_SECRET` | see community reports | Required for uploads: without them no credential is issued                       |
| `PGHOST` and the other `PG*` variables                                        | unset                 | Unset uses an in-memory release store, and no attestation, for development only  |

The privacy limits are enforced when the service is built (`assertTrafficPrivacyLimits`), not
only when the environment is read: k below 3, a trip trim below 400 m, a batch trim below 100 m,
an epoch below 300 s, or a cohort or release lifetime above 900 s make the API refuse to start.
The epoch, the lifetimes, the batch trim and the road classes have no environment variable.

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

- `apps/api/test/traffic-logic.test.ts`: trimming, plausibility (including the last-point future
  check), credentials, cohorts (threshold, one weight per contributor, consumed cohorts,
  per-edge threshold, immutable geometry, retention), privacy limits, observation derivation
  (road classes, the first-edge sliver), route delay cap and ranking bound, the matcher
  (redirects, snap distance, endpoint allowlist) and the multi-request walk of a 260 km route,
  with no external service.
- `apps/api/test/traffic-app.test.ts`: the HTTP surface, modes, credentials, rate limiting,
  epoch-immutable flow, the total-free status and route enrichment on the in-memory store.
- `apps/api/test/traffic-postgres.test.ts`: the same pipeline on PostGIS with the shared
  migration runner, including: nothing stored below the threshold, one transaction per epoch, no
  uploaded position, address or credential in the database or API log, purge on start in every
  mode, and credentials issued against real installation rows with a test App Attest authority.
  It needs PostGIS on `127.0.0.1:5442` (or `NAVOSS_TRAFFIC_TEST_DATABASE_URL`) and skips when
  that is not reachable unless `NAVOSS_REQUIRE_TEST_DATABASE=1`:

  ```sh
  docker run -d --name api-traffic-postgis -p 127.0.0.1:5442:5432 \
    -e POSTGRES_DB=navoss -e POSTGRES_USER=navoss -e POSTGRES_PASSWORD=navoss \
    postgis/postgis:16-3.5-alpine
  ```

- Valhalla is stubbed with responses recorded from Valhalla 3.8.2
  (`apps/api/test/fixtures/traffic-drive.json`); the long-route walk uses a synthetic matcher.
- `corepack pnpm --filter @navoss/api traffic:replay` registers development installations
  against a local API with PostGIS and Valhalla, replays a synthetic drive, and fails unless
  edges stay hidden for two installations (however often one of them uploads, from whatever
  network) and until the epoch closes, then appear at the boundary after the third. It needs
  `COMMUNITY_ATTESTATION_MODE=allow-development` and takes five to ten minutes because it waits
  for real epoch boundaries; the script header lists the commands.
