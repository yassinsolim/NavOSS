# NavOSS production stack

This stack serves the NavOSS API using Canada-wide geospatial artifacts.
All geospatial and database services remain private. Caddy binds only to
`127.0.0.1:8080`; Cloudflare Tunnel is the sole public ingress.

This VM is not sized for a North America Nominatim import or blue/green continent datasets. The
capacity and rollout decision is documented in
[`docs/architecture/north-america.md`](../../docs/architecture/north-america.md). Build and validate
continent artifacts on dedicated import infrastructure before changing production extracts.

Production status: the Canada cutover was performed on 2026-11-15 at 15:44 UTC. The API image is
from `4708d34`, with rollback tag `navoss-api:pre-canada-registry`; the data rollback backup is
`.env.pre-canada-20261115T154413Z`. Public ingress is `https://navoss-api.yassin.app`. Reports
are `attested` and traffic is `collect` (not displayed or used in routes). Offline regions are
published for Alberta and the Calgary area only. The Alberta+BC artifacts remain for rollback.

## Storage

- `/srv/navoss/state/postgres`: PostGIS state for the reproducible Calgary search index, community reports, and published community-traffic releases. Logical backups exclude `calgary_search_*` tables and the rows (not the schema) of the short-lived `community_*` and `traffic_*` tables.
- `/srv/navoss/artifacts/imports`: official Alberta and British Columbia extracts plus the merged regional Nominatim input.
- `/srv/navoss/artifacts/valhalla`: reproducible Alberta and British Columbia routing graph.
- `/srv/navoss/artifacts/nominatim/postgres`: reproducible Alberta and British Columbia search index.
- `/srv/navoss/artifacts/docker`: Docker images, layers, and build cache.

## Bootstrap

Create the directories and a mode-600 environment file on the VM:

```sh
sudo install -d -m 0750 -o navoss -g navoss \
  /srv/navoss/state/postgres \
  /srv/navoss/state/backups/postgres \
  /srv/navoss/artifacts/imports \
  /srv/navoss/artifacts/valhalla \
  /srv/navoss/artifacts/nominatim/postgres

cp .env.example .env
chmod 600 .env
```

Generate independent random passwords rather than copying the example values.
Never commit `.env`.

Licensed Mapbox traffic remains disabled when `MAPBOX_ACCESS_TOKEN` is blank and
`MAPBOX_VEHICLE_LICENSE_CONFIRMED=0`. Do not set the confirmation flag based on
a standard self-service account: Mapbox's current pricing terms require a
commercial application license for vehicle and in-vehicle use. After that
license is executed, store the server token only in the mode-600 `.env`, set the
confirmation flag to `1`, update the production privacy/App Store disclosures,
and rerun the route-quality and physical CarPlay gates. A token without license
confirmation, or confirmation without a token, intentionally prevents API
startup.

## Official full-closure routing

`ROUTE_AVOID_CLOSURES` is wired to the API and defaults to `off`. It applies only to
self-hosted Valhalla `/v2/routes`; `/v1/routes`, both configuration responses, the event response
contracts, and the licensed Mapbox path are unchanged.

| Setting  | Returned routes                                                       | Extra work                                                         |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `off`    | Today's routes, with no exclusion fields in the upstream request      | None                                                               |
| `shadow` | Today's routes                                                        | Select, place and compute avoiding routes; aggregate counters only |
| `on`     | A verified avoiding result, otherwise today's already computed routes | The same computation as shadow                                     |

