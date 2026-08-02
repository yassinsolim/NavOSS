#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 VALHALLA_DATA_DIR" >&2
  exit 64
fi

data_dir=$1
admin_db=${data_dir}/admins.sqlite
backup_db=${data_dir}/admins.pre-country-parent.sqlite
container_runtime=${CONTAINER_RUNTIME:-docker}
valhalla_image=${VALHALLA_IMAGE:-ghcr.io/valhalla/valhalla-scripted:3.8.2}

if [ ! -d "${data_dir}" ] || [ ! -f "${admin_db}" ]; then
  echo "Valhalla admin database not found: ${admin_db}" >&2
  exit 1
fi

if ! command -v "${container_runtime}" >/dev/null 2>&1; then
  echo "Container runtime not found: ${container_runtime}" >&2
  exit 1
fi

working_dir=$(mktemp -d "${TMPDIR:-/tmp}/navoss-valhalla-admins.XXXXXX")
trap 'rm -rf "${working_dir}"' EXIT HUP INT TERM
cp -p "${admin_db}" "${working_dir}/admins.sqlite"

run_spatialite() {
  "${container_runtime}" run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:size=16m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --user "$(id -u):$(id -g)" \
    --entrypoint spatialite \
    --volume "${working_dir}:/custom_files" \
    "${valhalla_image}" \
    -batch -noheader -list /custom_files/admins.sqlite "$1"
}

preflight=$(run_spatialite "
SELECT
  (SELECT COUNT(*) FROM admins WHERE admin_level = 4 AND iso_code = 'AB'),
  (SELECT COUNT(*) FROM admins WHERE admin_level = 4 AND iso_code = 'BC'),
  (SELECT COUNT(*) FROM admins WHERE admin_level = 2 AND iso_code = 'CA'),
  (SELECT COUNT(*) FROM admins
    WHERE admin_level = 4 AND iso_code IN ('AB', 'BC')
      AND (geom IS NULL OR ST_IsValid(geom) <> 1 OR GeometryType(geom) <> 'MULTIPOLYGON'));
" | tr -d '\r\n')

case "${preflight}" in
  '' | *[!0-9'|']*)
    echo "Unexpected Valhalla admin preflight result: ${preflight}" >&2
    exit 1
    ;;
esac

IFS='|' read -r alberta_rows british_columbia_rows canada_rows invalid_state_rows <<EOF
${preflight}
EOF

if [ "${alberta_rows}" -lt 1 ] || [ "${british_columbia_rows}" -lt 1 ]; then
  echo 'Expected both Alberta and British Columbia admin polygons.' >&2
  exit 1
fi
if [ "${canada_rows}" -gt 1 ]; then
  echo "Expected at most one Canada parent, found ${canada_rows}." >&2
  exit 1
fi
if [ "${invalid_state_rows}" -ne 0 ]; then
  echo "Found ${invalid_state_rows} invalid Alberta/British Columbia admin polygons." >&2
  exit 1
fi

if [ ! -e "${backup_db}" ]; then
  cp -p "${admin_db}" "${backup_db}"
fi

run_spatialite "
BEGIN IMMEDIATE;
INSERT INTO admins (
  admin_level,
  iso_code,
  parent_admin,
  name,
  name_en,
  drive_on_right,
  allow_intersection_names,
  default_language,
  supported_languages,
  geom
)
SELECT
  2,
  'CA',
  NULL,
  'Canada',
  'Canada',
  COALESCE(MAX(drive_on_right), 1),
  COALESCE(MAX(allow_intersection_names), 0),
  'en',
  'en - fr',
  ST_MakeValid(CastToMulti(ST_Union(geom)))
FROM admins
WHERE admin_level = 4 AND iso_code IN ('AB', 'BC')
HAVING NOT EXISTS (
  SELECT 1 FROM admins WHERE admin_level = 2 AND iso_code = 'CA'
);
UPDATE admins
SET parent_admin = (
  SELECT rowid FROM admins
  WHERE admin_level = 2 AND iso_code = 'CA'
)
WHERE admin_level = 4 AND iso_code IN ('AB', 'BC');
COMMIT;
" >/dev/null

postflight=$(run_spatialite "
SELECT
  (SELECT COUNT(*) FROM admins WHERE admin_level = 2 AND iso_code = 'CA'),
  (SELECT COUNT(*) FROM admins state JOIN admins country ON country.rowid = state.parent_admin
    WHERE state.admin_level = 4 AND state.iso_code = 'AB' AND country.iso_code = 'CA'),
  (SELECT COUNT(*) FROM admins state JOIN admins country ON country.rowid = state.parent_admin
    WHERE state.admin_level = 4 AND state.iso_code = 'BC' AND country.iso_code = 'CA'),
  (SELECT COUNT(*) FROM admins
    WHERE admin_level = 2 AND iso_code = 'CA'
      AND (geom IS NULL OR ST_IsValid(geom) <> 1 OR GeometryType(geom) <> 'MULTIPOLYGON')),
  (SELECT COUNT(*) FROM admins state JOIN admins country ON country.rowid = state.parent_admin
    WHERE state.admin_level = 4 AND state.iso_code IN ('AB', 'BC')
      AND ST_Covers(country.geom, state.geom) <> 1);
" | tr -d '\r\n')

case "${postflight}" in
  '' | *[!0-9'|']*)
    echo "Unexpected Valhalla admin postflight result: ${postflight}" >&2
    exit 1
    ;;
esac

IFS='|' read -r canada_rows linked_alberta_rows linked_british_columbia_rows invalid_canada_rows uncovered_state_rows <<EOF
${postflight}
EOF

if [ "${canada_rows}" -ne 1 ] || \
  [ "${linked_alberta_rows}" -ne "${alberta_rows}" ] || \
  [ "${linked_british_columbia_rows}" -ne "${british_columbia_rows}" ] || \
  [ "${invalid_canada_rows}" -ne 0 ] || \
  [ "${uncovered_state_rows}" -ne 0 ]; then
  echo "Valhalla admin repair failed validation: ${postflight}" >&2
  exit 1
fi

replacement_db=${admin_db}.next
cp -p "${working_dir}/admins.sqlite" "${replacement_db}"
mv "${replacement_db}" "${admin_db}"

printf 'Valhalla admins repaired: %s Alberta and %s British Columbia rows linked to Canada.\n' \
  "${linked_alberta_rows}" "${linked_british_columbia_rows}"