#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 VALHALLA_DATA_DIR" >&2
  exit 64
fi

data_dir=$1
source_url=${VALHALLA_DEFAULT_SPEEDS_URL:-https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json}
expected_source_hash=${VALHALLA_DEFAULT_SPEEDS_SHA256:-9953f78c2407b8d2e3701fce6cc93c6a91b207a365a5d2f5564a6d1c231e5ba7}
output=${data_dir}/default_speeds.json
provenance=${data_dir}/default_speeds.provenance

if [ ! -d "${data_dir}" ]; then
  echo "Valhalla data directory not found: ${data_dir}" >&2
  exit 1
fi

for command in curl jq; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command not found: ${command}" >&2
    exit 1
  fi
done

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

source_file=$(mktemp "${TMPDIR:-/tmp}/navoss-default-speeds.XXXXXX")
output_file=${output}.next.$$
provenance_file=${provenance}.next.$$
trap 'rm -f "${source_file}" "${output_file}" "${provenance_file}"' EXIT HUP INT TERM

curl --fail --location --retry 3 --silent --show-error --output "${source_file}" "${source_url}"
source_hash=$(hash_file "${source_file}")
if [ "${source_hash}" != "${expected_source_hash}" ]; then
  echo "Default speed source hash mismatch: expected ${expected_source_hash}, got ${source_hash}." >&2
  exit 1
fi

jq '
  if ([.[] | select(has("iso3166-1") | not)] | length) != 1 then
    error("expected exactly one global speed profile")
  elif ([.[] | select(."iso3166-1" == "CA" and ."iso3166-2" == "AB")] | length) != 1 then
    error("expected exactly one Alberta speed profile")
  else
    . as $profiles
    | ($profiles[] | select(has("iso3166-1") | not) | .urban) as $globalUrban
    | map(
        if ."iso3166-1" == "CA" and ."iso3166-2" == "AB" then
          .urban = $globalUrban
          | .urban.way[1] = 50
        else
          .
        end
      )
  end
' "${source_file}" >"${output_file}"

if ! jq -e '
  . as $profiles
  | ($profiles[] | select(has("iso3166-1") | not) | .urban) as $globalUrban
  | ($profiles[] | select(."iso3166-1" == "CA" and ."iso3166-2" == "AB") | .urban) as $albertaUrban
  | ($albertaUrban.way | length) == 8
    and $albertaUrban.way[1] == 50
    and ($albertaUrban | .way[1] = $globalUrban.way[1]) == $globalUrban
' "${output_file}" >/dev/null; then
  echo 'Generated Alberta speed profile failed validation.' >&2
  exit 1
fi

profile_hash=$(hash_file "${output_file}")
printf 'source_url=%s\nsource_sha256=%s\nprofile_sha256=%s\n' \
  "${source_url}" "${source_hash}" "${profile_hash}" >"${provenance_file}"
chmod 0644 "${output_file}" "${provenance_file}"
mv "${output_file}" "${output}"
mv "${provenance_file}" "${provenance}"

printf 'Valhalla hybrid speed profile generated: %s\n' "${profile_hash}"