# NavOSS production stack

This stack serves the Calgary/Alberta NavOSS API from the dedicated Proxmox VM.
All geospatial and database services remain private. Caddy binds only to
`127.0.0.1:8080`; Cloudflare Tunnel is the sole public ingress.

Production status: all six containers are healthy, `navoss-stack.service` and
the nightly backup timer are enabled, and public ingress is
`https://navoss-api.yassin.app`.

## Storage

- `/srv/navoss/state/postgres`: PostGIS state for the reproducible Calgary search index and future community reports. Logical backups exclude `calgary_search_*` tables.
- `/srv/navoss/artifacts/valhalla`: reproducible Alberta routing graph.
- `/srv/navoss/artifacts/nominatim/postgres`: reproducible Alberta search index.
- `/srv/navoss/artifacts/docker`: Docker images, layers, and build cache.

## Bootstrap

Create the directories and a mode-600 environment file on the VM:

```sh
sudo install -d -m 0750 -o navoss -g navoss \
  /srv/navoss/state/postgres \
  /srv/navoss/state/backups/postgres \
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

## First import

The two geospatial imports are intentionally sequential:

```sh
sudo docker compose pull valhalla nominatim reports-db caddy
sudo docker compose up -d valhalla
sudo docker compose ps
```

Wait for Valhalla to become healthy and verify its Alberta route endpoint before
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
