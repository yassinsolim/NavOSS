#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Offline OSM preparation failed at line $LINENO." >&2' ERR

if [[ $# -ne 2 || ! $1 =~ ^[0-9]{6}$ ]]; then
  echo "usage: $0 YYMMDD INPUT_DIRECTORY" >&2
  exit 64
fi
version=$1
input_dir=$2
mkdir -p "$input_dir"
cd "$input_dir"
data_date="20${version:0:2}-${version:2:2}-${version:4:2}"
[[ $(date -u -d "$data_date" +%Y-%m-%d) == "$data_date" ]]

if [[ -f SHA256SUMS ]]; then
  sha256sum --check SHA256SUMS
fi
for region in alberta british-columbia; do
  name="$region-$version.osm.pbf"
  url="https://download.geofabrik.de/north-america/canada/$name"
  if [[ ! -f "$name.md5" ]]; then
    curl --fail --location --retry 3 --silent --show-error \
      --user-agent 'NavOSS offline builder (https://github.com/yassinsolim/NavOSS)' \
      "$url.md5" -o "$name.md5.partial"
    mv "$name.md5.partial" "$name.md5"
  fi
  if [[ ! -f "$name" ]]; then
    curl --fail --location --retry 3 --silent --show-error \
      --user-agent 'NavOSS offline builder (https://github.com/yassinsolim/NavOSS)' \
      "$url" -o "$name.partial"
    expected=$(awk '{print $1}' "$name.md5")
    actual=$(md5sum "$name.partial" | awk '{print $1}')
    [[ $expected =~ ^[0-9a-f]{32}$ && $actual == "$expected" ]]
    mv "$name.partial" "$name"
  fi
  if [[ ! -f SHA256SUMS ]] || ! grep -F "  $name" SHA256SUMS >/dev/null; then
    md5sum --check "$name.md5"
    osmium fileinfo --extended "$name" >/dev/null
  fi
  timestamp=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$name")
  [[ ${timestamp:0:10} == "$data_date" ]]
  if [[ $region == alberta ]]; then
    osm_timestamp=$timestamp
  else
    [[ $timestamp == "$osm_timestamp" ]]
  fi
done

merged="alberta-british-columbia-$version.osm.pbf"
if [[ -f "$merged" ]]; then
  if [[ ! -f SHA256SUMS ]] || ! grep -F "  $merged" SHA256SUMS >/dev/null; then
    echo 'Existing merged PBF has no immutable checksum record.' >&2
    exit 1
  fi
else
  osmium merge --output "$merged.partial.osm.pbf" \
    "alberta-$version.osm.pbf" "british-columbia-$version.osm.pbf"
  osmium fileinfo --extended "$merged.partial.osm.pbf" >/dev/null
  mv "$merged.partial.osm.pbf" "$merged"
fi
if ! grep -F "  $merged" SHA256SUMS >/dev/null 2>&1; then
  sha256sum "alberta-$version.osm.pbf" "british-columbia-$version.osm.pbf" "$merged" > SHA256SUMS.next
  mv SHA256SUMS.next SHA256SUMS
fi
if [[ -f data.json ]]; then
  jq -e --arg date "$data_date" --arg timestamp "$osm_timestamp" \
    '.dataDate == $date and .osmTimestamp == $timestamp' data.json >/dev/null
else
  jq -n --arg dataDate "$data_date" --arg osmTimestamp "$osm_timestamp" \
    '{dataDate:$dataDate,osmTimestamp:$osmTimestamp}' > data.json.next
  mv data.json.next data.json
fi
