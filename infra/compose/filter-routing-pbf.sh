#!/bin/sh
# Writes the routing input: the verified extract without roads that exist only part of the year.
#
#   ./filter-routing-pbf.sh /srv/navoss/artifacts/imports/canada-261114.osm.pbf
#
# Valhalla 3.8.2 reads neither `ice_road`, `winter_road` nor `seasonal`, so a winter road over a
# frozen lake would be routed in July. NavOSS has no source for when each one opens, so it never
# routes over them: those ways are removed before the graph is built. Search keeps the unfiltered
# extract. Idempotent; writes <input>.routing.osm.pbf and its removal report once.
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 VERIFIED_EXTRACT.osm.pbf" >&2
  exit 64
fi
input=$1
output=${input%.osm.pbf}.routing.osm.pbf
report=${input%.osm.pbf}.routing.removed.txt
# Tag values seen on Canadian ways (Geofabrik taginfo, 2026-11-15): ice_road=yes|y,
# winter_road=yes, seasonal=winter|yes|closed winter|No winter maintenance.
expressions='w/ice_road=yes,y w/winter_road=yes w/seasonal=winter,yes'

if [ -f "${output}" ] && [ -f "${report}" ]; then
  osmium fileinfo "${output}" >/dev/null
  cat "${report}"
  exit 0
fi

removed=${output}.removed.partial.osm.pbf
# shellcheck disable=SC2086 # one osmium expression per word
osmium tags-filter --overwrite --omit-referenced --output "${removed}" "${input}" ${expressions}
count=$(osmium fileinfo --extended --get data.count.ways "${removed}")
rm -f "${removed}"
partial=${output%.osm.pbf}.partial.osm.pbf
# shellcheck disable=SC2086
osmium tags-filter --overwrite --invert-match --output "${partial}" "${input}" ${expressions}
osmium fileinfo --extended "${partial}" >/dev/null
mv "${partial}" "${output}"
printf 'Removed %s seasonal or ice-road ways (%s) from %s\n' "${count}" "${expressions}" \
  "$(basename "${input}")" >"${report}"
cat "${report}"