The official event providers retain their validated raw geometry and recurrence beside their
normalised events, using the **same fetch/cache**; there is no second public-feed poller. Existing
`ALBERTA_511_API_KEY` and `ONTARIO_511_API_KEY` settings apply. Missing keys, stale sources, an
unevaluable recurring window, mismatched point road names, lane/shoulder work and advisories never
become routing barriers. Calgary construction also needs a publisher dataset update within 24
hours, not merely a successful fetch of an old copy. See the per-source evidence and counts in
[`docs/data-sources.md`](../../docs/data-sources.md#official-full-closures-as-a-routing-input).

Only public closure geometry is sent to the local graph's `/trace_attributes` and `/locate`.
Exclusions are tightly verified points on the stated road, with a graph-derived heading for one
direction; no closure polygons or stored graph edge ids are used. Up to 50 exclusion locations
(including other caller-supplied exclusions) and a **2.5-second total closure-work budget** bound
each request, after its ordinary route has been computed. Every avoiding result is checked again
against all eligible events; a newly encountered closure is added to the same exclusion set before
the next computation. A pass must add an event, so this cannot spin indefinitely.

Any timeout, provider/no-route failure, ignored exclusion, or count limit returns the ordinary
route. A large diversion (over 15 additional minutes **and** over twice the ordinary fastest
duration) needs continuously verified source lines for every blocking event. Point-only or mixed
large diversions fail open. Endpoints at a barrier keep last-metre access and routing availability;
this does not certify that the closed road is driveable.

In shadow/on, the API emits one `Official closure routing counters` aggregate per minute, under
`closures`: request/nearby/change counts, computed exclusions, failed-open and large-line totals,
and fixed rejection reasons. There are **no coordinates, event ids, request ids or per-route
records**. Do not add route tracing, upstream payload logging or event/route joins to diagnose this.

Roll out with `off`, inspect a local/operational shadow run, and explicitly set `on` only after
the current source freshness, graph-placement and latency evidence is acceptable. Recreate only
the API after changing this environment value using the normal deployment procedure; setting it
back to `off` is the immediate routing rollback. This PR does not deploy or enable it. No database,
graph rebuild, new phone build, `features.liveTraffic` claim, or client contract field is needed.

## Community traffic

Community traffic is built from short driving batches that opted-in NavOSS drivers upload. The
design, parameters and limits are in
[`docs/architecture/community-traffic.md`](../../docs/architecture/community-traffic.md). Read
"What this does not protect against" there, and tick its "Enablement checklist" for the mode,
before changing it. It is controlled by one value in
`.env` and is `off` unless set:

| `COMMUNITY_TRAFFIC_MODE` | `POST /v2/traffic/probes`            | Flow, route traffic, `features.liveTraffic` |
| ------------------------ | ------------------------------------ | ------------------------------------------- |
| `off` (default)          | 503                                  | unavailable, `false`                        |
| `collect`                | accepted, counted, nothing stored    | unavailable, `false`                        |
| `live`                   | accepted, published at the threshold | published at five-minute boundaries, `true` |

Uploads need an App Attest installation, so `APP_ATTEST_TEAM_ID`, `COMMUNITY_INSTALLATION_SECRET`
and `COMMUNITY_ATTESTATION_MODE=enforce` must be set as for community reports; without them the
API issues no upload credential and `/v2/traffic/status` reports `probes.accepting: false`.

The traffic table comes from the same migration command as community reports; there is one
migration mechanism and one deploy step (see [Database migrations](#database-migrations-and-community-reports)). Roll
out in this order:

```sh
# 1. Deploy the image with the mode still off; nothing changes for clients.
sudo docker compose build api
sudo docker compose run --rm --no-deps api node dist/migrate.js
sudo docker compose up -d --no-build --wait --wait-timeout 300 api caddy
./check-stack.sh

# 2. Collect.
sed -i 's/^COMMUNITY_TRAFFIC_MODE=.*/COMMUNITY_TRAFFIC_MODE=collect/' .env
sudo docker compose up -d --no-build --wait --wait-timeout 300 api
COMMUNITY_TRAFFIC_MODE=collect ./check-stack.sh

# 3. Publish, once the privacy policy and app release that describe sharing are out and the
#    unproven items in the architecture document have been checked on this host.
sed -i 's/^COMMUNITY_TRAFFIC_MODE=.*/COMMUNITY_TRAFFIC_MODE=live/' .env
sudo docker compose up -d --no-build --wait --wait-timeout 300 api
COMMUNITY_TRAFFIC_MODE=live ./check-stack.sh
```

While collecting or live, the API logs a `Community traffic summary` line every 15 minutes with
batch and credential counters, the number of samples and road edges pending in memory, and the
number of edges released. It contains no position, road, address, installation or time, and none
of it is available over HTTP. A failed purge or epoch write is logged at error level as
`Community traffic maintenance failed` with only the name of the step.

Operational facts:

- The mode requires the self-hosted Valhalla. `VALHALLA_TRACE_URL` must be loopback, a private
  address, or a single-label service name such as `valhalla`; the API refuses to start in
  `collect` or `live` with anything else and never follows a redirect from the matcher.
- In `collect` or `live` the API refuses to start while a migration is pending. It never applies
  one itself.
- Probe matching may hold one of Valhalla's two worker threads; extra batches get 503 and are
  dropped by the app, so routing keeps the other thread.
- Observations below the publication threshold live only in API memory. `traffic_releases` holds
  published values only, is unlogged, and is emptied on **every** API start in **every** mode.
  Up to 15 minutes of published traffic, and up to 20 minutes of pending observations, disappear
  on a restart and rebuild as drivers upload. Upload credentials issued before the restart stop
  working; the app requests a new one.
- With the mode `off`, community traffic adds no unbounded wait on PostgreSQL to API startup: the
  API waits at most three seconds for the purge, then carries on, and a purge that fails or times
  out is logged as `Community traffic maintenance failed`. In `collect` or `live` a failed purge
  stops startup. (Whether the API as a whole starts while PostgreSQL is down is decided by its
  other PostgreSQL-backed providers, not by this feature.)
- Restart the API whenever the Valhalla graph is replaced. Segment keys belong to one graph.
- Run a single API container. Pending observations, credential keys and rate limits are per
  process; this is not enforced.
- The privacy limits (three contributors, 400 m trip trim, 100 m batch trim, five-minute
  boundaries, 15-minute lifetimes, road classes) are fixed in code. `.env` can only raise the
  contributor minimum and the trip trim.
- `backup-reports-db.sh` dumps the structure of `traffic_*` tables only, never their rows.
- Rollback: set `COMMUNITY_TRAFFIC_MODE=off` and restart `api`. The restart empties
  `traffic_releases`; nothing else was stored. The table itself stays (migrations are additive).
- Valhalla's `traffic_name` stays blank. Observed speeds are not fed into route selection.

### Verified serving graph and dead-end mask (required for `live`)

`live` refuses to start without a verified serving graph and the topology dead-end mask built for
it ([`infra/offline/dead-end-mask.md`](../offline/dead-end-mask.md)). The base stack keeps the
legacy scripted Valhalla and cannot run `live`: its API has no graph directory. The overlay
`compose.traffic-graph.yaml` replaces Valhalla with `valhalla_service` on a read-only
`serving-graph.mts` directory and mounts the same directory read-only at `/graph` in the API.

```sh
# VALHALLA_DATA_DIR: a serving-graph.mts directory (connected.tar, valhalla-serving.json,
# graph.json, provenance.json) with its mask installed as dead-end-mask.json, all 0444.
graph_id=$(jq -er .graphId "$VALHALLA_DATA_DIR/graph.json")
sed -i "s|^COMMUNITY_TRAFFIC_GRAPH_ID=.*|COMMUNITY_TRAFFIC_GRAPH_ID=$graph_id|" .env
set -a; . ./.env; set +a
# Start (or recreate) in `off` or `collect` first, verify, and only then switch to `live`.
docker compose -f compose.yaml -f compose.traffic-graph.yaml up -d --force-recreate valhalla api
./verify-traffic-graph.sh && ./check-stack.sh
```

- Valhalla's entrypoint (exactly `/bin/sh /navoss/serve-verified-graph.sh`, the read-only
  `valhalla-serve-verified.sh`) refuses to serve unless `graph.json` is `COMMUNITY_TRAFFIC_GRAPH_ID`,
  `connected.tar` hashes to it, `valhalla-serving.json` names only `/graph/connected.tar` and
  `provenance.json` binds both. No tile build, no fallback tile directory, no writable mount.
- The API in `collect` or `live` repeats those checks on its own read-only mount and refuses to
  start unless the mask is bound to the same graph, provenance record and extract.
- `verify-traffic-graph.sh` (operator, existing Docker access; the API never gets the socket)
  checks the running containers' effective mounts, image, complete entrypoint and command,
  environment, the API's selected matcher endpoint and that only the inspected Valhalla answers
  to `valhalla` on any network the API joins, and that
  both started after the directory last changed. `check-stack.sh` runs it in `live`.
- Replacing the graph means a new directory, a new mask, the new id in `.env`, recreating both
  Valhalla and the API, and clearing traffic observations and releases of the old graph. Nothing
  replaces a graph under a running stack.

## Regional extract preparation

Nominatim requires one merged extract because Alberta and British Columbia do not share a Geofabrik
replication feed. Install `osmium-tool`, then prepare and validate the merged input:

```sh
sudo apt-get update
sudo apt-get install -y osmium-tool
./prepare-regional-pbf.sh
```

The script resolves matching dated Geofabrik releases, downloads each into a temporary file,
validates it, creates an immutable versioned merged extract, atomically updates the `current`
symlink, and records SHA-256 hashes. Previous extracts remain available for rollback. Nominatim is
intentionally static between explicit regional rebuilds. Valhalla consumes the same two official
extracts directly.

Never point Compose at the existing Alberta-only directories. Build into empty versioned paths,
for example:

```sh
version=260730
valhalla_stage=/srv/navoss/artifacts/valhalla-alberta-british-columbia-${version}
nominatim_stage=/srv/navoss/artifacts/nominatim/alberta-british-columbia-${version}/postgres
sudo install -d -m 0750 -o navoss -g navoss "$valhalla_stage" "$(dirname "$nominatim_stage")"
sudo install -d -m 0750 "$nominatim_stage"
cd /srv/navoss/artifacts/imports
sha256sum --check "SHA256SUMS-${version}"
cp --reflink=auto "alberta-${version}.osm.pbf" "$valhalla_stage/"
cp --reflink=auto "british-columbia-${version}.osm.pbf" "$valhalla_stage/"
cp --reflink=auto /srv/navoss/artifacts/valhalla/timezones.sqlite "$valhalla_stage/"
./prepare-valhalla-speeds.sh "$valhalla_stage"
```

Run one isolated import at a time without invoking `docker compose up` for the live services. The
staging containers have no API/ingress network and use different names and host ports. The profile
generator pins the OpenStreetMapSpeeds input to its immutable upstream commit, verifies SHA-256, and
atomically creates the validated hybrid with its Alberta exceptions (posted limits on suburban and
urban motorways, Alberta's own urban primary speed; `docs/testing/route-quality.md`, "Calgary
arterial and freeway speeds"). Do not replace it with the mutable `master` URL:

```sh
sudo docker run --rm --name navoss-valhalla-stage \
  --cpus 2 --memory 2g -p 127.0.0.1:18002:8002 \
  -e build_admins=True -e build_elevation=False -e build_tar=True \
  -e build_time_zones=False -e force_rebuild=False -e server_threads=2 \
  -e tile_urls= \
  -e traffic_name= -e use_default_speeds_config=True -e use_tiles_ignore_pbf=True \
  -e default_speeds_config_url=https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json \
  -v "$valhalla_stage:/custom_files" \
  ghcr.io/valhalla/valhalla-scripted:3.8.2
```

The province extracts omit enough of the Canada boundary relation for Valhalla to skip the
admin-level-2 country polygon. Without a country parent, graph enhancement cannot resolve `CA.AB`
or `CA.BC` and silently applies the global speed profile. After the first process is healthy, stop
it, repair only the staged admin database, and rebuild the graph so speed assignment uses the
province records:

```sh
sudo -n ./repair-valhalla-admins.sh "$valhalla_stage"

sudo docker run --rm --name navoss-valhalla-stage \
  --cpus 2 --memory 2g -p 127.0.0.1:18002:8002 \
  -e build_admins=False -e build_elevation=False -e build_tar=True \
  -e build_time_zones=False -e force_rebuild=True -e server_threads=2 \
  -e tile_urls= \
  -e traffic_name= -e use_default_speeds_config=True -e use_tiles_ignore_pbf=False \
  -e default_speeds_config_url=https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json \
  -v "$valhalla_stage:/custom_files" \
  ghcr.io/valhalla/valhalla-scripted:3.8.2
```

The repair is idempotent, fails closed on missing or invalid province geometry, and preserves
`admins.pre-country-parent.sqlite` for rollback. Do not set `build_admins=True` on the second run;
that would replace the repaired database before graph enhancement. Verify the rebuilt service on
port `18002` and run the 50-route Calgary gate before changing `VALHALLA_DATA_DIR`.

After the rebuilt Valhalla process is healthy, stop it and stage Nominatim with a password of its
own (never production's; see [Nominatim staging password](#nominatim-staging-password)):

```sh
stage_env="$(dirname "$nominatim_stage")/staging-password.env"
(umask 077 && printf 'NOMINATIM_PASSWORD=%s\n' "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" >"$stage_env")
sudo docker create --name navoss-nominatim-stage --env-file "$stage_env" \
  --cpus 2.5 --memory 6g --shm-size 2g -p 127.0.0.1:18080:8080 \
  -e FREEZE=true -e GUNICORN_WORKERS=2 -e IMPORT_SECONDARY_WIKIPEDIA=false \
  -e IMPORT_STYLE=full -e IMPORT_WIKIPEDIA=false \
  -e PBF_PATH=/regional-data/regional.osm.pbf \
  -e POSTGRES_AUTOVACUUM_WORK_MEM=256MB -e POSTGRES_EFFECTIVE_CACHE_SIZE=6GB \
  -e POSTGRES_MAINTENANCE_WORK_MEM=2GB -e POSTGRES_MAX_CONNECTIONS=30 \
  -e POSTGRES_MAX_LOCKS_PER_TRANSACTION=256 \
  -e POSTGRES_MAX_WAL_SIZE=2GB -e POSTGRES_SHARED_BUFFERS=1GB \
  -e POSTGRES_WORK_MEM=32MB -e THREADS=2 -e UPDATE_MODE=none \
  -v "/srv/navoss/artifacts/imports/alberta-british-columbia-${version}.osm.pbf:/regional-data/regional.osm.pbf:ro" \
  -v "$nominatim_stage:/var/lib/postgresql/16/main" \
  mediagis/nominatim:5.3
start_script=$(mktemp)
sudo docker cp navoss-nominatim-stage:/app/start.sh "$start_script"
sudo sed -i '1s|^#!/bin/bash -ex$|#!/bin/bash -e|' "$start_script"
head -n 1 "$start_script"   # must print #!/bin/bash -e
sudo docker cp "$start_script" navoss-nominatim-stage:/app/start.sh
sudo rm -f "$start_script"
init_script=$(mktemp)
sudo docker cp navoss-nominatim-stage:/app/init.sh "$init_script"
sudo sed -i '1s|^#!/bin/bash -ex$|#!/bin/bash -e|' "$init_script"
sudo sed -i '/cp \/etc\/postgresql\/16\/main\/conf.d\/postgres-import.conf.disabled/a sed -i "s/^#max_locks_per_transaction = 64/max_locks_per_transaction = ${POSTGRES_MAX_LOCKS_PER_TRANSACTION}/" /etc/postgresql/16/main/postgresql.conf' "$init_script"
sudo docker cp "$init_script" navoss-nominatim-stage:/app/init.sh
sudo rm -f "$init_script"
sudo docker start navoss-nominatim-stage
```

The one-off script patches disable upstream command tracing in both image scripts before startup;
otherwise the image prints the password in `useradd -p` (start.sh) and while creating roles
(init.sh). Follow progress with
`sudo docker logs --tail 100 navoss-nominatim-stage` and inspect the versioned database size without
printing environment values.

Probe both staging services directly. After Calgary, Kelowna, and both intercity directions pass,
record the previous four `.env` values, set `VALHALLA_DATA_DIR`, `NOMINATIM_DATA_DIR`,
`NOMINATIM_PBF_PATH`, and `NOMINATIM_DATASET_VERSION` to the staged release, validate
`sudo docker compose config --quiet`,
and prebuild the exact API image before touching live services. Then cut over all dependent services:

```sh
sudo docker compose build api
sudo docker compose up -d --no-build --wait --wait-timeout 300 valhalla nominatim api caddy
./refresh-nominatim-special-phrases.sh
./check-stack.sh
```

Rollback restores the previous four `.env` values and reruns the same four-service command.
Versioned artifacts are never deleted during deployment.

### Nominatim staging password

`mediagis/nominatim:5.3` uses `NOMINATIM_PASSWORD` in two places, both checked against the image:

- `start.sh`, in every new container: `useradd -m -p "$NOMINATIM_PASSWORD" nominatim`. That writes
  the raw value into the container's own `/etc/shadow` (not a crypt hash, so it cannot be used to log
  in); it is not in the data directory and goes when the container goes.
- `init.sh`, only while importing: `ALTER USER nominatim` (a superuser) and `ALTER USER "www-data"`
  `WITH ENCRYPTED PASSWORD`. Those role passwords live in the cluster, so they move with the
  artifact.

After the import nothing NavOSS runs uses them. Nominatim's API (gunicorn as `nominatim`) and
`refresh-nominatim-special-phrases.sh` (`exec --user nominatim`) connect over the Unix socket, where
`pg_hba.conf` uses peer authentication. The role passwords only answer TCP logins: PostgreSQL listens
on all interfaces with `host all all 0.0.0.0/0 md5`, unpublished but reachable on port 5432 from any
container on the `backend` and `egress` networks.

`stage-coverage.sh nominatim` therefore generates a password per stage
(`<stage>/staging-password.env`, mode 600, 48 hex digits) instead of copying production's, and the
cutover needs no password step: the production `.env` value no longer matches the staged cluster's
roles, which nothing uses. Keep `staging-password.env` with the cluster as its TCP credential. Both
image scripts trace every command (`bash -ex`), which prints the password; staging turns tracing off
in both and refuses to start an image whose first line is no longer `#!/bin/bash -ex`. The live
service starts `start.sh` as `bash -e` (`entrypoint` in `compose.yaml`), so recreating it at the
cutover logs no password. `init.sh` still traces if Compose is ever pointed at an unimported
directory, which this runbook never does.

## Canada coverage release (Geofabrik 261114)

Design, sizing and the reasons for each step: [`docs/architecture/north-america.md`](../../docs/architecture/north-america.md#canada-wide-coverage).
This builds the whole-country Valhalla graph and Nominatim index beside the live Alberta+BC stack,
verifies them through a staged API, then switches by changing `.env`. Nothing live is touched until
step 6, and the Alberta+BC artifacts stay until Canada has been proven.

Sized for the production VM at 6 cores, 24 GiB RAM and a 260 GB artifact disk. Run each step in `tmux` from
the deployed `infra/compose`; every step is resumable by running the same command again. `inputs`
and `valhalla` may run as the deployment user or root. On this VM, run `nominatim`, `serve`, `verify` and
`stop` as root with `sudo -n env GEOFABRIK_VERSION=<version> ./stage-coverage.sh <step> <label>`:
the live Nominatim directory's root-owned parent is not inspectable by the deployment user, and the script
refuses rather than guessing whether a stage is live. The deployment user already reaches Docker through sudo,
which is root-equivalent, so running the script as root adds no privilege.

One step runs at a time: `inputs`, `valhalla`, `nominatim`, `serve` and `stop` hold
`/srv/navoss/artifacts/.stage.lock` (`flock`) for their whole run, so a second invocation is refused
even between Valhalla passes when no container is up, and a heavy step is also refused while the
staged services from `serve` are running. During steps 2 and 3 keep at least 4 GiB available
(`free -h`) and no sustained swap. Ctrl-C does not stop a lock-holding step: it runs in its own session.
Instead, use `sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh stop canada` from another
terminal or tmux window; it ends the running step itself, then removes the staging containers.
Rerun the step to resume.

Run the script from the deployed `infra/compose` (or a checkout with that `.env` copied beside it):
it reads the live `VALHALLA_DATA_DIR` and `NOMINATIM_DATA_DIR` from the `.env` next to it, and every
step refuses when that file is missing or unreadable. Before changing, mounting or starting anything,
a step refuses when its stage directory is the live one by device and inode (however `.env` writes
the path), or when either cannot be inspected. Every staging container is labelled with the step
that started it, and no step starts a container while another step's container (or an unlabelled one
from an older script) still runs; `stop` removes them. `stop` signals the running step only after
checking that the recorded pid still has the start time it was recorded with.

The Valhalla and Nominatim containers write as root (Valhalla's tiles, archive, configs and admin
database; the cluster as the image's `postgres` user). Root-run steps hand script-created stage
directories and metadata back to the artifact root's owner; a root-created staging password stays
root-only (mode 600), and container-written files and the PostgreSQL cluster are never chowned. No step prompts
(stdin is closed and every replacement is `mv -f`), and whatever the operator cannot delete (an
interrupted pass 1's tile tree, an interrupted import's cluster) is removed by a root container with no
network that mounts only that stage, after the same live-directory identity checks.
An import started by the older script keeps running that older code. After it finishes, run the
updated `nominatim` step again as root (it detects the completion marker and does not reimport),
or run the updated `serve` step; either hands its stage and completion marker back for `status`.

The deployment user is not in the `docker` group on the production VM, and the scripts call plain `docker`. Put a wrapper
first on `PATH` for the session, which runs Docker through passwordless sudo:

```sh
mkdir -p ~/bin && printf '#!/bin/sh\nexec sudo -n docker "$@"\n' >~/bin/docker && chmod 0755 ~/bin/docker
export PATH="$HOME/bin:$PATH"
```

Every step needs `GEOFABRIK_VERSION` exported, and every step after `inputs` refuses unless it
equals the release `inputs` recorded, so no step can resolve a newer daily release (the fallback
below included). Each step also refuses to start unless its free-space floor is free on the artifact
disk (`STAGE_MIN_FREE_GB` overrides the floor for small samples only). Memory is the configured
container limit, which is what the kernel enforces; there is no swap.

0. **Update checkout and API image:** approximately 5 minutes; 1 GB on disk; image build only.
1. **`inputs`:** 9 minutes measured, 20 GB disk floor, +6.5 GB artifacts; no container, osmium check-refs approximately 2 GiB on the host.
2. **`valhalla`:** both passes and admin repair approximately 35 minutes measured, 30 GB floor, 3.9 GB kept after cleanup; build 8 GiB and spatialite helpers 1 GiB, never together.
3. **`nominatim`:** 147 minutes measured, 130 GB floor, 18 GB frozen database, peak disk about 89 GB; import 10 GiB with `--osm2pgsql-cache 3000`.
4. **`serve` and `verify`, host-network matrix:** approximately 30 minutes, 2 GB floor; Valhalla 4 GiB, Nominatim 6 GiB, API 0.75 GiB.
5. **`stop`:** approximately 1 minute; frees the staged serving containers.
6. **Cutover:** 5–10 minutes, approximately 1 minute API restart; live limits 10.19 → 14.19 GiB.

Worst case against the 24 GiB host, by limits. The live stack's limits are 10.19 GiB (API 0.75,
search indexer 0.5, Caddy 0.19, Valhalla 2, Nominatim 6, reports database 0.75). The lock allows
only one row at a time:

| Phase              | Live limits | Staging limits | Total  | Left of 24 GiB |
| ------------------ | ----------- | -------------- | ------ | -------------- |
| `inputs`           | 10.19       | 0 (host ≈ 2)   | ≈ 12.2 | ≈ 11.8         |
| `valhalla` build   | 10.19       | 8              | 18.19  | 5.81           |
| `nominatim` import | 10.19       | 10             | 20.19  | 3.81           |
| `serve` (staged)   | 10.19       | 10.75          | 20.94  | 3.06           |
| After the cutover  | 14.19       | 0              | 14.19  | 9.81           |

Limits are ceilings, not use: the kernel kills a container at its limit instead of the host
swapping. Steps 3 and 4 leave less than the 4 GiB floor only if every container reaches its limit
at once; watch `free -h` as below.

The all-Canada `inputs` removed 4,456 seasonal or ice-road ways and passed check-refs.
Both Valhalla passes produced 8,767 tiles and a 3.9 GB stage after cleanup in about 35 minutes.
Nominatim took 147 minutes and produced an 18 GB frozen database. The first attempt was OOM-killed
after 10 minutes: the image ignored `OSM2PGSQL_CACHE` and selected 12.4 GB. #124 passes
`--osm2pgsql-cache 3000` explicitly. After cutover 60 GB of 255 GB was used.

```sh
cd /home/navoss/NavOSS/infra/compose
# 0. Code: this branch's API and scripts. The live API keeps running its current image.
git fetch origin && git checkout <merged main> && sudo docker compose build api
sudo apt-get install -y osmium-tool jq   # once
export GEOFABRIK_VERSION=261114        # the one release every step below uses
./stage-coverage.sh status canada

# 1. Inputs. Uses the extract already at imports/canada-261114.osm.pbf (MD5 checked on download);
#    writes canada-261114.osm.pbf.md5, SHA256SUMS-canada-261114 and canada-261114.routing.osm.pbf
#    (seasonal and ice roads removed, relation members included; the report counts what was
#    removed). It is written only if every kept way's nodes are present and no relation lost a
#    member other than a removed way (osmium check-refs). An earlier filter's output is regenerated.
GEOFABRIK_MD5=0bba746e7473aac6a7a6796d153ea12d ./stage-coverage.sh inputs canada

# 2. Routing graph: /srv/navoss/artifacts/valhalla-canada-261114 (pass 1 builds admins, the
#    repair links all 13 provinces to Canada, pass 2 rebuilds with the hybrid speeds for AB and ON).
./stage-coverage.sh valhalla canada

# 3. Search index: /srv/navoss/artifacts/nominatim/canada-261114/postgres. Follow with
#    `sudo docker logs --tail 20 navoss-nominatim-stage`. An interrupted import restarts from the
#    beginning on the next run (the image cannot resume one): the cluster, owned by the image's
#    postgres user, is removed by a root container that mounts only that staged directory, with no
#    network, after checking the path is nominatim/<label>-<YYMMDD> and not the live cluster.
sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh nominatim canada

# 4. Staged API on 127.0.0.1:18300 declaring Canada, then the coverage checks.
sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh serve canada
sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh verify canada
```

On the production VM, sshd has `AllowTcpForwarding no`, so an SSH tunnel cannot reach the staged port. Run
the matrices from a read-only Node container on the host network instead. Every route must pass,
or have a reviewed, recorded reason:

```sh
mkdir -p /tmp/rq
sudo docker run --rm --network host --read-only --cap-drop ALL --memory 512m -v ~/NavOSS/apps/api/scripts:/s:ro -v /tmp/rq:/out -w /s -e NAVOSS_API_URL=http://127.0.0.1:18300 -e ROUTE_QUALITY_CASES=./route-quality-canada.json -e ROUTE_QUALITY_OUTPUT=/out/route-quality-canada-staged.json node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d node ./route-quality.mjs
# Repeat with ROUTE_QUALITY_CASES=./route-quality-alberta-bc.json and a different output name.
```

For the live stack use `NAVOSS_API_URL=http://127.0.0.1:8080`. On 2026-11-15 staged and live
Alberta+BC passed 22/22 and Canada 72/80 (live p95 475 ms); all eight failures were reviewed as
threshold artifacts. After adjusting the checks, a sequential public HTTPS run at 15:53 UTC with
at most one request per second passed 80/80 at 652 ms p95.

To run from a local checkout against production without exceeding one request per second:

```sh
NAVOSS_API_URL=https://navoss-api.yassin.app \
  ROUTE_QUALITY_CASES=./apps/api/scripts/route-quality-canada.json \
  ROUTE_QUALITY_OUTPUT=artifacts/route-quality-canada-live.json \
  ROUTE_QUALITY_REQUEST_INTERVAL_MS=1100 node apps/api/scripts/route-quality.mjs
```

Also search in each province on the staged API (a city name with its readiness-probe coordinate),
compare the Alberta+BC 22 with the live artifact, and check one Montreal route speaks French street
names as expected (architecture document, "Quebec").

```sh
# 5. Stop staging (frees up to 10.75 GiB); the staged artifacts stay.
sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh stop canada

# 6. Cutover: four artifact values, the declaration and two memory limits.
cp -p .env ".env.pre-canada-$(date -u +%Y%m%dT%H%M%SZ)"
sed -i \
  -e 's|^VALHALLA_DATA_DIR=.*|VALHALLA_DATA_DIR=/srv/navoss/artifacts/valhalla-canada-261114|' \
  -e 's|^NOMINATIM_DATA_DIR=.*|NOMINATIM_DATA_DIR=/srv/navoss/artifacts/nominatim/canada-261114/postgres|' \
  -e 's|^NOMINATIM_PBF_PATH=.*|NOMINATIM_PBF_PATH=/srv/navoss/artifacts/imports/canada-261114.osm.pbf|' \
  -e 's|^NOMINATIM_DATASET_VERSION=.*|NOMINATIM_DATASET_VERSION=canada-geofabrik-2026-11-14|' .env
grep -q '^NAVOSS_SERVICE_AREAS=' .env || echo 'NAVOSS_SERVICE_AREAS=' >> .env
grep -q '^VALHALLA_MEM_LIMIT=' .env || echo 'VALHALLA_MEM_LIMIT=' >> .env
grep -q '^NOMINATIM_MEM_LIMIT=' .env || echo 'NOMINATIM_MEM_LIMIT=' >> .env
sed -i \
  -e 's|^NAVOSS_SERVICE_AREAS=.*|NAVOSS_SERVICE_AREAS=alberta,british-columbia,ontario,quebec,manitoba,saskatchewan,new-brunswick,nova-scotia,prince-edward-island,newfoundland-and-labrador,yukon,northwest-territories,nunavut|' \
  -e 's|^VALHALLA_MEM_LIMIT=.*|VALHALLA_MEM_LIMIT=4g|' -e 's|^NOMINATIM_MEM_LIMIT=.*|NOMINATIM_MEM_LIMIT=8g|' .env
sudo docker compose config --quiet
sudo docker compose up -d --no-build --wait --wait-timeout 600 valhalla nominatim api caddy
./refresh-nominatim-special-phrases.sh
./check-stack.sh     # includes check-coverage.sh for all 13 provinces
```

The API publishes a declared province only once its routing and search data have answered its
probe (it retries for 20 s at startup, then checks every 30 s). If `check-stack.sh` fails on
`/v2/config` or `/ready` coverage, the cutover is half-applied (for example search still on the
Alberta+BC index): phones are told only what answers, but roll back rather than wait.

Then rerun the matrix against `https://navoss-api.yassin.app` and record the result. With community
traffic in `collect`, restart nothing else: traffic stays Alberta+BC (its probes are refused
elsewhere) and is matched on the new graph.

**Rollback** restores the saved `.env` (pattern `.env.pre-canada-YYYYMMDDTHHMMSSZ`; the 2026-11-15
backup is `.env.pre-canada-20261115T154413Z`) and recreates the same four services. The
Alberta+BC artifacts were never changed:

```sh
cp -p .env.pre-canada-<timestamp> .env
sudo docker compose up -d --no-build --wait --wait-timeout 600 valhalla nominatim api caddy
./check-stack.sh
```

The guard freshness check can coincide with the five-minute timer. While the oneshot is
activating, `check-stack.sh` waits up to 184 seconds for the configured 180-second service timeout
and then checks its result and completed timestamp; failure, a stale run or a withdrawn manifest
still fails the check. At cutover the original check saw `ended never` during a run; a rerun passed.

Keep `valhalla-alberta-british-columbia-260730-ca-parent`, `nominatim/alberta-british-columbia-260730`
and their extracts until Canada has run cleanly for at least a week of tester use; then delete them
deliberately, never as part of a deployment.

**Staged search (fallback).** If step 3 cannot finish within these limits (memory pressure,
swap growth, or the disk peak), keep the Canada graph and import search for fewer provinces, for
example `./stage-coverage.sh inputs alberta british-columbia ontario quebec` then
`sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh nominatim alberta british-columbia ontario quebec`
(the exported `GEOFABRIK_VERSION=261114` pins inputs to the graph's release; a mismatch is refused),
and declare only those provinces (`NAVOSS_SERVICE_AREAS`,
`NOMINATIM_DATASET_VERSION=alberta-british-columbia-ontario-quebec-geofabrik-2026-11-14`). The API
refuses to declare a province its search index lacks, so the app never offers search or routes
where search would fail. `serve` and `verify` expect a graph under the same label; link the Canada
graph to it first (`ln -s valhalla-canada-261114 /srv/navoss/artifacts/valhalla-<label>-261114`).

## Speed-profile rebuild of the live graph

A change to `prepare-valhalla-speeds.sh` reaches routes only through a rebuilt graph.
These steps build a **base graph** for the base stack (`compose.yaml` alone, community traffic
`off` or `collect`), which is what production runs. A stack on the verified traffic overlay
(`compose.traffic-graph.yaml`) cannot take this directory: it needs its own new `serving-graph.mts`
archive, provenance record, dead-end mask and graph id, installed as that section describes.
`/ready` and `check-stack.sh` do not check which speed profile a graph was built with; the hash
comparison below is the only identity check.

`stage-coverage.sh valhalla` refuses the live directory and reports a finished stage as complete,
so rebuild the same extract beside it. The admin database is already repaired, so only the second
Valhalla pass runs: about 35 minutes on the production VM, 8 GiB for the build container beside the live
stack, and about 3.9 GB kept (the extract is a hard link). Check `df -h /srv/navoss/artifacts`
first; the build peaks well above what it keeps. Run under tmux from the deployed
`~/NavOSS/infra/compose` at the commit whose profile is wanted:

```sh
live=/srv/navoss/artifacts/valhalla-canada-261114
stage=/srv/navoss/artifacts/valhalla-canada-261114-speeds-$(date -u +%y%m%d)
install -d -m 0750 "$stage"
ln "$live/canada-261114.osm.pbf" "$stage/"
cp -p "$live/admins.sqlite" "$live/timezones.sqlite" "$stage/"
# Prints the profile hash: 27bdcff0… at this commit, 8f8e60ea… at the commit before the urban
# secondary change (docs/testing/route-quality.md, "Calgary arterial and freeway speeds").
VALHALLA_HYBRID_PROVINCES='AB ON' ./prepare-valhalla-speeds.sh "$stage"
cat "$stage/default_speeds.provenance"

sudo docker run -d --name navoss-valhalla-stage \
  --cpus 4 --cpuset-cpus 0-3 --memory 8g --memory-swap 8g -p 127.0.0.1:18002:8002 \
  -e build_admins=False -e build_elevation=False -e build_tar=True \
  -e build_time_zones=False -e force_rebuild=True -e server_threads=2 \
  -e tile_urls= \
  -e traffic_name= -e use_default_speeds_config=True -e use_tiles_ignore_pbf=False \
  -e default_speeds_config_url=https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json \
  -v "$stage:/custom_files" \
  ghcr.io/valhalla/valhalla-scripted:3.8.2
until curl --fail --silent http://127.0.0.1:18002/status >/dev/null; do
  sudo docker inspect --format '{{.State.Running}}' navoss-valhalla-stage | grep -q true || break
  sleep 30
done
sudo docker logs --tail 5 navoss-valhalla-stage
```

If the container stopped (two local builds in fifteen ended with a segmentation fault in the
`enhance` stage and each succeeded when rerun), remove it, empty the stage's `valhalla_tiles` and
start it again. Then check the staged graph before anything live changes. The profile must be the
one generated, a Deerfoot Trail edge must carry its posted limit as a `tagged` speed of 100 (88
`classified` on the previous profile), and
northbound Macleod Trail from Anderson Road to 7 Avenue SE must take about 15.4 minutes (23.9 on
the previous profile):

```sh
(cd "$stage" && sha256sum default_speeds.json && grep profile_sha256 default_speeds.provenance)
curl -s http://127.0.0.1:18002/locate \
  -d '{"locations":[{"lat":51.02145,"lon":-114.00175}],"costing":"auto","verbose":true}' |
  jq -c '.[0].edges[] | {names: .edge_info.names, limit: .edge_info.speed_limit, speeds: .edge.speeds}'
curl -s http://127.0.0.1:18002/route \
  -d '{"locations":[{"lat":50.95031,"lon":-114.07099},{"lat":51.04636,"lon":-114.05807}],"costing":"auto"}' |
  jq '.trip.summary | {km: .length, minutes: (.time / 60)}'
sudo docker rm -f navoss-valhalla-stage
```

Cutover recreates Valhalla and the API together (the API erases published traffic releases on
start, and its keys do not outlive a graph):

```sh
cp -p .env ".env.pre-speeds-$(date -u +%Y%m%dT%H%M%SZ)"
sed -i "s|^VALHALLA_DATA_DIR=.*|VALHALLA_DATA_DIR=$stage|" .env
sudo docker compose config --quiet
sudo docker compose up -d --no-build --wait --wait-timeout 600 valhalla api
./check-stack.sh   # airport route: about 1100 s on this profile (window 1050–1300 s)
```

Then run the fifty-route Calgary gate and the Canada matrix against
`https://navoss-api.yassin.app` (`docs/testing/route-quality.md`, "Reproduce") and record the
result. **Rollback** restores the saved `.env` and recreates the same two services; the previous
graph directory is never changed:

```sh
cp -p .env.pre-speeds-<timestamp> .env
sudo docker compose up -d --no-build --wait --wait-timeout 600 valhalla api
./check-stack.sh
```

## Database migrations and community reports

Community-report and community-traffic tables are created by explicit, ordered SQL migrations
(`apps/api/src/migrations.ts`), not at API startup. The API refuses community-report
requests with `503` until every migration is applied, and refuses to start with community traffic
in `collect` or `live`. Apply them before starting a new API image:

```sh
sudo docker compose build api
sudo docker compose run --rm --no-deps api node dist/migrate.js
sudo docker compose up -d --no-build --wait --wait-timeout 300 api caddy
./check-stack.sh
```

`migrate.js` takes an advisory lock, applies each pending migration in its own transaction,
records it in `navoss_schema_migrations`, and refuses to continue if an applied migration's SQL
changed. It is safe to repeat. Migrations are additive; rolling the API image back leaves the new
tables unused. The older runtime-created tables (contributions, search index, Google budget) are
unchanged.

Because there is one ledger, an image that carries a new migration reports it as pending for
every feature: start this image without running `migrate.js` and community-report requests answer
`503` until it is run, even with community traffic `off`.

Writes need `APP_ATTEST_TEAM_ID` and `COMMUNITY_INSTALLATION_SECRET` in `.env`; without them
`/v2/community/*` writes return `503` and reads follow `COMMUNITY_REPORTS_PUBLICATION`. Keep the
secret out of Git and do not rotate it casually: it keys the stored key-id hashes and seals the
stored public keys, so rotation forces every phone to register a new App Attest key.

Publication (`COMMUNITY_REPORTS_PUBLICATION`):

- `shadow` (code and example default): store and score reports, show none. `features.communityReports`
  in `/v1/config` and `/v2/config` is `false`.
- `attested`: the beta setting for a small group of TestFlight drivers. A report from an App
  Attest-verified installation is returned immediately as `unconfirmed` with `confirmations: 0`
  and becomes `confirmed` after independent corroboration. Config reports `communityReports: true`.
- `corroborated`: only reports with a sufficient lower confidence bound and at least two
  independent installations are returned.

To run the beta: set `COMMUNITY_REPORTS_PUBLICATION=attested`, the team id, and the secret; apply
migrations; recreate `api`; then confirm `curl -s http://127.0.0.1:8080/v2/config` shows
`"communityReports":true`. Set it back to `shadow` and recreate `api` to stop showing reports
immediately (the kill switch). `COMMUNITY_ATTESTATION_MODE=allow-development` admits simulator
installations as untrusted with much lower limits; never use it on the production API.

## Provincial coverage and API-v2 routing rollout

This is an API-image cutover, not a graph/geocoder rebuild. Retain
`ghcr.io/valhalla/valhalla-scripted:3.8.2` and the existing versioned Alberta+BC artifacts.
V2 uses its binary request/response protocol for lane/sign/limit data; v1 stays legacy-shaped.
Record the actual running API image id and tag **before** building, and retain a rollback tag:

```sh
api_container_before=$(sudo docker compose ps -q api)
api_image_before=$(sudo docker inspect --format '{{.Image}}' "$api_container_before")
api_tag_before=$(sudo docker inspect --format '{{.Config.Image}}' "$api_container_before")
sudo docker image tag "$api_image_before" navoss-api:pre-provincial-v2

sudo docker compose build api
sudo docker compose run --rm --no-deps api node dist/migrate.js
sudo docker compose up -d --no-build --wait --wait-timeout 300 api caddy

curl --fail --silent http://127.0.0.1:8080/v1/config |
  jq -e '.apiVersion == "v1" and .coverage.id == "calgary-ab" and .endpoints.routes == "/v1/routes"'
curl --fail --silent http://127.0.0.1:8080/v2/config |
  jq -e '.coverage.id == "alberta-british-columbia" and .endpoints.routes == "/v2/routes"
    and all(.coverage.serviceAreas[]; .boundary.type == "MultiPolygon")'

# This is a committed public Calgary fixture, never an operator's private location/trip.
jq '.request' ../../apps/api/test/fixtures/valhalla/calgary-deerfoot-glenmore.json |
  curl --fail --silent -H 'Content-Type: application/json' --data-binary @- \
    http://127.0.0.1:8080/v2/routes |
  jq -e '.source.id == "valhalla-self-hosted" and
    any(.routes[].steps[]; .exitNumber == "248" and (.lanes | length) > 0)'
curl --fail --silent http://127.0.0.1:8080/ready |
  jq -e '.status == "ready" and
    ((.checks.routingProvider.detail // "") | contains("degraded") | not)'
```

Then, from a validated repository checkout on the operator's machine, run the complete
22-directed-route matrix against the deployed full Alberta+BC service:

```sh
NAVOSS_API_URL=https://navoss-api.yassin.app \
  ROUTE_QUALITY_OUTPUT=artifacts/route-quality-alberta-bc-22.json \
  corepack pnpm --filter @navoss/api test:routes:alberta-bc
```

The required order is migrations → API start → strict v1 configuration → provincial v2
configuration → a lane-bearing v2 route → the regional matrix. Keep community-report publication
settings unchanged. The local Calgary protocol fixture is not a substitute for the full matrix.
Confirm v1 clients still route before rolling phone/native clients onto `/v2/routes`.

If the candidate API fails its gates, restore the saved image to its **actual Compose tag** and
recreate only the API; do not roll back/delete the geospatial artifacts or additive SQL migrations:

```sh
sudo docker image tag navoss-api:pre-provincial-v2 "$api_tag_before"
sudo docker compose up -d --no-build --wait --wait-timeout 300 api caddy
./check-stack.sh
```

The production API cutover was performed on 2026-11-15; the rollback image tag
`navoss-api:pre-provincial-v2` is retained. A rollback was not performed.

## First import

For a new host with no live service to preserve, the two geospatial imports are intentionally
sequential:

```sh
sudo docker compose pull valhalla nominatim reports-db caddy
sudo docker compose up -d valhalla
sudo docker compose ps
```

Wait for Valhalla to become healthy and verify Calgary and Kelowna route endpoints before
starting Nominatim:

```sh
sudo docker compose up -d nominatim
sudo docker compose ps
```

After Nominatim becomes healthy, start the database and daily Calgary Open Data indexer:

```sh
sudo docker compose up -d --build reports-db search-indexer
sudo docker compose ps
```

Wait for `search-indexer` to become healthy, then start the API and ingress:

```sh
sudo docker compose up -d --build --wait --wait-timeout 300 api caddy
./check-stack.sh
```

Import the checked-in Nominatim category phrases after the initial Nominatim import and after any
replacement of its persistent database. The import is additive and safe to repeat:

```sh
./refresh-nominatim-special-phrases.sh
```

These phrases make Restaurants, Groceries, and Parks query OSM tags rather than requiring the
category word to appear in a place name. The API still validates each returned OSM type and ranks
the final candidates by distance.

Indexer health requires both expected sources, bounded record counts, and a successful import
within the previous 36 hours. A failed refresh keeps the current and previous accepted indexes;
the API can fall back to Nominatim with an explicit degraded response while the index is repaired.

Install the bounded host-log policy before recreating services with the
`journald` logging driver:

```sh
sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo install -m 0644 ../host/20-navoss-retention.conf \
  /etc/systemd/journald.conf.d/20-navoss-retention.conf
sudo install -m 0644 ../host/rsyslog.logrotate /etc/logrotate.d/rsyslog
sudo logrotate --debug /etc/logrotate.d/rsyslog
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-time=7d
```

Install the reboot and backup units after the full stack is healthy:

```sh
sudo install -m 0644 navoss-stack.service /etc/systemd/system/
sudo install -m 0644 navoss-backup.service /etc/systemd/system/
sudo install -m 0644 navoss-backup.timer /etc/systemd/system/
sudo install -m 0750 backup-reports-db.sh /home/navoss/NavOSS/infra/compose/
sudo systemctl daemon-reload
sudo systemctl enable navoss-stack.service navoss-backup.timer
sudo systemctl start navoss-stack.service navoss-backup.timer
```

Do not enable `navoss-stack.service` until the initial Valhalla and Nominatim
imports and the complete stack check have passed.

Do not start both initial imports simultaneously. During either import, monitor
`free -h`, `swapon --show`, `docker stats`, disk usage, and kernel OOM messages.

## Offline bundle manifest

Offline bundles are downloaded by the phone directly from Cloudflare R2 at
`https://navoss-offline.yassin.app` ([hosting record](../offline/README.md#hosting)); this stack
serves only the small manifest at `GET /v1/offline/manifest` and never proxies artifacts. With
`NAVOSS_OFFLINE_MANIFEST_DIR` blank (the default) `/dev/null` is mounted, the endpoint answers a
quiet 503, and the app says "Offline maps are not available yet". The API image is unchanged: the
endpoint has been deployed since #83.

The directory, not the file, is mounted read-only. The API reads `manifest.json` in it on every
request, so a rename on the host takes effect at the next request with no restart: installing a
new release is an atomic `mv`, and the offline guard withdraws the manifest by renaming it to
`manifest.json.stopped`, which returns the endpoint to the quiet 503.

### Offline guard (install first)

The guard stops hosting automatically before it could cost money ([how it
decides](../offline/README.md#automatic-stop)). Install it **before** publishing a manifest. It
needs an account API token with exactly `Account Analytics Read` and `Workers R2 Storage Write`
for this account.

```sh
sudo install -d -m 0700 -o root -g root /srv/navoss/state/offline-guard
sudo install -d -m 0755 -o navoss -g navoss /srv/navoss/artifacts/offline
sudo install -m 0600 -o root -g root /dev/null /srv/navoss/state/offline-guard.env
sudoedit /srv/navoss/state/offline-guard.env
# CLOUDFLARE_API_TOKEN=<guard token>
# CLOUDFLARE_ACCOUNT_ID=<account id>
# The guard runs with --pull never, so pull its digest-pinned image once.
sudo docker pull node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
sudo install -m 0644 navoss-offline-guard.service navoss-offline-guard.timer \
  navoss-offline-withdraw.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now navoss-offline-guard.timer
sudo systemctl start navoss-offline-guard.service; journalctl -u navoss-offline-guard -n 3
# First run: "usage not established (1/4 …): analytics do not yet show the previous run's
# heartbeat", exit 2, unit not failed. About 5 minutes later the timer's run prints "within
# limits (Class A …, Class B …, … bytes)". Any "Cloudflare API 403" means a missing permission.
```

A failed unit (`systemctl --failed`) means the guard stopped hosting (exit 1) or could not start;
either way `navoss-offline-withdraw.service` has withdrawn the manifest. Exit 2 (usage not
established this run) does not fail the unit; the guard stops hosting itself after four in a row.
Its journal line says which and why.

### Publish the manifest

Publish a manifest only after every artifact it names is uploaded and verified
(`node --import tsx infra/offline/verify-hosting.mts MANIFEST` from a workstation), and only with
the guard's timer active. Then, on the VM:

```sh
# 1. Install the manifest read-only. Copy it from the workstation first, e.g.
#    scp artifacts/offline-hosting/manifest.production.json VM:/tmp/navoss-offline-manifest.json
sudo install -m 0444 -o navoss -g navoss /tmp/navoss-offline-manifest.json \
  /srv/navoss/artifacts/offline/manifest.json.next
sha256sum /srv/navoss/artifacts/offline/manifest.json.next   # compare with the workstation's value
jq -r .bundleVersion /srv/navoss/artifacts/offline/manifest.json.next
sudo mv /srv/navoss/artifacts/offline/manifest.json.next /srv/navoss/artifacts/offline/manifest.json

# 2. First time only: point the api at the directory and recreate only the api.
sudoedit .env   # NAVOSS_OFFLINE_MANIFEST_DIR=/srv/navoss/artifacts/offline
sudo docker compose config --quiet
sudo docker compose up -d --no-build --force-recreate --wait --wait-timeout 300 api

# 3. Verify: the endpoint serves this manifest and every artifact answers with its exact length.
NAVOSS_OFFLINE_MANIFEST_DIR=/srv/navoss/artifacts/offline ./check-stack.sh
curl -fsS https://navoss-api.yassin.app/v1/offline/manifest | jq -r .bundleVersion
```

A later release repeats step 1 only (the `mv` replaces the manifest atomically) and step 3.

**Roll back** by renaming `manifest.json` away (quiet 503 at once), or permanently by blanking
`NAVOSS_OFFLINE_MANIFEST_DIR` in `.env` and recreating the api as in step 2; `./check-stack.sh`
run without the variable then requires the quiet 503. Devices keep regions they already
installed; they cannot download or update until a manifest is served again. The manifest alone
does not stop a client that already knows the artifact URLs: only disabling the custom domain
does, which the guard does on its own.

## Privacy posture

- Mobile search uses `POST /v1/search` with a JSON body; search text and optional
  proximity do not enter public URLs.
- The indexer mirrors public Calgary business and parcel-address datasets independently;
  live user queries are evaluated locally and never forwarded to Calgary Open Data.
- Fastify automatic request logging is disabled.
- Caddy access logging is not enabled.
- Nominatim, Valhalla, and PostgreSQL have no host-published ports.
- All six containers use journald; host journals are capped at seven days and
  512 MiB. SSH/firewall logs rotate daily within seven days.
- The reports database disables statement/duration logging and suppresses SQL
  text and parameter values from error logs.
- Cloudflare Tunnel forwards only the public API hostname to local Caddy.
- Report-database dumps are mode 0640, compressed, and retained for 14 days.
  They exclude the reproducible public search index and the rows of the short-lived
  community-report tables, and do not contain user search, route, or trip data.
- Community reports: no accounts. Only a keyed hash of each App Attest key id and a sealed
  public key are stored. Report positions are kept until 24 hours after expiry; each
  installation's last write position is kept rounded to about 1 km for the impossible-travel
  check and cleared after 24 hours; installations are deleted after 90 days without writes or on
  request. Vote coordinates are checked for proximity and never stored. Coordinates are never
  logged.
- Community traffic: uploads are map-matched in memory and discarded. Observations below the
  publication threshold exist only in API process memory. The database holds only already
  published per-road-edge speeds (`traffic_releases`, an unlogged table), deleted 15 minutes after
  release and erased on every API start; no position, trace, installation, or trip identifier is
  stored or logged by the API.
