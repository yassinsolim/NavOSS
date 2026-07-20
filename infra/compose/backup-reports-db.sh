#!/bin/sh

set -eu

compose_dir="${NAVOSS_COMPOSE_DIR:-/home/navoss/NavOSS/infra/compose}"
backup_dir="${NAVOSS_BACKUP_DIR:-/srv/navoss/state/backups/postgres}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file="$backup_dir/.navoss-$timestamp.sql.gz.tmp"
final_file="$backup_dir/navoss-$timestamp.sql.gz"

install -d -m 0750 "$backup_dir"
cd "$compose_dir"

docker compose exec -T reports-db pg_dump \
  --clean \
  --if-exists \
  --no-owner \
  --username navoss \
  --dbname navoss |
  gzip -9 >"$temporary_file"

chmod 0640 "$temporary_file"
mv "$temporary_file" "$final_file"
find "$backup_dir" -type f -name 'navoss-*.sql.gz' -mtime +14 -delete

printf 'Created %s\n' "$final_file"
