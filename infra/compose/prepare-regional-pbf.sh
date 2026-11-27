#!/bin/sh
# Downloads matching dated Geofabrik releases, verifies them and writes one immutable extract.
#
#   ./prepare-regional-pbf.sh                          # alberta british-columbia (deployed)
#   ./prepare-regional-pbf.sh canada                   # the whole-country extract, no merge
#   ./prepare-regional-pbf.sh alberta british-columbia ontario   # staged regional search
#   GEOFABRIK_VERSION=261114 ./prepare-regional-pbf.sh canada     # pin a dated release
#
# Resumable: partial downloads continue (`curl -C -`), verified files are kept and re-verified,
# and the merged file is written once. Prints the release version (YYMMDD) on success.
set -eu

artifact_root=${NAVOSS_ARTIFACT_ROOT:-/srv/navoss/artifacts}
import_dir=${artifact_root}/imports
geofabrik=${GEOFABRIK_URL:-https://download.geofabrik.de}

if [ "$#" -eq 0 ]; then
  set -- alberta british-columbia
fi

for command in curl md5sum osmium sha256sum; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required to prepare the regional extract (apt-get install osmium-tool)." >&2
    exit 1
  fi
done

region_url() {
  case "$1" in
    canada) printf '%s/north-america/canada/canada-latest.osm.pbf\n' "${geofabrik}" ;;
    alberta | british-columbia | manitoba | new-brunswick | newfoundland-and-labrador | \
      northwest-territories | nova-scotia | nunavut | ontario | prince-edward-island | quebec | \
      saskatchewan | yukon)
      printf '%s/north-america/canada/%s-latest.osm.pbf\n' "${geofabrik}" "$1"
      ;;
    *)
      echo "Unknown Geofabrik region: $1" >&2
      exit 64
      ;;
  esac
}

install -d -m 0750 "${import_dir}"
name=
version=
for region in "$@"; do
  case " ${name} " in
    *" ${region} "*)
      echo "Region listed twice: ${region}" >&2
      exit 64
      ;;
  esac
  if [ -n "${GEOFABRIK_VERSION:-}" ]; then
    # Pinned release, e.g. an extract already downloaded and verified on this host.
    region_version=${GEOFABRIK_VERSION}
  else
    source=$(curl --fail --location --silent --show-error --output /dev/null \
      --write-out '%{url_effective}' "$(region_url "${region}")")
    region_version=$(basename "${source}" | sed -n "s/^${region}-\([0-9][0-9]*\)\.osm\.pbf$/\1/p")
  fi
  if [ -z "${region_version}" ] || { [ -n "${version}" ] && [ "${region_version}" != "${version}" ]; }; then
    echo 'The requested regions do not have one matching dated release; retry after Geofabrik publishes them all.' >&2
    exit 1
  fi
  version=${region_version}
  name="${name:+${name} }${region}"
done
label=$(printf '%s' "${name}" | tr ' ' '-')

download() {
  region=$1
  destination=${import_dir}/${region}-${version}.osm.pbf
  source_url=$(dirname "$(region_url "${region}")")/${region}-${version}.osm.pbf
  checksum=${destination}.md5
  if [ ! -f "${checksum}" ]; then
    if [ -n "${GEOFABRIK_MD5:-}" ]; then
      # The digest already checked when the file was fetched (Geofabrik's dated .md5).
      printf '%s  %s\n' "${GEOFABRIK_MD5}" "$(basename "${destination}")" >"${checksum}"
    else
      curl --fail --location --retry 5 --output "${checksum}.partial" "${source_url}.md5"
      mv "${checksum}.partial" "${checksum}"
    fi
  fi
  if [ ! -f "${destination}" ]; then
    partial=${destination%.osm.pbf}.partial.osm.pbf
    # Resumes an interrupted transfer; Geofabrik serves byte ranges for dated files.
    curl --fail --location --retry 5 --continue-at - --output "${partial}" "${source_url}"
    (cd "${import_dir}" && sed "s/ .*/  $(basename "${partial}")/" "$(basename "${checksum}")" | md5sum --check --quiet) || {
      echo "Checksum mismatch for ${partial}; delete it and run again." >&2
      exit 1
    }
    osmium fileinfo --extended "${partial}" >/dev/null
    mv "${partial}" "${destination}"
  fi
  (cd "${import_dir}" && md5sum --check --quiet "$(basename "${checksum}")")
}

inputs=
for region in ${name}; do
  download "${region}"
  inputs="${inputs} ${import_dir}/${region}-${version}.osm.pbf"
done

regional_pbf=${import_dir}/${label}-${version}.osm.pbf
# The deployed Alberta+BC manifest keeps its original name.
if [ "${label}" = alberta-british-columbia ]; then
  manifest=${import_dir}/SHA256SUMS-${version}
else
  manifest=${import_dir}/SHA256SUMS-${label}-${version}
fi
if [ ! -f "${regional_pbf}" ]; then
  staging=${import_dir}/${label}-${version}.staging.osm.pbf
  rm -f "${staging}"
  # shellcheck disable=SC2086 # one path per region
  osmium merge --overwrite --output "${staging}" ${inputs}
  osmium fileinfo --extended "${staging}" >/dev/null
  mv "${staging}" "${regional_pbf}"
fi
if [ ! -f "${manifest}" ]; then
  # shellcheck disable=SC2086
  (cd "${import_dir}" && sha256sum $(for input in ${inputs} ${regional_pbf}; do basename "${input}"; done | sort -u)) >"${manifest}.next"
  mv "${manifest}.next" "${manifest}"
fi
(cd "${import_dir}" && sha256sum --check --quiet "$(basename "${manifest}")")
current_link=${import_dir}/${label}-current.osm.pbf
ln -sfn "$(basename "${regional_pbf}")" "${current_link}.next"
mv -Tf "${current_link}.next" "${current_link}"
printf '%s\n' "${version}"
