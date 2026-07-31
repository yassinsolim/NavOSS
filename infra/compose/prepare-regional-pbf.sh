#!/bin/sh
set -eu

artifact_root=${NAVOSS_ARTIFACT_ROOT:-/srv/navoss/artifacts}
import_dir=${artifact_root}/imports
alberta_url=https://download.geofabrik.de/north-america/canada/alberta-latest.osm.pbf
british_columbia_url=https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf
current_link=${import_dir}/alberta-british-columbia-current.osm.pbf

if ! command -v osmium >/dev/null 2>&1; then
  echo 'osmium-tool is required to prepare the regional extract.' >&2
  exit 1
fi

install -d -m 0750 "${import_dir}"
alberta_source=$(curl --fail --location --silent --show-error --output /dev/null --write-out '%{url_effective}' "${alberta_url}")
british_columbia_source=$(curl --fail --location --silent --show-error --output /dev/null --write-out '%{url_effective}' "${british_columbia_url}")
alberta_name=$(basename "${alberta_source}")
british_columbia_name=$(basename "${british_columbia_source}")
alberta_version=$(printf '%s\n' "${alberta_name}" | sed -n 's/^alberta-\([0-9][0-9]*\)\.osm\.pbf$/\1/p')
british_columbia_version=$(printf '%s\n' "${british_columbia_name}" | sed -n 's/^british-columbia-\([0-9][0-9]*\)\.osm\.pbf$/\1/p')
if [ -z "${alberta_version}" ] || [ "${alberta_version}" != "${british_columbia_version}" ]; then
  echo 'Alberta and British Columbia extracts do not have one matching dated release.' >&2
  exit 1
fi

alberta_pbf=${import_dir}/${alberta_name}
british_columbia_pbf=${import_dir}/${british_columbia_name}
regional_pbf=${import_dir}/alberta-british-columbia-${alberta_version}.osm.pbf
regional_staging=${import_dir}/alberta-british-columbia-${alberta_version}.staging.osm.pbf
manifest=${import_dir}/SHA256SUMS-${alberta_version}

download() {
  source_url=$1
  destination=$2
  checksum=${destination}.md5
  curl --fail --location --retry 3 --output "${checksum}.partial" "${source_url}.md5"
  mv "${checksum}.partial" "${checksum}"
  if [ -f "${destination}" ]; then
    osmium fileinfo --extended "${destination}" >/dev/null
    (cd "${import_dir}" && md5sum --check "$(basename "${checksum}")")
    return
  fi
  partial=${destination%.osm.pbf}.partial.osm.pbf
  rm -f "${partial}"
  curl --fail --location --retry 3 --output "${partial}" "${source_url}"
  osmium fileinfo --extended "${partial}" >/dev/null
  mv "${partial}" "${destination}"
  (cd "${import_dir}" && md5sum --check "$(basename "${checksum}")")
}

download "${alberta_source}" "${alberta_pbf}"
download "${british_columbia_source}" "${british_columbia_pbf}"
osmium fileinfo --extended "${alberta_pbf}" >/dev/null
osmium fileinfo --extended "${british_columbia_pbf}" >/dev/null
if [ ! -f "${regional_pbf}" ]; then
  rm -f "${regional_staging}"
  osmium merge --overwrite --output "${regional_staging}" "${alberta_pbf}" "${british_columbia_pbf}"
  osmium fileinfo --extended "${regional_staging}" >/dev/null
  mv "${regional_staging}" "${regional_pbf}"
  sha256sum "${alberta_pbf}" "${british_columbia_pbf}" "${regional_pbf}" > "${manifest}"
else
  osmium fileinfo --extended "${regional_pbf}" >/dev/null
  if [ ! -f "${manifest}" ]; then
    echo "Existing regional artifact has no immutable checksum manifest: ${manifest}" >&2
    exit 1
  fi
  sha256sum --check "${manifest}"
fi
ln -sfn "$(basename "${regional_pbf}")" "${current_link}.next"
mv -Tf "${current_link}.next" "${current_link}"
printf '%s\n' "${alberta_version}"