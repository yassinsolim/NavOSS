#!/bin/sh
# Builds and verifies a new coverage release beside the live stack, one heavy step at a time.
# Nothing here touches the live containers, their artifact directories or `.env`.
#
#   ./stage-coverage.sh inputs    canada        # download, verify, filter (≈30 min, 13 GB)
#   ./stage-coverage.sh valhalla  canada        # graph, two passes (≈2–4 h, ≈20 GB peak, 8 GiB)
#   ./stage-coverage.sh nominatim canada        # search import (≈12–24 h, ≤110 GB peak, 10 GiB)
#   ./stage-coverage.sh serve     canada        # staged Valhalla + Nominatim + API on 127.0.0.1:18300
#   ./stage-coverage.sh verify    canada        # check-coverage.sh against the staged API
#   ./stage-coverage.sh stop      canada        # stop staging containers; artifacts stay
#   ./stage-coverage.sh status    canada
#
# `canada` may be replaced by Geofabrik province names for a regional release, for example
# `alberta british-columbia ontario` (staged search). Run under tmux: every step is resumable and
# re-running a finished step only re-verifies it. See docs/architecture/north-america.md.
set -eu

script_dir=$(cd "$(dirname "$0")" && pwd)
root=${NAVOSS_ARTIFACT_ROOT:-/srv/navoss/artifacts}
imports=${root}/imports
valhalla_image=ghcr.io/valhalla/valhalla-scripted:3.8.2
nominatim_image=mediagis/nominatim:5.3
api_image=${STAGE_API_IMAGE:-navoss-api:latest}
speeds_url=https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json
network=navoss-stage

if [ "$#" -lt 2 ]; then
  sed -n '2,17p' "$0" >&2
  exit 64
fi
step=$1
shift
label=$(printf '%s' "$*" | tr ' ' '-')

# Registry ids and ISO codes of the provinces a release holds.
case "${label}" in
  canada)
    areas=alberta,british-columbia,ontario,quebec,manitoba,saskatchewan,new-brunswick,nova-scotia,prince-edward-island,newfoundland-and-labrador,yukon,northwest-territories,nunavut
    ;;
  *) areas=$(printf '%s' "$*" | tr ' ' ',') ;;
esac
codes=
for area in $(printf '%s' "${areas}" | tr ',' ' '); do
  case "${area}" in
    alberta) code=AB ;; british-columbia) code=BC ;; ontario) code=ON ;; quebec) code=QC ;;
    manitoba) code=MB ;; saskatchewan) code=SK ;; new-brunswick) code=NB ;; nova-scotia) code=NS ;;
    prince-edward-island) code=PE ;; newfoundland-and-labrador) code=NL ;; yukon) code=YT ;;
    northwest-territories) code=NT ;; nunavut) code=NU ;;
    *) echo "Unknown province: ${area}" >&2; exit 64 ;;
  esac
  codes="${codes:+${codes} }${code}"
done
# The urban hybrid was reviewed for Alberta (Calgary) and is applied to Ontario, whose source urban
# trunk speed (20 km/h) is implausible; other provinces keep their upstream observations.
hybrid=
for code in ${codes}; do
  case "${code}" in AB | ON) hybrid="${hybrid:+${hybrid} }${code}" ;; esac
done
hybrid=${hybrid:-AB}

version_file=${imports}/${label}.stage-version
version() {
  [ -s "${version_file}" ] || { echo "Run '$0 inputs $*' first." >&2; exit 1; }
  cat "${version_file}"
}

wait_for() {
  # wait_for URL CONTAINER TIMEOUT_SECONDS
  waited=0
  until curl --fail --silent --max-time 5 "$1" >/dev/null 2>&1; do
    if ! docker inspect --format '{{.State.Running}}' "$2" 2>/dev/null | grep -q true; then
      echo "$2 stopped before $1 answered:" >&2
      docker logs --tail 40 "$2" >&2 || true
      return 1
    fi
    if [ "${waited}" -ge "$3" ]; then
      echo "Timed out after $3 s waiting for $1" >&2
      return 1
    fi
    sleep 30
    waited=$((waited + 30))
    if [ $((waited % 600)) -eq 0 ]; then
      printf '[%s] %s still working (%s s); free memory:\n' "$(date -u +%FT%TZ)" "$2" "${waited}"
      free -h | sed -n 2p
      docker logs --tail 2 "$2" 2>&1 | sed 's/^/    /'
    fi
  done
}

refuse_parallel_heavy_step() {
  for other in navoss-valhalla-stage navoss-nominatim-stage; do
    if [ "${other}" != "$1" ] && docker ps --format '{{.Names}}' | grep -qx "${other}"; then
      echo "${other} is running. Run one heavy step at a time ('$0 stop ...')." >&2
      exit 1
    fi
  done
}

