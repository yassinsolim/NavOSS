# Community traffic

Decision date: 2026-11-12

NavOSS builds its own live traffic from the speeds of drivers who switch traffic sharing on. There
is no paid provider and, after review, no usable official flow feed for Alberta or British Columbia
(see [`../data-sources.md`](../data-sources.md#community-traffic)). This document describes the
server pipeline as built, the contract the app must follow, the threat model, and what is
deliberately left for later.

Status: the server is implemented and off by default (`COMMUNITY_TRAFFIC_MODE=off`). No released
app uploads anything yet. The phone switch, the upload client, the map layer and the `/v2/routes`
wiring are later work. With few contributors very little will be published; the service says how
much data backs the layer instead of filling gaps.

## Pipeline

```text
phone (sharing on, navigating)
  └─ POST /v1/traffic/probes   one short batch: positions + relative seconds, no identity
        │  schema check, rate limit, plausibility, trim 100 m off both ends
        ▼
   Valhalla trace_attributes   self-hosted, in-memory, same host
        │  matched edges: OSM way id, direction, class, edge speed, road geometry
        ▼
   one speed sample per road segment   distance along edges / elapsed time
        │  the batch is dropped here; it was never written or logged
        ▼
   PostGIS   traffic_segments (road geometry) + traffic_flow_buckets (5-minute histograms)
        │  published only with >= 3 independent contributors in the last 30 minutes
        ▼
   GET /v1/traffic/flow    GeoJSON for a MapLibre line layer
   GET /v1/traffic/status  mode, upload rules, service-wide coverage
   enrichRoutes()          delay, adjusted ETA and per-segment congestion for /v2/routes
```

Code lives in `apps/api/src/traffic/`; contracts in `packages/contracts/src/traffic.ts`.

## What the app sends

`POST /v1/traffic/probes`

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-11-12T18:04:00Z",
  "points": [
    [-114.06312, 51.04471, 0],
    [-114.06281, 51.04492, 2]
  ]
}
```

- `points` are `[longitude, latitude, seconds since the first point]`: 10 to 240 points, the first
  at offset 0, offsets whole seconds rising by 1 to 15, at most 300 seconds in total.
- `capturedAt` is the UTC time of the first point rounded down to the minute. The server needs
  absolute time only to pick a five-minute bucket and relative time only to compute speed.
- There is nothing else. The schema is strict, so a batch carrying an account, device,
  installation, trip, or batch-sequence field is rejected. Speed, heading and accuracy are not
  sent; the app filters poor fixes itself.
- Responses: `202 {"status":"accepted"}` whether or not anything was usable; `400` for a
  malformed or implausible batch; `429` when rate limited; `503` when sharing is off, Valhalla or
  the database is unavailable, or the matcher is busy. The app drops the batch in every case and
  never retries or stores it.

### Client rules

The server advertises these in `GET /v1/traffic/status` (`probes.*`) so they can be tuned without
an app release. The app must:

1. Upload only while turn-by-turn navigation is active and the user's traffic-sharing switch is
   on. The switch is off by default. Turning it off, ending navigation, or arriving stops
   collection and discards everything still in memory.
2. Trim trip ends by `tripEndTrimMeters` (400 m):
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
   moving traffic and one every five minutes in a crawl.
5. Keep batches in memory only. Never write them to disk, never retry later, never attach an
   identifier, and send them with the same anonymous transport as every other API call.
6. Stop uploading for the rest of the trip after a `429`, and for five minutes after a `503`.
7. Read `status.probes.accepting` before the first upload of a trip and do nothing when it is
   `false`.

## What the server does with a batch

1. **Rate limit** per source network (60 batches per 10 minutes) and globally (6,000 per 10
   minutes), using the same salted in-memory fingerprint as beta feedback.
2. **Plausibility.** Reject batches older than 15 minutes or more than 2 minutes in the future,
   outside the Alberta and British Columbia box, or containing a jump faster than 60 m/s.
3. **Server-side trim.** Drop every point within 100 m of path of either end of the batch. The
   server cannot tell which batch began or ended a trip, so it treats every batch as if it might
   have. A batch with fewer than five points left is accepted and ignored.
4. **Map match** the remaining points with `trace_attributes` (`map_snap`) on the self-hosted
   Valhalla. The API refuses to start in `collect` or `live` mode against a public Valhalla.
5. **Derive samples.** For each road segment the batch drove, speed is distance along the matched
   edges between the first and last point on that segment, divided by the elapsed time. A sample
   needs at least 5 s on the segment and either 100 m of travel or 30 s (so a crawl counts and two
   stationary fixes do not). Speeds above 180 km/h are dropped.
6. **Record** one sample per segment into its five-minute bucket, unless this contributor already
   has one there.
7. **Discard.** The points, the match and the source address go out of scope. None of them is
   written to the database, a queue, a file, or a log. Errors from Valhalla and PostgreSQL are
   counted, never logged, because they can quote request content.

Only `motorway`, `trunk`, `primary`, `secondary` and `tertiary` roads (including their ramps and
turn channels) are aggregated. Residential streets, service roads, driveways and parking aisles
are where trips start and end; they are ignored outright.

## Segment key

A segment is an **OpenStreetMap way in one direction of travel**: `w<way id><f|b>`, for example
`w142596972b`. `f` means travel along the way's node order.

Why this and not the alternatives:

- A Valhalla edge id is exact but changes with every graph build and means nothing outside
  Valhalla. OSM way ids survive graph rebuilds and can be checked by hand on openstreetmap.org.
- An OpenLR or SharedStreets-style reference needs the full geometry of every edge, including
  edges a batch only partly covered. `trace_attributes` does not give that for the first and last
  edge, so it would need a second lookup per batch for a property (cross-map portability) NavOSS
  does not need: both producer and consumer use the same OSM-derived graph.
- A way is coarser than an edge. With few contributors that is an advantage: more drivers share
  each segment, so more segments reach the publication threshold, and a single segment says less
  about where one car turned.

The cost is resolution. A long rural way has one speed, so a short queue on it is diluted. A way
edited in OSM gets a new id after the next graph build, which only matters for a few minutes of
live data. Sub-way linear referencing can be added later without changing the public contract,
which exposes geometry and an opaque `id`.

Segment geometry for the map layer is the OSM road geometry Valhalla returns for edges a batch
drove from end to end. A partly driven first or last edge would start or stop where the trace
did, so it contributes speed but never geometry. A segment is not published until some geometry
is known.

## Aggregation and publication

| Parameter                | Default           | Meaning                                                    |
| ------------------------ | ----------------- | ---------------------------------------------------------- |
| Bucket                   | 300 s             | Time resolution of everything stored                       |
| Window                   | 1,800 s           | How far back a sample still counts                         |
| Half-life                | 600 s             | A sample's weight halves for every 10 minutes of age       |
| Minimum contributors (k) | 3                 | Independent contributors in the window before publication  |
| Histogram                | 90 bins of 2 km/h | Per segment and bucket; the only form speeds are stored in |
| Congestion levels        | 0.70, 0.45, 0.20  | Speed over free flow: `free`, `slow`, `heavy`, `stopped`   |

- **Sample count** is the number of contributor samples in the window.
- **Speed** is the weighted median of the window's histograms. The median ignores an outlier and
  the decay lets a clearing jam fade before its buckets expire.
- **Free-flow reference** is the Valhalla edge speed (which comes from `maxspeed` and the
  OpenStreetMapSpeeds defaults NavOSS builds with), length-weighted over the segment's edges. The
  posted limit is stored when Valhalla has one.
- **Freshness** is the end of the newest bucket, so it is five-minute coarse by construction.
- **Expiry.** Reads ignore buckets older than the window. A sweeper deletes buckets 35 minutes
  after they start and then deletes segments with no bucket left, so the database holds no record
  of a road nobody has driven in the last half hour.

### Independent contributors without identity

Publication needs a count of distinct contributors, and NavOSS has no account or installation id.
The server derives a **contributor token** per segment: the first 8 bytes of
`HMAC-SHA256(key, network + segment key)`, where `network` is the IPv4 address or IPv6 /64 the
request came from and `key` is 32 random bytes generated when the API process starts.

- The key exists only in process memory. It is never written, logged, or configurable.
- The token is scoped to one segment, so one driver has unrelated tokens on different roads and
  tokens cannot be joined into a path.
- Tokens are stored sorted inside the bucket row and deleted with it.
- A restart generates a new key, so stored tokens become meaningless. The API therefore empties
  both traffic tables on start rather than risk counting one driver twice.
- A contributor adds at most one sample per segment per bucket.

The threshold is enforced inside the store's read queries: rows below it, or without geometry, are
never returned to application code, in the flow endpoint or in route enrichment. `k` cannot be
configured below 2.

This counts networks, not people. Several phones behind one carrier NAT count once, which only
delays publication. It is not strong against a deliberate attacker; see the threat model.

## Serving

### `GET /v1/traffic/flow?bbox=west,south,east,north`

- Every bound must be a multiple of 0.05° and each span at most 2°. The app expands its viewport
  outward with `snapTrafficFlowBounds` from `@navoss/contracts`. This keeps an exact viewport out
  of the URL and makes responses shareable: `cache-control: public, max-age=30`.
- The response is a GeoJSON `FeatureCollection` usable directly as a MapLibre `geojson` source.
  Each feature is a `MultiLineString` with `congestion`, `speedKph`, `freeFlowKph`, `sampleCount`,
  `observedAt` and `ageSeconds`. Top-level members carry `source` (id `navoss-community`,
  attribution "Traffic from opted-in NavOSS drivers"), `generatedAt`, and `coverage`
  (`minimumContributors`, `windowSeconds`, `publishedSegments`, `truncated`).
- At most 3,000 features, major roads first; `truncated` says when the cap was hit.
- `503` unless the mode is `live`. An empty `features` array is a normal answer.

### `GET /v1/traffic/status`

`mode` (`off`, `collecting`, `live`), the upload rules, the publication rule, and in `live` mode
service-wide `coverage`: `publishedSegments`, `observedSegments` (including those below the
threshold), and `samples`. Counts below the threshold are only ever reported service-wide, never
per area, because "one car was observed in this box" is itself a location.

### Route traffic

`trafficService.enrichRoutes(routes)` takes the routes the routing layer computed and returns
them with traffic applied. It is the seam for `/v2/routes`; `/v1/routes` is frozen for shipped
clients and never carries traffic fields.

For each route it checks whether anything is published near the route, resolves the route's own
geometry to edges with `trace_attributes` (`edge_walk`), looks up published speeds for those
segments, and:

- if published segments cover at least `COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE` (50%) of the route's
  length, sets `traffic.delaySeconds`, `traffic.typicalDurationSeconds` (the routing engine's
  duration), `traffic.observedFraction`, an adjusted `durationSeconds`, adjusted step durations,
  and `congestion`: one of `unknown`, `free`, `slow`, `heavy`, `stopped` per geometry segment;
- otherwise returns the route untouched, which means **traffic is unavailable for that route**.

Delay is counted only below the free-flow band. An observed speed includes signals and turns the
routing engine already charges for, so a `free` segment adds nothing and a slower one adds only
its time beyond 70% of free flow. Delay is never negative and a standstill is bounded at 3 km/h.
Routes are re-ranked on adjusted durations. When at least one route was adjusted the result
carries `trafficSource` (`navoss-community`); the v2 response should then report
`source.traffic: "live"`. Any failure leaves every route untouched.

`RouteTrafficAnnotationSchema` and `CommunityTrafficSourceSchema` in the contracts package are the
schema fragments for these fields.

### Config

`features.liveTraffic` in `/v2/config` is `true` only when the mode is `live` (or the licensed
Mapbox provider is active). `collect` does not set it. `/v1/config` is frozen and reports the
licensed provider only.

## Threat model

| Threat                                                                            | Mitigation                                                                                                                                                                                                                                                                             | Residual risk                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-identifying home or work from the ends of a trip                               | The app excludes 400 m at both ends and holds back its latest 400 m; the server drops 100 m from both ends of every batch; minor roads are never aggregated; a partly driven edge never contributes geometry; nothing is stored per trip                                               | A home on a tertiary-or-larger road more than 400 m from where navigation starts is on an aggregated segment, protected by the threshold only                                                                    |
| Low-density roads: a published segment implies who drove it                       | Three independent contributors within 30 minutes; way-level segments; no per-area count of unpublished segments                                                                                                                                                                        | On a quiet road three contributors may be a known small group. Publication reveals that the road was driven in the window, and a typical speed, not who or exactly when                                          |
| Single-contributor segments                                                       | Never published, never used for route traffic, deleted within 36 minutes                                                                                                                                                                                                               | They exist in the database, without identity or position, until they expire                                                                                                                                      |
| Linking batches into a trip                                                       | No trip, device, or sequence id; minute-coarse start time; per-segment tokens; nothing raw retained                                                                                                                                                                                    | Whoever can observe live requests (the operator, Cloudflare) could link consecutive batches from one address by time and position while they arrive. That is inherent to any upload and is why nothing is logged |
| Database or backup disclosure                                                     | Tables hold road geometry from OSM, five-minute histograms and keyed tokens; rows are excluded from backups; journald has no request data                                                                                                                                              | A leak shows which major roads had contributors in the last half hour                                                                                                                                            |
| Database plus process memory disclosure                                           | Key is memory-only and rotates on restart; tokens are per segment                                                                                                                                                                                                                      | An attacker with both could test whether a given address contributed to a given segment in the retained window                                                                                                   |
| Differencing: an attacker who is k-1 of the contributors learns the other's speed | Median over a histogram with 2 km/h bins; one sample per contributor per bucket                                                                                                                                                                                                        | With k = 3 and two colluding networks the third contributor's approximate speed on that segment is inferable                                                                                                     |
| Fabricated traffic (fake jams) or sybil contributors to force publication         | Rate limits; plausibility bounds; coverage box; network-level contributor counting; median resists a minority of bad samples                                                                                                                                                           | An attacker with three networks can publish false speeds for a segment. App Attest, which the community-reports work introduces, should gate probe uploads before this layer is relied on for routing            |
| Location leaking through logs or metrics                                          | Request logging is off; handlers log nothing from the body; matcher and storage errors are swallowed; the periodic summary has counters and segment counts only; a test ingests batches, forces failures, and scans the database and log output for any uploaded coordinate or address | New code paths must keep to this; the test covers the paths that exist                                                                                                                                           |
| Viewport disclosure through flow requests                                         | Bounds snapped to a 0.05° grid, comparable to a map-tile request                                                                                                                                                                                                                       | The request still shows which ~4 km cell is on screen, as tile requests already do                                                                                                                               |

## Configuration

| Variable                                  | Default             | Notes                                                                       |
| ----------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `COMMUNITY_TRAFFIC_MODE`                  | `off`               | `off`, `collect` (aggregate, publish nothing), `live`                       |
| `VALHALLA_TRACE_URL`                      | from `VALHALLA_URL` | `trace_attributes` endpoint; must be self-hosted when the mode is not `off` |
| `COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS`      | `3`                 | 2 to 50                                                                     |
| `COMMUNITY_TRAFFIC_WINDOW_SECONDS`        | `1800`              | 300 to 7,200; also bounds retention (window + one bucket)                   |
| `COMMUNITY_TRAFFIC_BUCKET_SECONDS`        | `300`               | 60 to 900                                                                   |
| `COMMUNITY_TRAFFIC_HALF_LIFE_SECONDS`     | `600`               | 60 to 3,600                                                                 |
| `COMMUNITY_TRAFFIC_TRIP_TRIM_METERS`      | `400`               | 200 to 2,000; advertised to the app                                         |
| `COMMUNITY_TRAFFIC_BATCH_TRIM_METERS`     | `100`               | 50 to 1,000; server-side trim of every batch                                |
| `COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE`    | `0.5`               | 0.1 to 1                                                                    |
| `COMMUNITY_TRAFFIC_RATE_LIMIT_PER_SOURCE` | `60`                | Batches per source network per 10 minutes                                   |
| `COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL`     | `6000`              | Batches per 10 minutes                                                      |
| `COMMUNITY_TRAFFIC_BOUNDS`                | Alberta + BC        | `west,south,east,north`; for local testing against another graph            |
| `PGHOST` and the other `PG*` variables    | unset               | Unset uses an in-memory store, for development only                         |

The schema is migration `0001_community_traffic` in `apps/api/src/traffic/migrations.ts`, tracked
in `traffic_schema_migrations`. The API applies it on start when the mode is not `off`;
`node dist/traffic/migrate.js` applies it explicitly. Deployment steps are in
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
   `segment_key -> edge ids` table keyed by the graph's `tileset_last_modified`, dropped when the
   graph changes.
4. Add a writer sidecar: every minute it reads the published segments (the same
   threshold-enforcing query the flow endpoint uses), writes speed and congestion for their
   edges, and clears every edge it wrote earlier that is no longer published. Only published
   segments may ever be written.
5. Send `date_time: {type: 0}` on route requests, rerun the route-quality gates with and without
   the extract, and keep a switch that empties the extract.
6. Once Valhalla costs with live speeds, stop adding delay in `enrichRoutes` for those edges, or
   the same slowdown is counted twice.

Nothing for this is wired today. `traffic_name` stays blank in `infra/compose/compose.yaml`, no
edge ids are stored, and there is no exporter. The seam is the store's published-segment queries.
Historical speed profiles (Valhalla's predicted traffic) would need long-term retention and are
out of scope for the same privacy reasons that keep retention at half an hour.

## Testing

- `apps/api/test/traffic-logic.test.ts`: trimming, plausibility, aggregation, the threshold,
  classification, contributor tokens, observation derivation and route adjustment, with no
  external service.
- `apps/api/test/traffic-app.test.ts`: the HTTP surface, modes, rate limiting and route
  enrichment on the in-memory store.
- `apps/api/test/traffic-postgres.test.ts`: the same pipeline on PostGIS, including the proof
  that no uploaded position, address or fine timestamp is stored or logged. It needs PostGIS on
  `127.0.0.1:5442` and skips when that is not reachable:

  ```sh
  docker run -d --name api-traffic-postgis -p 127.0.0.1:5442:5432 \
    -e POSTGRES_DB=navoss -e POSTGRES_USER=navoss -e POSTGRES_PASSWORD=navoss \
    postgis/postgis:16-3.5-alpine
  ```

  The image has no arm64 build; on Apple Silicon add `--platform linux/amd64`.

- Valhalla is stubbed with responses recorded from Valhalla 3.8.2
  (`apps/api/test/fixtures/traffic-drive.json`).
- `corepack pnpm --filter @navoss/api traffic:replay` replays a synthetic drive from several
  simulated contributors against a local API and fails unless segments stay hidden below the
  threshold and appear at it.
