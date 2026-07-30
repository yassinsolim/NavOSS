#!/bin/sh

set -eu

container_path=/tmp/navoss-nominatim-special-phrases.csv

cleanup() {
  sudo -n docker compose exec -T nominatim rm -f "$container_path" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

sudo -n docker compose cp ./nominatim-special-phrases.csv "nominatim:$container_path"
sudo -n docker compose exec -T --user nominatim nominatim \
  nominatim special-phrases --project-dir /nominatim \
  --import-from-csv "$container_path" --no-replace

printf 'Imported NavOSS Nominatim special phrases.\n'