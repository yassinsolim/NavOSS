# NavOSS production stack

This stack serves the Calgary–Kelowna NavOSS API from the dedicated Proxmox VM.
All geospatial and database services remain private. Caddy binds only to
`127.0.0.1:8080`; Cloudflare Tunnel is the sole public ingress.

This VM is not sized for a North America Nominatim import or blue/green continent datasets. The
capacity and rollout decision is documented in
[`docs/architecture/north-america.md`](../../docs/architecture/north-america.md). Build and validate
continent artifacts on dedicated import infrastructure before changing production extracts.

Production status: all six containers are healthy, `navoss-stack.service` and
the nightly backup timer are enabled, and public ingress is
`https://navoss-api.yassin.app`.

## Storage

- `/srv/navoss/state/postgres`: PostGIS state for the reproducible Calgary search index and future community reports. Logical backups exclude `calgary_search_*` tables.
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

Live traffic remains disabled when `MAPBOX_ACCESS_TOKEN` is blank and
`MAPBOX_VEHICLE_LICENSE_CONFIRMED=0`. Do not set the confirmation flag based on
a standard self-service account: Mapbox's current pricing terms require a
commercial application license for vehicle and in-vehicle use. After that
license is executed, store the server token only in the mode-600 `.env`, set the
confirmation flag to `1`, update the production privacy/App Store disclosures,
and rerun the route-quality and physical CarPlay gates. A token without license
confirmation, or confirmation without a token, intentionally prevents API
startup.

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
```

Run one isolated import at a time without invoking `docker compose up` for the live services. The
staging containers have no API/ingress network and use different names and host ports:

```sh
sudo docker run --rm --name navoss-valhalla-stage \
  --cpus 2 --memory 2g -p 127.0.0.1:18002:8002 \
  -e build_admins=True -e build_elevation=False -e build_tar=True \
  -e build_time_zones=False -e force_rebuild=False -e server_threads=2 \
  -e tile_urls= \
  -e traffic_name= -e use_default_speeds_config=True -e use_tiles_ignore_pbf=True \
  -v "$valhalla_stage:/custom_files" \
  ghcr.io/valhalla/valhalla-scripted:3.8.2
```

After the Valhalla process is healthy on port `18002`, stop it and stage Nominatim. Read
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
  They exclude the reproducible public search index and do not contain user search,
  route, or trip data.
