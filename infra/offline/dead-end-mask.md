# Community-traffic dead-end mask

Valhalla marks `not_thru` only within a bounded search, so a dead-end valley with its own road
network is a through road to it (Alberta 66 and 546, BC 4 and 37A were confirmed undetected on the
2026-11-11 graph). The dead-end mask closes that gap. It is built offline from the **same dated
extract as the serving graph**, bound to that graph's id and provenance record, and read by the
API, which publishes an edge only when the mask places the edge's whole map geometry on the main
road network.

The mask and the verified serving graph are preconditions for `COMMUNITY_TRAFFIC_MODE=live`. They
do not change trip collection, and they do not enable anything: traffic stays `off` until the rest
of the [enablement checklist](../../docs/architecture/community-traffic.md#enablement-checklist)
is done, and an independent review of the final combined commit precedes any enablement.

## Build

```sh
# 1. The Valhalla 3.8.2 serving graph, with its provenance record.
node --import tsx infra/offline/serving-graph.mts \
  --inputs artifacts/offline/inputs/261111 --output artifacts/serving-graph
# 2. The mask for that graph.
node --import tsx infra/offline/dead-end-mask.mts \
  --inputs artifacts/offline/inputs/261111 \
  --graph artifacts/serving-graph/<graph id> \
  --output artifacts/dead-end-mask
```

- `--inputs` is an offline-pipeline input directory: the merged
  `alberta-british-columbia-YYMMDD.osm.pbf`, `SHA256SUMS` and `data.json`. Both scripts re-hash
  the PBF against `SHA256SUMS` before use; its date must match `data.json`.
- `serving-graph.mts` runs the offline pipeline's graph steps (`build-graph.sh`, the admin repair,
  `assemble-routing.py --canonicalize`) in the offline builder image built on the digest-pinned
  Valhalla **3.8.2** image (`configurationImage` of `routing-engine.lock.json`, the engine the
  online stack serves). Its output directory holds only what is served and checked:
  `connected.tar` (the canonical archive; its SHA-256 is the graph id), `valhalla-serving.json`
  (the build's configuration with `tile_extract` `/graph/connected.tar`, `tile_dir` `/nonexistent`,
  no traffic extract), `graph.json` and `provenance.json`. The provenance record is written by the
  build that produced the archive, after re-hashing the extract: the PBF name and SHA-256, the
  whole `SHA256SUMS`, the engine image, the builder image id and Dockerfile hash, the hashes of the
  build scripts and of `valhalla-serving.json`, the archive's size and id.
- `dead-end-mask.mts` refuses a `--graph` directory that does not verify exactly as the API
  verifies it (below) or whose provenance names another extract. The extraction runs in the
  offline builder image (`osmium tags-filter`, then `dead-end-extract.py` with pyosmium and numpy)
  with `--network none`, 2 CPUs and 4 GiB; the analysis runs in Node. A topology without a
  qualifying main-network block fails the build; no mask is written.
- Output: `<output>/<graphId>/dead-end-mask.json` and `build-report.json`. `--keep-topology` also
  keeps the extracted topology for `verify/dead-end-mask.mts`; it is province-sized map data and
  is never committed or deployed. All of `artifacts/` is ignored by Git.

**Graph builds are not byte-reproducible.** Three builds of the 2026-11-11 extract with the same
3.8.2 engine produced three archives of the same size and different hashes (`eeaa7a1d…1857` on
2026-11-12, `890fdba5…9014` and `2c24dd40…457c` on 2026-11-14). The graph id therefore identifies
one build, and only the provenance record written by that build binds it to its extract. The
2026-11-12 graph `eeaa7a1d…1857` has no such record: its cache key `c8e5ce3d…` covers the input
checksums, but the uncommitted pipeline that computed it cannot be reconstructed, and the
reproduction (`890fdba5…`) did not match. It is not used for traffic; its mask (format 1) is
refused. The current serving graph is `2c24dd40855744e9e6a24c7e865269428ecaa2d28e5a866366b666292ae5457c`,
built from `alberta-british-columbia-261111.osm.pbf`
(`0c94f9e2fbd67ceb44070c6300f28aba7ba5db936786a4629743c199f8179558`).

Measured on the maintainer's Mac (local, 2026-11-14, extract of 2026-11-11, graph
`2c24dd40…457c`, policy 3):

