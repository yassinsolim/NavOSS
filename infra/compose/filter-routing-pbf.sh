#!/bin/sh
# Writes the routing input: the verified extract without roads that exist only part of the year.
#
#   ./filter-routing-pbf.sh /srv/navoss/artifacts/imports/canada-261114.osm.pbf
#
# Valhalla 3.8.2 reads neither `ice_road`, `winter_road` nor `seasonal`, so a winter road over a
# frozen lake would be routed in July. NavOSS has no source for when each one opens, so it never
# routes over them: those ways are removed before the graph is built. Search keeps the unfiltered
# extract. Idempotent; writes <input>.routing.osm.pbf and its removal report once. Output of an
# earlier policy (a report without the current policy mark) is regenerated.
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
# Bumped whenever the filter changes what it removes. Policy 1 let relation members back in.
policy='[routing filter 2]'

if [ -f "${output}" ] && [ -f "${report}" ] && grep -qF "${policy}" "${report}"; then
  osmium fileinfo "${output}" >/dev/null
  cat "${report}"
  exit 0
fi

partial=${output%.osm.pbf}.partial.osm.pbf
# `--omit-referenced`: without it the inverse filter restores every way a kept relation lists, so an
# ice road in a route relation (Dempster way 260830417 in relation 5384727) would be routed again.
# Kept relations then lack the removed members, which Valhalla ignores.
# shellcheck disable=SC2086 # one osmium expression per word
osmium tags-filter --overwrite --invert-match --omit-referenced --output "${partial}" "${input}" \
  ${expressions}
osmium fileinfo --extended "${partial}" >/dev/null
# Hard gate before a multi-hour build: every kept way's nodes are present, and the only relation
# members newly missing are removed ways. (A Geofabrik extract already lacks members outside it.)
if ! osmium check-refs "${partial}" >/dev/null 2>&1; then
  rm -f "${partial}"
  echo "$(basename "${output}"): ways reference missing nodes; nothing written." >&2
  exit 1
fi
relation_gaps() {
  osmium check-refs --check-relations "$1" 2>&1 | sed -n 's/^Ways *in relations missing: *//p'
}
# What was actually removed: every way of the extract that the routing input no longer holds.
before=$(osmium fileinfo --extended --get data.count.ways "${input}")
after=$(osmium fileinfo --extended --get data.count.ways "${partial}")
new_gaps=$(($(relation_gaps "${partial}") - $(relation_gaps "${input}")))
if [ "${new_gaps}" -gt "$((before - after))" ]; then
  rm -f "${partial}"
  echo "$(basename "${output}"): ${new_gaps} relation members missing beyond the removed ways." >&2
  exit 1
fi
mv -f "${partial}" "${output}"
printf 'Removed %s seasonal or ice-road ways (%s) from %s %s\n' "$((before - after))" \
  "${expressions}" "$(basename "${input}")" "${policy}" >"${report}"
cat "${report}"
