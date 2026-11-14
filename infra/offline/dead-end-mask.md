# Community-traffic dead-end mask

Valhalla marks `not_thru` only within a bounded search, so a dead-end valley with its own road
network is a through road to it (Alberta 66 and 546, BC 4 and 37A were confirmed undetected on the
2026-11-11 graph). The dead-end mask closes that gap. It is built offline from the **same dated
extract as the routing graph**, bound to that graph's id, and read by the API, which publishes an
edge only when the mask places the edge's whole map geometry on the main road network.

The mask is a precondition for `COMMUNITY_TRAFFIC_MODE=live`. It does not change trip collection,
and it does not enable anything: traffic stays `off` until the rest of the
[enablement checklist](../../docs/architecture/community-traffic.md#enablement-checklist) is done.

## Build

```sh
node --import tsx infra/offline/dead-end-mask.mts \
  --inputs artifacts/offline/inputs/261111 \
  --graph artifacts/offline/graphs/<graph cache key> \
  --output artifacts/dead-end-mask
```

- `--inputs` is an offline-pipeline input directory: the merged
  `alberta-british-columbia-YYMMDD.osm.pbf`, its `SHA256SUMS` line and `data.json`. The PBF is
  re-hashed against `SHA256SUMS` before use and its date must match `data.json`.
- `--graph` is the connected graph directory the pipeline built from that extract:
  `graph.json` (`graphId`, `dataDate`, engine version) and `connected.tar`, whose SHA-256 must
  equal `graphId`. A graph from another date is refused.
- The extraction runs in the digest-pinned offline builder image (`osmium tags-filter`, then
  `dead-end-extract.py` with pyosmium and numpy), with `--network none`, 2 CPUs and 4 GiB.
  The analysis runs in Node.
- Output: `<output>/<graphId>/dead-end-mask.json` and `build-report.json` (sizes, timings, peak
  memory, summary). `--keep-topology` also keeps the extracted topology for
  `verify/dead-end-mask.mts`; it is province-sized map data and is never committed or deployed.
  All of `artifacts/` is ignored by Git.

Measured on the maintainer's Mac (local, 2026-11-14, extract and graph of 2026-11-11, graph
`eeaa7a1d…1857`):

| Step                                    |     Time | Peak memory                         |
| --------------------------------------- | -------: | ----------------------------------- |
| Verify PBF and graph checksums (2.2 GB) |    1–3 s | streaming                           |
| `osmium tags-filter` (roads, barriers)  |     12 s | not measured                        |
| `dead-end-extract.py`                   |     18 s | 1.34 GB RSS                         |
| Analysis and mask (Node)                |    1.5 s | 0.60 GB RSS (whole builder process) |
| **Total `dead-end-mask.mts`**           | **61 s** |                                     |

1,143,663 topology nodes and 1,448,057 segments from 851,177 car ways. The mask is **418 KB**
(96,402 publishable-class ways, 388 of them with per-interval geometry).

## What counts as a road

`dead-end-extract.py` keeps a way only when a private car may use it at any time:

- `highway` motorway, trunk, primary, secondary, tertiary (and links), unclassified, residential,
  living_street, service, road. Tracks, paths, construction, areas and
  `service=emergency_access` are not roads here.