| Step                                                     |        Time | Peak memory                         |
| -------------------------------------------------------- | ----------: | ----------------------------------- |
| `serving-graph.mts` (admins, tiles, canonical archive)   | 4.5–6.5 min | not measured                        |
| Verify PBF and serving graph (2.2 GB + 0.6 GB)           |       1–3 s | streaming                           |
| Extraction (`osmium tags-filter`, `dead-end-extract.py`) |        52 s | not re-measured                     |
| Analysis and mask (Node)                                 |       1.0 s | 0.68 GB RSS (whole builder process) |
| **Total `dead-end-mask.mts`**                            |    **54 s** |                                     |

1,133,526 topology nodes and 1,433,161 segments (39 of them copies of another stretch). The mask
is **422 KB** (SHA-256 `e265cb11…e572`; 96,402 publishable-class ways, 401 with per-interval
geometry).

## What counts as a road

`dead-end-extract.py` (policy version 3) keeps a way only when the public may drive a private car
through it at any time. It follows Valhalla 3.8.2's
[`lua/graph.lua`](https://github.com/valhalla/valhalla/blob/3.8.2/lua/graph.lua) and is stricter
where they differ:

- `highway` motorway, trunk, primary, secondary, tertiary (and links), unclassified, residential,
  living_street, service, road. Tracks, paths, construction, areas and
  `service=emergency_access` are not roads here.
- **Car access** is read from the most specific key with a recognised value (`motorcar`,
  `motor_vehicle`, `vehicle`, `access`), reading **every `;` member**. Public values are those
  Valhalla allows (`yes`, `permissive`, `designated`, `official`, `public`, `allowed`). Every other
  value Valhalla recognises closes the way: `no`, `discouraged`, `agricultural`, `forestry`,
  `emergency`, `psv`, `use_sidepath`, `dismount`, `restricted`, plus `military` and `unknown`.
  A key with any closing member is closed (Valhalla lets a permitting member win). A value with
  no recognised member (BC 99's mistagged lane syntax `motor_vehicle=||no`, typos) is ignored, as
  in Valhalla, and the next key decides; `||no;no` is closed.
- **Destination-only is no exit.** `private`, `destination`, `customers`, `delivery`, `permit`
  and `residents` on any of the four keys make Valhalla route the way as destination-only
  ([private table](https://github.com/valhalla/valhalla/blob/3.8.2/lua/graph.lua#L105-L119)), even
  under a public more specific key. A car may enter, but it is not a public through exit, so such
  a way is removed.
- **Direction.** `oneway` and the implied one-way of motorways, motorway links and roundabouts
  give the legal directions; reversible or unparseable `oneway` removes the way. A directional
  car key (`motorcar`/`motor_vehicle`/`vehicle`/`access` `:forward` or `:backward`) whose members
  are not all public, or with a closing `:conditional`, closes that direction; an unrecognised
  directional value is no known direction (Valhalla reads it as no access). A way left with no
  direction is removed. A directional permission never opens a direction `oneway` closes.
- **Conditional closures.** Any closing value in a `*:conditional` restriction (seasonal gates
  such as Alberta 66 and 546, but also weight or time conditions) removes the way all year, ferries
  included.
- **Impassable.** `impassable=yes` or `smoothness=impassable` remove the way unless an explicit
  `motorcar`/`motor_vehicle`/`vehicle` permission overrides it (Valhalla's car override); the same
  on a node makes it a stopping barrier.
- **Ferries** count only with explicit public car access on `motorcar` or `motor_vehicle`, then
  under all the rules above, so Vancouver Island joins the mainland through its car ferries and a
  passenger or seasonal ferry is no exit.
- **Nodes.** Car access on a node decides first, whether or not it has a `barrier` tag (none,
  `barrier=no` or a type): Valhalla applies a node's access to every edge through it. A node whose
  most specific recognised car key is not public, or that is destination-only, conditionally
  closed or impassable without explicit car permission, stops cars; without car access tags,
  only a barrier type that stops cars does (bollard, block and similar; not gates, cattle grids
  or toll booths). A stopping node splits the road into two separate road ends. The build's node
  filter is the extractor's own (`--print-node-filter`): barriers, impassable nodes and every node
  with a car access key or its `:conditional`.

Removing a road can only add single-access regions, never remove one, so every doubtful case
errs towards exclusion. A publishable-class way removed this way is listed in the mask as
excluded. On the 2026-11-11 extract, 259 publishable-class ways are removed (182 access,
74 conditional, 3 one-way); against the format-1 mask of 2026-11-14, 138 ways are no longer
eligible and none became eligible. Policy 3 (car access on nodes) changed the status of no
publishable way on this extract: stopping nodes add 173 topology nodes and 528 more nodes are
isolated, none of them on a publishable interval.

Topology nodes are OSM nodes shared by two kept ways (or used twice by one), way ends and the
two sides of each stopping barrier. A segment is a stretch of one way between two topology nodes.
**Copies of one physical stretch** (the same end nodes and the same OSM nodes between them, either
way round: a way drawn A → P → A, or two ways over one road) are one road: the extractor points
each copy at one representative (`seg_phys`) and gives every copy the union of their directions in
its own node order, and the analysis uses the representative only, so a retraced road is neither
two parallel roads nor twice its length. Distinct geometry (a parallel road, a grade-separated
carriageway) has other nodes and stays separate. Residential and service roads are part of the
topology although they are never published, because the question is whether a region has a
second way out, whatever its class.

## Algorithm

All steps are iterative (no recursion) over typed arrays.

1. **Main network (core).** The biconnected blocks of the undirected graph of two-way roads
   (iterative Hopcroft–Tarjan over the representative stretches). Only a block of **at least two
   roads** qualifies: with copies collapsed, it contains a cycle, so its junctions are joined
   pairwise by two routes that share no junction. A single-road block (a bridge) never qualifies.
   The core is the **longest qualifying block by road length**; with none, nothing is eligible and
   the build fails. It is computed, not chosen; no node is picked by enumeration order,
   population or traffic. On the 2026-11-11 extract the core is 190,500 km of road (222,614
   junctions); Victoria and Nanaimo reach it through the car ferries; the second-longest
   qualifying block is 2,627 km, so the choice is not close.
2. **Single-access regions.** On the directed graph (one arc per legal direction), immediate
   dominators (iterative Lengauer–Tarjan with simple path compression, O(m log n)) from a root
   joined to every core junction, once entering (from the core) and once leaving (to the core).
   A node lies in a single-access region when one junction other than the node itself lies on
   **every route in and every route out**: a proper ancestor in the exit dominator tree that is
   also an ancestor in the entry dominator tree. Its region is grouped by the outermost such
   junction (the _choke_). One depth-first walk of the exit tree keeps the active ancestors in a
   segment tree over the entry tree's preorder intervals, with rollback on the way back up; a
   cell keeps the outermost mark, so each cell is set at most once while active. That is
   O(n log n) time (at most n (3⌈log₂ s⌉ + 1) cell visits, s the next power of two ≥ n) and O(n)
   memory. On the provincial topology: 25.9 million cell visits (bound 72.5 million); the former
   per-node ancestor walk was quadratic on a chain.
   - The two directions of a road are one road: they share junctions.
   - Two roads from the same junction, or a divided road (one carriageway in, one out), are one
     access: the junction or the exit carriageway is on every route.
   - Two roads to two different junctions of the network are two exits, provided both are car
     roads in both senses above.
   - A motorway diverge has a single way in but several ways on, and a merge the reverse; neither
     is a single-access region, so one-way carriageways and ramps stay eligible.
   - Loops and cycles inside a valley change nothing: every route still passes the choke.
3. **Isolated.** A node that cannot reach the core, or cannot be reached from it, is excluded.
4. **Unknown continuation.** A road end outside the Alberta and BC boundaries (Geofabrik ends
   neighbouring roads at a buffer polygon), or a way whose nodes are missing from the extract, is a
   _clipped_ node. A single-access region or isolated component containing one is **unknown**, not
   excluded and never eligible: the road may continue outside the extract and come back, or not.
5. **Road ends.** Multi-source Dijkstra from every _true terminal_ (a road end that is not
   clipped) of a publishable or tertiary road, bounded at 400 m. A road end qualifies when **any
   copy** of its physical stretch is of such a class, whichever copy represents it; the stretch
   still counts once for degree and length, and a stretch with only residential copies does not
   qualify. Any node-to-node interval of a
   publishable way that comes within 400 m of such an end along the network is excluded.
   - Every road end of any class is inside a single-access region and is excluded with it,
     whatever its length. The terminal list only decides how far exclusion spills past that
     region's junction onto roads that also carry through traffic.
   - **Residential, unclassified and service road ends do not spill.** Spilling from all public
     road ends excluded 32% of the motorway-to-secondary length in Calgary, 46% in Edmonton and
     60% in Metro Vancouver (format-1 measurement); publishable and tertiary road ends exclude
     about 0.3–1.2%. This is a coverage measurement, not a privacy guarantee: see Limitations.
6. **Per way.** Each interval of a publishable way takes the status of its segment (the worse of
   its two end nodes, a closed loop on one junction being a dead end), then the 400 m rule.

## Format (version 2)

One JSON object, `format: "navoss-traffic-dead-end-mask"`, `formatVersion: 2`:

- `graph`: `graphId` (SHA-256 of `connected.tar`), `dataDate`, `routingEngineVersion` (must be
  `3.8.2`), `provenanceSha256` (SHA-256 of the serving graph's `provenance.json`);
- `inputs`: the PBF name, its SHA-256, the OSM replication timestamp and `extractPolicyVersion`
  (must be `2`);
- `rules`: the core rule, publishable classes, terminal classes and `terminalMeters` (≥ 400);
- `summary`: counts and lengths, for operators;
- `ways`: `eligible`, `excluded` and `unknown` way-id lists (ascending, delta-encoded) for ways
  with one status throughout, and `mixed` entries `[way id, one letter (e, x, u) per node-to-node
interval, delta-encoded 1e-6 longitude/latitude of every node]` for ways whose status changes
  along the way;
- `contentSha256`: SHA-256 of canonical JSON (keys sorted) of **every other member**, metadata
  included.

The digest detects a truncated, edited or re-labelled mask. It is integrity, **not
authentication**: anyone who can write the file can recompute it. The file's protection is the
read-only install and the graph binding checked at start-up. Format 1 masks (built with the
policy, core and duplicate-road errors fixed in format 2) are refused.

The status is per way and applies to both directions (a dead-end road is excluded both ways,
as the graph-flag check already does). The mask holds map data only: way ids and the OSM node
coordinates of 401 ways. Nothing from an upload is in it, and building it reads no upload.

## Runtime

`apps/api/src/traffic/dead-end-mask.ts` reads and validates the mask; `serving-graph.ts` verifies
the serving graph directory; `loadConfiguredDeadEndMask` in `settings.ts` does both and binds them;
`createValhallaMapMatcher({ deadEndMask })` applies the mask after the class, length and graph
access checks.

- **Lookup key.** The edge's OSM way, direction and **whole map geometry**: the trace's own line
  for an edge matched end to end, the whole-edge shape `/locate` returns for a partly matched
  one. Never a position from the batch, and never the `/locate` midpoint (which depends on the
  matched part). The geometry is reversed for a backward edge and matched vertex by vertex
  (±2 × 1e-6°, Valhalla's six-decimal rounding of seven-decimal OSM nodes) against the way's
  nodes; every interval it covers must be eligible.
- **Fail closed.** A way not in the mask, geometry that does not fit its way, `excluded` and
  `unknown` all refuse publication. An edge that spans the boundary of an excluded part of its way
  is refused.
- **Refusal to start.** `COMMUNITY_TRAFFIC_GRAPH_DIR` (`/graph`) and `COMMUNITY_TRAFFIC_GRAPH_ID`
  must name a directory where `graph.json` is that id and engine 3.8.2; `valhalla-serving.json`
  names exactly `<dir>/connected.tar`, has no existing `tile_dir`, no `tile_url` and no traffic
  extract, and is the configuration recorded in `provenance.json`; `provenance.json` is for that
  graph and its `SHA256SUMS` lists the extract it names; `connected.tar` hashes to the id with the
  recorded size; and `dead-end-mask.json` is format 2, policy 3, engine 3.8.2, matches its digest,
  and names the same graph id, provenance record, extract and data date. Anything else throws
  `DeadEndMaskError`. Messages carry no map content.
- **Modes.** `off`: nothing is read. `collect`: optional (collection publishes nothing); a
  configured directory must verify. `live`: both variables are required; there is no permissive
  fallback.
- **Cost.** Verifying the directory (hashing the 589 MB archive) and loading the provincial mask
  takes 0.5 s on the Mac and 1.1 s in the API image; a lookup 0.08 µs per edge (15,669 real
  edges, repeated twenty times).

## Install and version check

The mask belongs to exactly one graph build, and the API must read the bytes Valhalla serves.

1. Copy the serving graph directory to the server as a new versioned directory and install the
   mask in it read-only: `install -m 0444 <mask output>/<graphId>/dead-end-mask.json
"$VALHALLA_DATA_DIR/dead-end-mask.json"`; every file 0444, the directory 0755.
2. In `.env`: `VALHALLA_DATA_DIR` that directory and
   `COMMUNITY_TRAFFIC_GRAPH_ID=$(jq -r .graphId "$VALHALLA_DATA_DIR/graph.json")`, never typed
   by hand.
3. Start with the overlay, in `off` or `collect`:
   `docker compose -f compose.yaml -f compose.traffic-graph.yaml up -d --force-recreate valhalla api`.
   The overlay replaces the scripted Valhalla (which may build tiles and serves
   `/custom_files/valhalla_tiles.tar`) with `valhalla_service` on the read-only directory at
   `/graph`, with a read-only root file system and no egress. Its entrypoint is exactly
   `/bin/sh /navoss/serve-verified-graph.sh` with no command: `valhalla-serve-verified.sh`,
   mounted read-only, which refuses to serve unless `graph.json` is the configured id,
   `connected.tar` hashes to it and the configuration and provenance name only that archive,
   then runs `valhalla_service /graph/valhalla-serving.json 2`. The API mounts the same directory read-only at `/graph`.
   The base `compose.yaml` is unchanged: its API has no graph directory and cannot start `live`.
4. `infra/compose/verify-traffic-graph.sh`, run by the operator with the existing Docker access
   (the API never gets the Docker socket), re-checks the directory and inspects the **running**
   containers: Valhalla runs the pinned 3.8.2 image, healthy, with **exactly** that entrypoint,
   no command and no other arguments, and mounts only this directory and the repository's
   `valhalla-serve-verified.sh`, both read-only; the API mounts only this directory, read-only,
   with the directory and id configured; both have read-only root file systems and started after
   the directory or the entrypoint script last changed. The API's matcher endpoint, selected as
   the traffic service selects it (`VALHALLA_TRACE_URL` when set, even empty, otherwise
   `trace_attributes` resolved against `VALHALLA_URL`), must be exactly
   `http://valhalla:8002/trace_attributes`; the inspected Valhalla must answer to `valhalla` on a
   network the API joins, and no other container may answer to it (name, alias or DNS name) on
   **any** network the API joins, shared with Valhalla or not. A network or member that cannot be
   inspected fails the check. It needs `docker`,
   `jq`, `perl` and `sha256sum` or `shasum`. Only then set `live`. `check-stack.sh` runs it whenever the mode is `live`.
5. A new graph means a new directory, a new mask, the new id, recreating both Valhalla and the
   API, and clearing traffic observations and releases of the old graph. Nothing replaces a graph
   under a running stack; a container started before the directory changed fails step 4.

Tested locally (2026-11-14, Docker Desktop, the real `2c24dd40…` directory): the overlay serves
the graph and routes; Valhalla exits before serving for a wrong configured id, a truncated archive
under matching manifests, and a configuration naming `/graph/valhalla_tiles.tar`; the API image
loads in `live` and refuses a wrong id, a truncated archive, an old-policy mask and a
configuration naming `/custom_files/valhalla_tiles.tar`; the verifier passes the running stack
and refuses a writable Valhalla mount and a directory changed after start.
`scripts/verify-traffic-graph.test.mjs` (CI) runs the real verifier against a real directory and
recorded-shape container records and checks that it refuses an expected `exec` hidden in a
comment before another configuration, an extra command, another entrypoint script, a writable
mount, a matcher at another private Valhalla, an empty trace URL, a `VALHALLA_URL` fallback to
another host, no shared `valhalla` alias, a second container answering to `valhalla` on the
shared network or on a network only the API joins (alias or DNS name), a network that cannot be
inspected, and a container started before the directory changed.

## Verification on the real Alberta/BC graph

`verify/dead-end-mask.mts --graph <directory>` verifies the serving directory as the API does,
routes with Valhalla 3.8.2 serving that directory through the overlay, walks each route with
`edge_walk` (the API's own `walkRoute`), and looks up every publishable whole edge of at least
20 m. It also runs synthetic traces (route geometry, 2 s fixes, 60 km/h) through the API's matcher
with and without the mask, and, with `--topology`, names the choke junction and region behind each
refused edge. Throwaway local run, 2026-11-14, graph `2c24dd40…457c`, policy-3 mask (every
figure below is the same as with the policy-2 mask).

**What is sampled and what is exhaustive.** Routed edges are samples: 40 random routes per city
box and fixed routes. The region analysis (choke, region length, whether it leaves the extract)
and the area shares below cover every node and every publishable interval of the topology. Only
the routed road of each valley was checked edge by edge against the graph.

### Main roads and through routes

Share of the length of publishable whole edges on the routes (edges under 20 m and partly walked
end edges are not looked up and not counted):

| Sample                            | Checked km | Eligible | Excluded | Unknown |
| --------------------------------- | ---------: | -------: | -------: | ------: |
| Calgary, 40 random routes         |      883.0 |   100.0% |     0.0% |    0.0% |
| Edmonton, 40 random routes        |      792.9 |    99.4% |     0.6% |    0.0% |
| Metro Vancouver, 40 random routes |      893.1 |    99.6% |     0.4% |    0.0% |
| Calgary–Edmonton                  |      297.0 |    99.7% |     0.3% |    0.0% |
| Calgary–Vancouver                 |      957.2 |    99.6% |     0.4% |    0.0% |

The refused through-route and city edges are the 400 m around publishable or tertiary road ends
and small single-access regions. Over **all** 59,202 km of publishable-class way length in the
topology (exhaustive): 91.3% eligible, 1.8% excluded as single-access regions, 0.1% isolated, 0.4%
within 400 m of a road end, and **6.5% unknown** (5.7% regions and 0.8% components that leave the
extract, mostly in the north and along the borders). In city boxes (all publishable-class way
length, not only routed): Calgary 99.6%, Edmonton 98.7%, Metro Vancouver 98.6%, Victoria 98.8%,
Nanaimo 100% and Kelowna 98.1% eligible.

### The four valleys

| Road (route checked)                            | Checked km | Eligible | Excluded | Unknown | Region behind the choke (whole topology)                           |
| ----------------------------------------------- | ---------: | -------: | -------: | ------: | ------------------------------------------------------------------ |
| AB 66, Bragg Creek – Elbow Falls                |       22.9 |    23.9% |    76.1% |      0% | choke -114.5832, 50.9214 (west of Bragg Creek), 74.2 km, not core  |
| AB 546, Turner Valley – Sheep River road end    |       27.5 |    28.9% |    71.1% |      0% | choke -114.3796, 50.6578 (core junction), 27.7 km                  |
| BC 4, Port Alberni – Tofino                     |      121.8 |    31.8% |    68.2% |      0% | choke -125.2988, 49.2937, 412.4 km, not core                       |
| BC 37A, Meziadin Junction – Stewart             |       61.3 |       0% |       0% |    100% | choke -127.3317, 55.0188 (core junction), 5,832 km, leaves extract |
| AB 40, Highway 1 – Kananaskis Village (control) |       25.1 |    86.5% |    13.5% |      0% | none on AB 40                                                      |

Whole OSM ways under the routed edges:

- **AB 66.** 5.5 km eligible (Bragg Creek east of the choke), 16.9 km single-access region,
  0.5 km isolated beyond ways the policy removed.
- **AB 546.** 8.0 km eligible from Turner Valley to the choke, 12.1 km single-access region,
  10.1 km isolated beyond a way the policy removed.
- **BC 4.** 42.7 km eligible east of the choke (other exits), 83.3 km in the single-access region
  of Tofino and Ucluelet (412.4 km of road of all classes), 0.7 km within 400 m of a road end.
- **BC 37A.** 64.3 km unknown: the Cassiar corridor north of Kitwanga is one single-access region
  within the extract whose roads leave it at the Yukon border and at Hyder, Alaska. Unknown is
  refused exactly like excluded (fail-closed; two candidate edges 15 km before Stewart are open
  without the mask and closed with it).
- **AB 40 (control).** The refused 13.5% of the route is the village's own access roads within
  400 m of tertiary road ends at the destination.

### Through the matcher

| Synthetic trace (3 km, 91 fixes)       | Candidate edges | Open without mask | Open with mask |
| -------------------------------------- | --------------: | ----------------: | -------------: |
| Calgary–Edmonton, 20 km in             |               8 |                 8 |              8 |
| BC 4, 20 km before Tofino              |               4 |                 4 |              0 |
| AB 66, 5 km before Elbow Falls         |              15 |                15 |              0 |
| BC 37A, 15 km before Stewart (unknown) |               2 |                 2 |              0 |

## Tests

- `apps/api/test/dead-end-topology.test.ts` (CI): Lengauer–Tarjan against the definition of
  dominance on 60 random graphs; the choke search against the ancestor-walk oracle on 300 random
  graphs and its operation bound and growth on chains of 10³–10⁶ nodes; a bridge between two
  triangles is never the core and a tree has no core; a retraced road counts once, a one-way pair
  over one stretch is one two-way road, and two distinct parallel roads form a real cycle; a
  connected grid stays eligible; a loop attached by one road is excluded and becomes eligible with
  a second exit; a divided entry and two roads from one junction are one access; one-way motorway
  carriageways with a diverge and a merge stay eligible; isolated and unknown regions; a stopping
  barrier; the 400 m rule on curved, hairpin and sparse geometry; a boundary-crossing way read
  back by the API; province boundaries; a road end whose stretch has a secondary and a
  residential copy starts the 400 m rule whichever copy represents it, and a residential-only
  spur does not. Mutation-checked: letting bridges qualify, counting copies, querying the node
  itself, and qualifying a road end by its representative copy only each fail a test.
- `apps/api/test/dead-end-mask.test.ts` (CI): uniform and mixed lookups; refusal of malformed,
  other-format, format-1, earlier-policy or missing-policy, other-engine, edited ways and re-labelled
  metadata, other-graph and invalid masks; the configured serving graph: a wrong archive under
  matching manifests, a missing archive, configurations naming another archive or with a tile
  fallback, missing, unsupported and re-issued provenance, missing and format-1 masks, and a
  coherent graph replacement accepted only when the configured id moves with it; and the recorded
  Calgary crawl through the matcher. Mutation-checked: dropping the archive hash, the
  `tile_extract` check, the metadata from the digest, or the mask–provenance binding each fail a
  test.
- `infra/offline/test/test_dead_end_extract.py` (builder image): the review's policy vectors and
  more, directional access, and real secondary-outlet pockets through the extractor with an
  independent reachability oracle (no route between pocket and core avoiding the choke in both
  directions for each closure; a public outlet and `||no` keep one); retraced and overlapping
  stretches collapse while distinct geometry does not; an impassable node; a pocket whose second
  outlet passes a node with car access alone (`access=no`, `motor_vehicle=no`, `barrier=no` with
  `access=no`, `vehicle=private`, a conditional closure) through the build's own `osmium` node
  filter. Mutation-checked: destination-only as public, first member only, ferries skipping
  closures, ignoring directional access, ignoring impassable, not collapsing, the barrier
  shortcut before node access, and a node filter without access keys each fail tests.

## Limitations

- **Unknown is a large share in the north.** 6.5% of publishable length is unknown because its
  region leaves the extract. Deciding it needs Yukon, NWT, Saskatchewan and US data in the
  topology; until then it is never published.
- **Closures are never exits.** A valley whose second exit is a summer-only, destination-only or
  weight-restricted road is excluded all year. That costs coverage, never privacy.
- **Tag policy is OSM's view, stricter than Valhalla's.** Both read the same extract, but the
  mask's car access, barrier and ferry rules are its own. A Valhalla edge on a way the mask
  dropped is refused.
- **Not population-aware.** A large single-access region (a 412 km peninsula, a 5,832 km northern
  corridor) is excluded or unknown as a whole, however many people live there.
- **The 400 m rule spills only from publishable and tertiary road ends.** A home at the end of a
  short residential cul-de-sac off an arterial is protected by the cul-de-sac's exclusion and the
  app's 400 m trip-end trim, which the server cannot verify; the arterial itself can be published.
  The mask does not make every arterial neighbourhood anonymous: three installations can still be
  one household, a released arterial edge can remain a catchment clue, and colluding
  contributors can infer a third's presence. These residual risks need explicit acceptance before
  `live`.
- **Homes on through roads** remain protected by the threshold and the client trim only, as the
  architecture document states.
- **Graph identity is per build.** Valhalla graph builds are not byte-reproducible; a graph
  without its build's provenance record cannot be bound to an extract after the fact.
