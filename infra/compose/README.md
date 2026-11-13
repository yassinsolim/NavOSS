# NavOSS production stack

This stack serves the NavOSS API using the Alberta–British Columbia geospatial artifacts.
All geospatial and database services remain private. Caddy binds only to
`127.0.0.1:8080`; Cloudflare Tunnel is the sole public ingress.

This VM is not sized for a North America Nominatim import or blue/green continent datasets. The
capacity and rollout decision is documented in
[`docs/architecture/north-america.md`](../../docs/architecture/north-america.md). Build and validate
continent artifacts on dedicated import infrastructure before changing production extracts.

Production status: all six containers are healthy, `navoss-stack.service` and
the nightly backup timer are enabled, and public ingress is
`https://navoss-api.yassin.app`.

The active routing artifact is `valhalla-alberta-british-columbia-260730-ca-parent`, with hybrid
profile SHA-256 `0a3f87cfabf76c2428ee851e1d5b61f90ef21d6952e9a4a1d4759887713931d7`. The
previous `valhalla-alberta-british-columbia-260730` artifact remains available for rollback.

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

## Community traffic

Community traffic is built from short driving batches that opted-in NavOSS drivers upload. The
design, parameters and limits are in
[`docs/architecture/community-traffic.md`](../../docs/architecture/community-traffic.md). Read
"What this does not protect against" there before going `live`. It is controlled by one value in
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
atomically creates the validated Alberta hybrid. Do not replace it with the mutable `master` URL:

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

After the rebuilt Valhalla process is healthy, stop it and stage Nominatim. Read
`NOMINATIM_PASSWORD` from the mode-600 production environment without printing it:

```sh
set -a
. ./.env
set +a
stage_env=$(mktemp)
chmod 0600 "$stage_env"
printf 'NOMINATIM_PASSWORD=%s\n' "$NOMINATIM_PASSWORD" >"$stage_env"
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
rm -f "$stage_env"
unset NOMINATIM_PASSWORD
init_script=$(mktemp)
sudo docker cp navoss-nominatim-stage:/app/init.sh "$init_script"
sudo sed -i '1s|#!/bin/bash -ex|#!/bin/bash -e|' "$init_script"
sudo sed -i '/cp \/etc\/postgresql\/16\/main\/conf.d\/postgres-import.conf.disabled/a sed -i "s/^#max_locks_per_transaction = 64/max_locks_per_transaction = ${POSTGRES_MAX_LOCKS_PER_TRANSACTION}/" /etc/postgresql/16/main/postgresql.conf' "$init_script"
sudo docker cp "$init_script" navoss-nominatim-stage:/app/init.sh
sudo rm -f "$init_script"
sudo docker start navoss-nominatim-stage
```

The one-off script patch disables upstream import-command tracing before startup; otherwise the
image prints its internal database password while creating roles. Follow progress with
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

Retain the old image tag and the image id/tag record until regional and client validation finish.
No production cutover or rollback was performed by the routing agent.

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