- Car access is read from the most specific recognised key (`motorcar`, `motor_vehicle`,
  `vehicle`, `access`). `no`, `private`, `agricultural`, `forestry`, `emergency`, `military`,
  `permit`, `restricted`, `residents`, `unknown` and `use_sidepath` remove the way. A value that
  is neither (lane syntax such as BC 99's `motor_vehicle=||no`, typos) is ignored, as a router
  does. Treating it as a closure removed a 13 km Highway 99 carriageway and stranded its ramps.
- A `*:conditional` `no` or `private` restriction (seasonal closures such as the gates on
  Alberta 66 and 546) removes the way: a road closed part of the year is never an exit, and is
  never published.
- `oneway` and the implied one-way of motorways, motorway links and roundabouts give the legal
  directions; reversible or unparseable `oneway` removes the way.
- Ferries count only with explicit car access (`motor_vehicle` or `motorcar` permitting), so
  Vancouver Island joins the mainland through its car ferries, and a passenger ferry is no exit.
- A barrier that stops cars (bollard, block and similar by default; a gate only when its access
  tags restrict cars or it has a conditional closure) splits the road into two separate road ends.

Removing a road can only add single-access regions, never remove one, so every doubtful case
errs towards exclusion. A publishable-class way removed this way is listed in the mask as
excluded.

Topology nodes are OSM nodes shared by two kept ways (or used twice by one), way ends and the
two sides of each stopping barrier. A segment is a stretch of one way between two topology nodes.
Residential and service roads are part of the topology although they are never published,
because the question is whether a region has a second way out, whatever its class.

## Algorithm

All steps are iterative (no recursion) over typed arrays: linear except Lengauer–Tarjan, which
is O(m log n) with simple path compression.

1. **Main network (core).** The biconnected blocks of the undirected graph of two-way roads
   (iterative Hopcroft–Tarjan, parallel roads counted as separate edges). The core is the
   **largest block by road length**: the largest set of junctions joined pairwise by two routes
   that share no junction and are drivable both ways. It is computed, not chosen; no node is
   picked by enumeration order, population or traffic. On the 2026-11-11 graph the core is
   190,645 km of road (223,756 junctions); Victoria and Nanaimo reach it through the car ferries; the
   second-largest block is 2,627 km, so the choice is not close.
2. **Single-access regions.** On the directed graph (one arc per legal direction), immediate
   dominators from a root joined to every core junction, once entering (from the core) and once
   leaving (to the core). A node lies in a single-access region when one junction other than the
   node itself lies on **every route in and every route out**. Its region is grouped by the
   outermost such junction (the _choke_).
   - The two directions of a road are one road: they share junctions.
   - Two roads from the same junction, or a divided road (one carriageway in, one out), are one
     access: the junction or the exit carriageway is on every route.
   - Two roads to two different junctions of the network are two exits.
   - A motorway diverge has a single way in but several ways on, and a merge the reverse; neither
     is a single-access region, so one-way carriageways and ramps stay eligible.
   - Loops and cycles inside a valley change nothing: every route still passes the choke.
3. **Isolated.** A node that cannot reach the core, or cannot be reached from it, is excluded.
4. **Unknown continuation.** A road end outside the Alberta and BC boundaries (Geofabrik ends
   neighbouring roads at a buffer polygon), or a way whose nodes are missing from the extract, is a
   _clipped_ node. A single-access region or isolated component containing one is **unknown**, not
   excluded and never eligible: the road may continue outside the extract and come back, or not.
5. **Road ends.** Multi-source Dijkstra from every _true terminal_ (a road end that is not
   clipped) of a publishable or tertiary road, bounded at 400 m. Any node-to-node interval of a
   publishable way that comes within 400 m of such an end along the network is excluded.
   - Every road end of any class is inside a single-access region and is excluded with it,
     whatever its length. The terminal list only decides how far exclusion spills past that
     region's junction onto roads that also carry through traffic.
   - Spilling from all public road ends (residential, unclassified, service; driveways and parking
     aisles excluded) excluded 32% of the motorway-to-secondary length in Calgary, 46% in
     Edmonton and 60% in Metro Vancouver, i.e. most arterials, without shrinking the set of trips
     behind any published edge. Publishable and tertiary road ends exclude 0.3%, 1.2% and 0.7%.
     The first 400 m of every trip from a residential street remains the app's trip-end trim.
6. **Per way.** Each interval of a publishable way takes the status of its segment (the worse of
   its two end nodes, a closed loop on one junction being a dead end), then the 400 m rule.

## Format (version 1)

One JSON object, `format: "navoss-traffic-dead-end-mask"`, `formatVersion: 1`:

- `graph`: `graphId` (SHA-256 of `connected.tar`), `dataDate`, `routingEngineVersion`;
- `inputs`: the PBF name, its SHA-256, the OSM replication timestamp and the extractor policy
  version;
- `rules`: the core rule, publishable classes, terminal classes and `terminalMeters` (≥ 400);
- `summary`: counts and lengths, for operators;
- `ways`: `eligible`, `excluded` and `unknown` way-id lists (ascending, delta-encoded) for ways
  with one status throughout, and `mixed` entries `[way id, one letter (e, x, u) per node-to-node
interval, delta-encoded 1e-6 longitude/latitude of every node]` for ways whose status changes
  along the way;
- `payloadSha256`: SHA-256 of the `ways` member as written.

The status is per way and applies to both directions (a dead-end road is excluded both ways,
as the graph-flag check already does). The mask holds map data only: way ids and the OSM node
coordinates of 388 ways. Nothing from an upload is in it, and building it reads no upload.

## Runtime

`apps/api/src/traffic/dead-end-mask.ts` reads and validates the mask; `loadConfiguredDeadEndMask`
in `settings.ts` binds it to the configured graph; `createValhallaMapMatcher({ deadEndMask })`
applies it after the class, length and graph access checks.

- **Lookup key.** The edge's OSM way, direction and **whole map geometry**: the trace's own line
  for an edge matched end to end, the whole-edge shape `/locate` returns for a partly matched
  one. Never a position from the batch, and never the `/locate` midpoint (which depends on the
  matched part). The geometry is reversed for a backward edge and matched vertex by vertex
  (±2 × 1e-6°, Valhalla's six-decimal rounding of seven-decimal OSM nodes) against the way's
  nodes; every interval it covers must be eligible.
- **Fail closed.** A way not in the mask, geometry that does not fit its way, `excluded` and
  `unknown` all refuse publication. An edge that spans the boundary of an excluded part of its way
  is refused.
- **Refusal to start.** A mask that is not JSON, another format, another `formatVersion`, a
  payload that differs from its digest, a schema violation (including `terminalMeters` below 400,
  unsorted or duplicated ways, coordinates for another interval count) or a `graphId` other than
  `COMMUNITY_TRAFFIC_GRAPH_ID` throws `DeadEndMaskError`. Messages carry no map content.
- **Modes.** `off`: not read. `collect`: optional (collection publishes nothing); a configured
  path needs the graph id and must load. `live`: both variables are required; there is no
  permissive fallback.
- **Cost.** Loading the provincial mask takes 80 ms; a lookup 0.05–0.15 µs per edge (15,669 real
  edges, repeated twenty times).

## Install and version check

The mask belongs to exactly one graph build. The graph identity is read from the serving graph's
own manifest, never typed by hand.

1. Serve the offline pipeline's connected graph directory as `VALHALLA_DATA_DIR`
   (`graph.json`, `connected.tar`, the tiles Valhalla serves). Production's current
   scripted-image graph directories have no `graph.json` and cannot carry a mask.
2. Copy the mask built for that graph into the same directory, read-only:
   `install -m 0444 <output>/<graphId>/dead-end-mask.json "$VALHALLA_DATA_DIR/dead-end-mask.json"`.
3. In `.env`: `COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH=/graph/dead-end-mask.json` and
   `COMMUNITY_TRAFFIC_GRAPH_ID=$(jq -r .graphId "$VALHALLA_DATA_DIR/graph.json")`. Compose mounts
   `VALHALLA_DATA_DIR` read-only at `/graph` in the API container.
4. `infra/compose/check-stack.sh` (with the `.env` values exported), whenever the mode is `live` or
   a mask path is set, checks that `graph.json`'s id, `COMMUNITY_TRAFFIC_GRAPH_ID`, the SHA-256 of
   `connected.tar` and the mask's `graph.graphId` are the same, that the mask is format 1 with
   `terminalMeters` ≥ 400, and that the path is `/graph/dead-end-mask.json`. The API itself refuses
   to start in `live` with a missing or mismatched mask.
5. Rebuild the mask whenever the graph is rebuilt; a new graph has a new id and the old mask stops
   the API in `live`.

`graphId` identifies the canonical tile archive (`connected.tar`) of the build, the same id the
offline bundle manifest uses. That `valhalla_tiles.tar`, which Valhalla serves, is the archive
`connected.tar` was canonicalised from is guaranteed by the pipeline that writes both into one
directory, not re-proved at deploy time.

## Verification on the real Alberta/BC graph

`verify/dead-end-mask.mts` loads the mask through the API's reader, routes with a local Valhalla
3.8.2 serving the same graph, walks each route with `edge_walk` (the API's own `walkRoute`), and
looks up every publishable whole edge of at least 20 m. It also runs synthetic traces (route
geometry, 2 s fixes, 60 km/h) through the API's matcher with and without the mask, and, with
`--topology`, names the choke junction and region behind each refused edge. Throwaway local
run, 2026-11-14, graph of 2026-11-11, Valhalla on `127.0.0.1:8017`.

### Main roads and through routes

Share of the length of publishable whole edges on the routes (edges under 20 m and partly walked
end edges are not looked up and not counted):

| Sample                            | Checked km | Eligible | Excluded | Unknown |
| --------------------------------- | ---------: | -------: | -------: | ------: |
| Calgary, 40 random routes         |      883.0 |   100.0% |     0.0% |    0.0% |
| Edmonton, 40 random routes        |      792.9 |    99.4% |     0.6% |    0.0% |
| Metro Vancouver, 40 random routes |      893.1 |    99.7% |     0.3% |    0.0% |
| Calgary–Edmonton                  |      297.0 |    99.7% |     0.3% |    0.0% |
| Calgary–Vancouver                 |      957.2 |    99.6% |     0.4% |    0.0% |

The refused through-route and city edges are the 400 m around publishable or tertiary road ends
(for example a stub of a secondary road) and, in Vancouver, small single-access regions such as
the 8 km of road behind one junction at -123.035, 49.155. Over **all** 59,206 km of
publishable-class OSM way length in the two provinces: 91.3% eligible, 1.7% excluded as
single-access regions, 0.1% isolated, 0.3% within 400 m of a road end, and **6.5% unknown**
(5.7% regions and 0.8% components that leave the extract, mostly in the north and along the
borders). In city boxes (all publishable-class way length, not only routed): Calgary 99.6%,
Edmonton 98.7%, Metro Vancouver 98.7%, Victoria 98.8%, Nanaimo 100% and Kelowna 98.3% eligible.

### The four valleys

What was checked is the publishable edges **on the routed road** (whole edges of at least 20 m)
and the status of the whole OSM ways those edges belong to. That the rest of each valley (side
roads, residential streets) is excluded follows from the region analysis, which covers every node
of the region, but only the routed road was checked edge by edge on the graph.

| Road (route checked)                            | Checked km | Eligible | Excluded | Unknown | Region behind the choke                                                   |
| ----------------------------------------------- | ---------: | -------: | -------: | ------: | ------------------------------------------------------------------------- |
| AB 66, Bragg Creek – Elbow Falls                |       22.9 |    23.9% |    76.1% |      0% | choke -114.5832, 50.9214 (west of Bragg Creek), 76.0 km of road, not core |
| AB 546, Turner Valley – Sheep River road end    |       27.5 |    28.9% |    71.1% |      0% | choke -114.3796, 50.6578 (core junction), 27.7 km of road                 |
| BC 4, Port Alberni – Tofino                     |      121.8 |    31.8% |    68.2% |      0% | choke -125.2988, 49.2937, 412.5 km of road, not core                      |
| BC 37A, Meziadin Junction – Stewart             |       61.3 |       0% |       0% |    100% | choke -127.3317, 55.0188 (core junction), 5,834 km, leaves the extract    |
| AB 40, Highway 1 – Kananaskis Village (control) |       25.1 |    86.5% |    13.5% |      0% | none on AB 40                                                             |

- **AB 66.** The eligible part is Bragg Creek east of the choke. Beyond Elbow Falls the
  road is cut by ways the tag policy removed (3 ways of Alberta 66 are listed as excluded for
  that reason), and the 8.8 km of way past them is an isolated component (excluded).
- **AB 546.** Eligible from Turner Valley to the choke; 12.1 km of the whole ways are a
  single-access region and 18.8 km lie beyond a way the tag policy removed (isolated, excluded).
- **BC 4.** The 44.9 km of BC 4 ways from just east of Port Alberni (-124.75) to the choke have
  other exits and stay eligible; west of the choke, 83.4 km of BC 4 and the roads of Tofino and
  Ucluelet (412.5 km of road of all classes) are one single-access region.
- **BC 37A.** The whole Cassiar corridor north of Kitwanga is one single-access region within the
  extract. Its roads leave it at the Yukon border and at Hyder, Alaska, so whether it is a dead end
  cannot be decided from this data; it is **unknown**, and unknown is refused exactly like
  excluded (tested; on the real graph two candidate edges 15 km before Stewart were open without
  the mask and closed with it).
- **AB 40 (control).** All 49.7 km of AB 40 ways between Highway 1 and the village are eligible;
  the refused 13.5% of the route is the village's own access roads within 400 m of tertiary road
  ends at the destination.

### Through the matcher

| Synthetic trace (3 km, 91 fixes)       | Candidate edges | Open without mask | Open with mask |
| -------------------------------------- | --------------: | ----------------: | -------------: |
| Calgary–Edmonton, 20 km in             |               8 |                 8 |              8 |
| BC 4, 20 km before Tofino              |               4 |                 4 |              0 |
| AB 66, 5 km before Elbow Falls         |              15 |                15 |              0 |
| BC 37A, 15 km before Stewart (unknown) |               2 |                 2 |              0 |

## Tests

- `apps/api/test/dead-end-topology.test.ts` (CI): Lengauer–Tarjan against the definition of
  dominance on 60 random graphs; a connected grid stays eligible; a loop attached by one road is
  excluded and becomes eligible with a second exit to another junction; a divided entry and two
  roads from one junction are one access; one-way motorway carriageways with a diverge and a merge
  stay eligible; isolated components are excluded and regions or components that leave the extract
  are unknown; a stopping barrier makes two road ends; the 400 m rule on a curved spur, a hairpin
  whose end is near in a straight line but far along the network, and sparse one-kilometre
  intervals; a way crossing a region boundary becomes a mixed entry the API reads; province
  boundary tests. Mutation-checked: making the region rule "single way in **or** out" fails the
  motorway test; ignoring one-way directions fails the divided-entry test.
- `apps/api/test/dead-end-mask.test.ts` (CI): uniform and mixed lookups, the boundary-crossing
  edge, direction, rounding, unknown for unlisted ways and misfitting geometry; refusal of
  malformed, other-format, other-version, edited, other-graph and invalid masks; the mode rules
  of `loadConfiguredDeadEndMask`; and the recorded Calgary crawl (real Valhalla 3.8.2 responses)
  through the matcher, including a partly matched edge decided by its `/locate` whole shape and
  `unknown` refusing publication. Mutation-checked: removing the mask check from the matcher, or
  the worst-status rule for boundary-crossing edges, fails a test each.
- `infra/offline/test/test_dead_end_extract.py` (builder image, as the other offline Python
  tests): the tag policy and an OSM fixture through the real extractor (shared nodes, a bollard,
  a node missing from the extract).

## Limitations

- **Unknown is a large share in the north.** 6.5% of publishable length is unknown because its
  region leaves the extract. Deciding it needs Yukon, NWT, Saskatchewan and US data in the
  topology; until then it is never published.
- **Seasonal and private roads are never exits.** A valley whose second exit is a summer-only road
  is excluded all year. That costs coverage, never privacy.
- **Tag policy is OSM's view, not Valhalla's.** Both read the same extract, but the mask's car
  access, barrier and ferry rules are its own (stricter where they differ). A Valhalla edge on a
  way the mask dropped is refused.
- **Not population-aware.** A large single-access region (a 412 km peninsula, a 5,834 km northern
  corridor) is excluded or unknown as a whole, however many people live there. That is the
  conservative reading; nothing here estimates who lives where.
- **Residential road ends do not spill.** A home at the end of a short cul-de-sac off an arterial is
  protected by the cul-de-sac's exclusion and the app's 400 m trip-end trim, not by excluding the
  arterial.
- **Homes on through roads** remain protected by the threshold and the client trim only, as the
  architecture document states.
