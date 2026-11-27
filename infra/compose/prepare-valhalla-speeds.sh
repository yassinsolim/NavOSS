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

# Provinces whose urban rows are replaced by the global urban profile with urban trunk at 50 km/h
# (docs/testing/route-quality.md, "Alberta speed-model evaluation"). The default is the Alberta+BC
# profile; a Canada build passes `AB ON` (docs/architecture/north-america.md).
#
# Alberta alone has two reviewed exceptions (docs/testing/route-quality.md, "Calgary arterial and
# freeway speeds"), because Valhalla lets a configured class speed replace the posted limit:
# - suburban and urban motorway are left unset, so Valhalla keeps each motorway's posted limit;
# - urban primary keeps Alberta's own observation instead of the global urban value.
hybrid_provinces=${VALHALLA_HYBRID_PROVINCES:-AB}
provinces_json=$(printf '%s\n' ${hybrid_provinces} | jq -R . | jq -cs .)
if ! printf '%s' "${provinces_json}" | jq -e 'length > 0 and all(.[]; . == "AB" or . == "ON") and (unique | length) == length' >/dev/null; then
  echo "VALHALLA_HYBRID_PROVINCES must list AB and/or ON once each: ${hybrid_provinces}" >&2
  exit 1
fi

# One definition of the hybrid, used to build the profile and again to check what was written.
# shellcheck disable=SC2016 # a jq program, not shell
hybrid_filter='
  def hybrid($source; $globalUrban):
    $source
    | .urban = $globalUrban
    | .urban.way[1] = 50
    | if $source."iso3166-2" == "AB" then
        .urban.way[0] = null
        | .suburban.way[0] = null
        | .urban.way[2] = $source.urban.way[2]
      else
        .
      end;
'

jq --argjson provinces "${provinces_json}" "${hybrid_filter}"'
  if ([.[] | select(has("iso3166-1") | not)] | length) != 1 then
    error("expected exactly one global speed profile")
  else
    . as $profiles
    | if any($provinces[]; . as $p | ([$profiles[] | select(."iso3166-1" == "CA" and ."iso3166-2" == $p)] | length) != 1) then
        error("expected exactly one speed profile for each hybrid province")
      else
        ($profiles[] | select(has("iso3166-1") | not) | .urban) as $globalUrban
        | map(
            if ."iso3166-1" == "CA" and (."iso3166-2" as $p | $provinces | index($p)) != null then
              hybrid(.; $globalUrban)
            else
              .
            end
          )
      end
  end
' "${source_file}" >"${output_file}"

# Every profile outside the hybrid provinces is the source row unchanged; every hybrid province has
# eight way speeds, the reviewed values, and nothing else changed.
if ! jq -e --argjson provinces "${provinces_json}" --slurpfile source "${source_file}" "${hybrid_filter}"'
  . as $profiles
  | $source[0] as $original
  | ($original[] | select(has("iso3166-1") | not) | .urban) as $globalUrban
  | ($profiles | length) == ($original | length)
    and all(range(0; $original | length); . as $i
      | $original[$i] as $before
      | $profiles[$i] as $after
      | if $before."iso3166-1" == "CA" and ($before."iso3166-2" as $p | $provinces | index($p)) != null then
          ($after.urban.way | length) == 8
          and $after.urban.way[1] == 50
          and ($after.urban.way[3:] == $globalUrban.way[3:])
          and ($after.rural == $before.rural)
          and (if $before."iso3166-2" == "AB" then
                 $after.urban.way[0] == null
                 and $after.suburban.way[0] == null
                 and $after.urban.way[2] == $before.urban.way[2]
                 and ($after.suburban.way[1:] == $before.suburban.way[1:])
               else
                 $after.urban.way[0] == $globalUrban.way[0]
                 and $after.urban.way[2] == $globalUrban.way[2]
                 and $after.suburban == $before.suburban
               end)
          and $after == hybrid($before; $globalUrban)
        else
          $after == $before
        end)
' "${output_file}" >/dev/null; then
  echo "Generated hybrid speed profile (${hybrid_provinces}) failed validation." >&2
  exit 1
fi

profile_hash=$(hash_file "${output_file}")
printf 'source_url=%s\nsource_sha256=%s\nhybrid_provinces=%s\nprofile_sha256=%s\n' \
  "${source_url}" "${source_hash}" "${hybrid_provinces}" "${profile_hash}" >"${provenance_file}"
chmod 0644 "${output_file}" "${provenance_file}"
mv -f "${output_file}" "${output}"
mv -f "${provenance_file}" "${provenance}"

printf 'Valhalla hybrid speed profile generated: %s\n' "${profile_hash}"