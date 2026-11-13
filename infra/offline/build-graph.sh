#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Offline graph preparation/build failed at line $LINENO." >&2' ERR

if [[ $# -ne 4 || ! $1 =~ ^(prepare|build)$ ]]; then
  echo "usage: $0 prepare|build GRAPH_DIRECTORY MERGED_PBF SOURCES_DIRECTORY" >&2
  exit 64
fi
action=$1
graph_dir=$2
pbf=$3
sources=$4
mkdir -p "$graph_dir/tiles"
config="$graph_dir/valhalla.json"

if [[ $action == prepare ]]; then
  [[ -s "$graph_dir/default_speeds.json" && -s "$pbf" ]]
  /opt/valhalla_build_config_compose \
    --mjolnir-tile-dir "$graph_dir/tiles" \
    --mjolnir-tile-extract "$graph_dir/valhalla_tiles.tar" \
    --mjolnir-admin "$graph_dir/admins.sqlite" \
    --mjolnir-timezone "$graph_dir/timezones.sqlite" \
    --mjolnir-concurrency 2 \
    --mjolnir-default-speeds-config "$graph_dir/default_speeds.json" \
    --mjolnir-traffic-extract '' \
    --additional-data-elevation "$graph_dir/elevation" > "$config.next"
  mv "$config.next" "$config"
  valhalla_build_admins --config "$config" "$pbf"
  timezone_work="$graph_dir/timezone-work"
  mkdir "$timezone_work"
  (
    cd "$timezone_work"
    unzip -q "$sources/timezones-with-oceans-1970.shapefile.zip"
    spatialite_tool -i -shp combined-shapefile-with-oceans-1970 \
      -d timezones.sqlite -t tz_world -s 4326 -g geom -c UTF-8
    spatialite -batch timezones.sqlite "SELECT CreateSpatialIndex('tz_world', 'geom'); VACUUM; ANALYZE;"
    [[ $(sqlite3 timezones.sqlite 'PRAGMA integrity_check;') == ok ]]
    mv timezones.sqlite "$graph_dir/timezones.sqlite"
  )
  rm -rf "$timezone_work"
else
  [[ -s "$config" && -s "$graph_dir/admins.sqlite" && -s "$graph_dir/timezones.sqlite" ]]
  # Use Compose's build/enhance phases and config, paired with the pinned mobile engine.
  valhalla_build_tiles -c "$config" -e build "$pbf"
  valhalla_build_tiles -c "$config" -s enhance "$pbf"
  valhalla_build_extract -c "$config" -v
  [[ -s "$graph_dir/valhalla_tiles.tar" ]]
fi