valhalla_run() {
  # valhalla_run DIR BUILD_ADMINS FORCE_REBUILD IGNORE_PBF
  docker rm -f navoss-valhalla-stage >/dev/null 2>&1 || true
  docker run -d --name navoss-valhalla-stage \
    --cpus "${VALHALLA_BUILD_CPUS:-4}" --cpuset-cpus "${VALHALLA_BUILD_CPUSET:-0-3}" \
    --memory "${VALHALLA_BUILD_MEMORY:-8g}" -p 127.0.0.1:18002:8002 \
    -e build_admins="$2" -e build_elevation=False -e build_tar=True \
    -e build_time_zones=False -e force_rebuild="$3" -e server_threads=2 \
    -e tile_urls= -e traffic_name= -e use_default_speeds_config=True \
    -e use_tiles_ignore_pbf="$4" -e default_speeds_config_url="${speeds_url}" \
    -v "$1:/custom_files" "${valhalla_image}" >/dev/null
  wait_for http://127.0.0.1:18002/status navoss-valhalla-stage "${VALHALLA_BUILD_TIMEOUT:-28800}"
}

case "${step}" in
  inputs)
    v=$("${script_dir}/prepare-regional-pbf.sh" "$@")
    "${script_dir}/filter-routing-pbf.sh" "${imports}/${label}-${v}.osm.pbf"
    printf '%s\n' "${v}" >"${version_file}"
    df -h "${root}" | sed -n 2p
    ;;

  valhalla)
    refuse_parallel_heavy_step navoss-valhalla-stage
    v=$(version)
    stage=${root}/valhalla-${label}-${v}
    routing=${imports}/${label}-${v}.routing.osm.pbf
    staged_pbf=${stage}/${label}-${v}.osm.pbf
    if [ -f "${staged_pbf}" ] && ! [ "${staged_pbf}" -ef "${routing}" ] &&
      ! cmp -s "${staged_pbf}" "${routing}"; then
      # The routing input was regenerated (a filter policy change): both passes run again from it.
      echo "The routing input changed since ${stage} was built; rebuilding it."
      rm -f "${staged_pbf}" "${stage}/.pass1-complete" "${stage}/.navoss-stage-complete"
    fi
    if [ -f "${stage}/.navoss-stage-complete" ]; then
      (cd "${stage}" && sha256sum --check --quiet .navoss-stage-complete)
      echo "Valhalla stage ${stage} is complete and verified."
      exit 0
    fi
    live=$(sed -n 's/^VALHALLA_DATA_DIR=//p' "${script_dir}/.env" 2>/dev/null | tail -n 1)
    [ "${stage}" != "${live}" ] || { echo 'Refusing to build into the live VALHALLA_DATA_DIR.' >&2; exit 1; }
    install -d -m 0750 "${stage}"
    [ -f "${staged_pbf}" ] || ln "${routing}" "${staged_pbf}" 2>/dev/null || cp "${routing}" "${staged_pbf}"
    if [ ! -f "${stage}/timezones.sqlite" ]; then
      cp "${live}/timezones.sqlite" "${stage}/timezones.sqlite"
    fi
    tz=$(docker run --rm --network none --entrypoint spatialite -v "${stage}:/d:ro" "${valhalla_image}" \
      -batch -noheader -list /d/timezones.sqlite \
      "SELECT COUNT(DISTINCT TZID) FROM tz_world WHERE TZID IN ('America/St_Johns','America/Halifax','America/Moncton','America/Toronto','America/Winnipeg','America/Regina','America/Edmonton','America/Vancouver','America/Whitehorse');")
    [ "${tz}" = 9 ] || { echo "timezones.sqlite lacks Canadian zones (${tz}/9)." >&2; exit 1; }
    VALHALLA_HYBRID_PROVINCES="${hybrid}" "${script_dir}/prepare-valhalla-speeds.sh" "${stage}"
    if [ ! -f "${stage}/.pass1-complete" ]; then
      # An interrupted first pass leaves partial tiles; start it clean.
      rm -rf "${stage}/valhalla_tiles" "${stage}/valhalla_tiles.tar" "${stage}/admins.sqlite" \
        "${stage}/admins.pre-country-parent.sqlite" "${stage}/file_hashes.txt" "${stage}/valhalla.json"
      valhalla_run "${stage}" True False True
      docker rm -f navoss-valhalla-stage >/dev/null
      touch "${stage}/.pass1-complete"
    fi
    VALHALLA_ADMIN_PROVINCES="${codes}" "${script_dir}/repair-valhalla-admins.sh" "${stage}"
    valhalla_run "${stage}" False True False
    docker rm -f navoss-valhalla-stage >/dev/null
    (cd "${stage}" && sha256sum valhalla_tiles.tar admins.sqlite default_speeds.json timezones.sqlite \
      >.navoss-stage-complete.next && mv .navoss-stage-complete.next .navoss-stage-complete)
    du -sh "${stage}"
    ;;

  nominatim)
    refuse_parallel_heavy_step navoss-nominatim-stage
    v=$(version)
    stage=${root}/nominatim/${label}-${v}
    if [ -f "${stage}/.navoss-import-complete" ]; then
      echo "Nominatim stage ${stage} is complete."
      exit 0
    fi
    live=$(sed -n 's/^NOMINATIM_DATA_DIR=//p' "${script_dir}/.env" 2>/dev/null | tail -n 1)
    [ "${stage}/postgres" != "${live}" ] || { echo 'Refusing to import into the live NOMINATIM_DATA_DIR.' >&2; exit 1; }
    install -d -m 0750 "${stage}"
    if [ -f "${stage}/.navoss-import-started" ]; then
      # The image treats any existing cluster as imported; an interrupted import must start over.
      echo "Discarding the interrupted import in ${stage}/postgres."
      docker rm -f navoss-nominatim-stage >/dev/null 2>&1 || true
      rm -rf "${stage}/postgres"
    fi
    install -d -m 0700 "${stage}/postgres"
    # The password never appears on a command line or in the import log.
    stage_env=$(mktemp)
    chmod 0600 "${stage_env}"
    sed -n 's/^NOMINATIM_PASSWORD=/NOMINATIM_PASSWORD=/p' "${script_dir}/.env" | tail -n 1 >"${stage_env}"
    docker rm -f navoss-nominatim-stage >/dev/null 2>&1 || true
    docker create --name navoss-nominatim-stage --env-file "${stage_env}" \
      --cpus "${NOMINATIM_IMPORT_CPUS:-4}" --memory "${NOMINATIM_IMPORT_MEMORY:-10g}" --shm-size 2g \
      -p 127.0.0.1:18080:8080 \
      -e FREEZE=true -e GUNICORN_WORKERS=2 -e IMPORT_SECONDARY_WIKIPEDIA=false \
      -e IMPORT_STYLE=full -e IMPORT_WIKIPEDIA=false -e PBF_PATH=/regional-data/regional.osm.pbf \
      -e OSM2PGSQL_CACHE="${NOMINATIM_OSM2PGSQL_CACHE:-3000}" \
      -e POSTGRES_AUTOVACUUM_WORK_MEM=256MB -e POSTGRES_EFFECTIVE_CACHE_SIZE=6GB \
      -e POSTGRES_MAINTENANCE_WORK_MEM=1GB -e POSTGRES_MAX_CONNECTIONS=30 \
      -e POSTGRES_MAX_LOCKS_PER_TRANSACTION=256 -e POSTGRES_MAX_WAL_SIZE=2GB \
      -e POSTGRES_SHARED_BUFFERS=2GB -e POSTGRES_WORK_MEM=32MB \
      -e THREADS="${NOMINATIM_IMPORT_THREADS:-4}" -e UPDATE_MODE=none \
      -v "${imports}/${label}-${v}.osm.pbf:/regional-data/regional.osm.pbf:ro" \
      -v "${stage}/postgres:/var/lib/postgresql/16/main" \
      "${nominatim_image}" >/dev/null
    rm -f "${stage_env}"
    init_script=$(mktemp)
    docker cp navoss-nominatim-stage:/app/init.sh "${init_script}"
    # Disable command tracing (it prints the database password) and raise the lock limit.
    sed -i '1s|#!/bin/bash -ex|#!/bin/bash -e|' "${init_script}"
    sed -i '/cp \/etc\/postgresql\/16\/main\/conf.d\/postgres-import.conf.disabled/a sed -i "s/^#max_locks_per_transaction = 64/max_locks_per_transaction = ${POSTGRES_MAX_LOCKS_PER_TRANSACTION}/" /etc/postgresql/16/main/postgresql.conf' "${init_script}"
    docker cp "${init_script}" navoss-nominatim-stage:/app/init.sh
    rm -f "${init_script}"
    touch "${stage}/.navoss-import-started"
    started=$(date +%s)
    docker start navoss-nominatim-stage >/dev/null
    wait_for http://127.0.0.1:18080/status navoss-nominatim-stage "${NOMINATIM_IMPORT_TIMEOUT:-129600}"
    printf 'Import took %s min.\n' $(( ($(date +%s) - started) / 60 ))
    docker stop navoss-nominatim-stage >/dev/null
    mv "${stage}/.navoss-import-started" "${stage}/.navoss-import-complete"
    du -sh "${stage}/postgres"
    ;;

  serve)
    v=$(version)
    valhalla_stage=${root}/valhalla-${label}-${v}
    nominatim_stage=${root}/nominatim/${label}-${v}
    [ -f "${valhalla_stage}/.navoss-stage-complete" ] && [ -f "${nominatim_stage}/.navoss-import-complete" ] ||
      { echo 'Finish the valhalla and nominatim steps first.' >&2; exit 1; }
    docker network inspect "${network}" >/dev/null 2>&1 || docker network create "${network}" >/dev/null
    # Serving only: tiles exist, so the image builds nothing.
    docker rm -f navoss-valhalla-stage >/dev/null 2>&1 || true
    docker run -d --name navoss-valhalla-stage --network "${network}" --cpus 2 \
      --memory "${VALHALLA_SERVE_MEMORY:-4g}" \
      -e build_admins=False -e build_elevation=False -e build_tar=True -e build_time_zones=False \
      -e force_rebuild=False -e server_threads=2 -e tile_urls= -e traffic_name= \
      -e use_default_speeds_config=True -e use_tiles_ignore_pbf=True \
      -e default_speeds_config_url="${speeds_url}" \
      -v "${valhalla_stage}:/custom_files" "${valhalla_image}" >/dev/null
    docker network connect "${network}" navoss-nominatim-stage 2>/dev/null || true
    docker update --memory 6g --memory-swap 6g navoss-nominatim-stage >/dev/null
    docker start navoss-nominatim-stage >/dev/null
    docker rm -f navoss-api-stage >/dev/null 2>&1 || true
    docker run -d --name navoss-api-stage --network "${network}" --memory 768m --cpus 0.75 \
      -p 127.0.0.1:18300:3000 \
      --read-only --tmpfs /tmp:size=32m --cap-drop ALL --security-opt no-new-privileges:true \
      -e HOST=0.0.0.0 -e PORT=3000 -e NODE_ENV=production \
      -e NAVOSS_SERVICE_AREAS="${areas}" \
      -e NOMINATIM_DATASET_VERSION="${label}-geofabrik-20${v%????}-$(printf '%s' "${v}" | cut -c3-4)-$(printf '%s' "${v}" | cut -c5-6)" \
      -e NOMINATIM_URL=http://navoss-nominatim-stage:8080/ \
      -e VALHALLA_STATUS_URL=http://navoss-valhalla-stage:8002/status \
      -e VALHALLA_TRACE_URL=http://navoss-valhalla-stage:8002/trace_attributes \
      -e VALHALLA_URL=http://navoss-valhalla-stage:8002/route \
      "${api_image}" >/dev/null
    wait_for http://127.0.0.1:18300/health navoss-api-stage 600
    echo "Staged API: http://127.0.0.1:18300 (declares ${areas})"
    ;;

  verify)
    NAVOSS_BASE_URL=http://127.0.0.1:18300 NAVOSS_SERVICE_AREAS="${areas}" "${script_dir}/check-coverage.sh"
    echo 'Now run the route matrix from a checkout on your machine through an SSH tunnel:'
    echo '  ssh -N -L 18300:127.0.0.1:18300 navoss-prod &'
    echo '  NAVOSS_API_URL=http://127.0.0.1:18300 ROUTE_QUALITY_OUTPUT=artifacts/route-quality-canada.json \'
    echo '    corepack pnpm --filter @navoss/api test:routes:canada'
    ;;

  stop)
    docker rm -f navoss-api-stage navoss-valhalla-stage >/dev/null 2>&1 || true
    docker stop navoss-nominatim-stage >/dev/null 2>&1 || true
    echo 'Staging containers stopped; staged artifacts are kept.'
    ;;

  status)
    v=$(cat "${version_file}" 2>/dev/null || echo none)
    echo "release ${label} ${v}"
    for marker in "${root}/valhalla-${label}-${v}/.pass1-complete" \
      "${root}/valhalla-${label}-${v}/.navoss-stage-complete" \
      "${root}/nominatim/${label}-${v}/.navoss-import-started" \
      "${root}/nominatim/${label}-${v}/.navoss-import-complete"; do
      [ -e "${marker}" ] && echo "  done: ${marker}"
    done
    docker ps --filter name=navoss-.*-stage --format '  running: {{.Names}} {{.Status}}'
    df -h "${root}" | sed -n 2p
    free -h | sed -n 2p
    ;;

  *)
    echo "Unknown step: ${step}" >&2
    exit 64
    ;;
esac
