#!/bin/sh
# Builds and verifies a new coverage release beside the live stack, one heavy step at a time.
# Nothing here touches the live containers, their artifact directories or `.env`.
#
#   ./stage-coverage.sh inputs    canada        # download, verify, filter (≈30 min, 13 GB)
#   ./stage-coverage.sh valhalla  canada        # graph, two passes (≈2–4 h, ≈20 GB peak, 8 GiB)
#   ./stage-coverage.sh nominatim canada        # search import (≈12–24 h, ≤110 GB peak, 10 GiB)
#   ./stage-coverage.sh serve     canada        # staged Valhalla + Nominatim + API on 127.0.0.1:18300
#   ./stage-coverage.sh verify    canada        # check-coverage.sh against the staged API
#   ./stage-coverage.sh stop      canada        # end the running step, remove staging containers
#   ./stage-coverage.sh status    canada
#
# `canada` may be replaced by Geofabrik province names for a regional release, for example
# `alberta british-columbia ontario` (staged search). Run under tmux: every step is resumable and
# re-running a finished step only re-verifies it. One step runs at a time on the host: `inputs`,
# `valhalla`, `nominatim`, `serve` and `stop` hold <artifact root>/.stage.lock for their whole run,
# and a second one is refused. See docs/architecture/north-america.md.
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

lock_file=${root}/.stage.lock
holder_file=${root}/.stage.holder
case "${step}" in
  inputs | valhalla | nominatim | serve | stop)
    # A step is its own process group, so `stop` can end it with every child (osmium, docker
    # clients, waits). Interactive shells already start one per command; anything else re-executes.
    if [ "$(sed 's/.*) //' /proc/$$/stat | cut -d ' ' -f 3)" != "$$" ]; then
      exec setsid /bin/sh "$0" "${step}" "$@"
    fi
    exec 9>>"${lock_file}"
    if [ "${step}" != stop ] && ! flock -n 9; then
      echo "Another staging step is running: $(cut -d ' ' -f 2- "${holder_file}" 2>/dev/null)." >&2
      echo "Wait for it, or end it with '$0 stop ${label}'." >&2
      exit 1
    fi
    ;;
esac
hold_stage_lock() {
  printf '%s %s %s\n' "$$" "${step}" "${label}" >"${holder_file}"
}

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
  # Under the lock: a container left by `serve`, or by a step this one does not resume, still
  # holds its memory.
  for other in navoss-valhalla-stage navoss-nominatim-stage navoss-api-stage; do
    if [ "${other}" != "$1" ] && docker ps --format '{{.Names}}' | grep -qx "${other}"; then
      echo "${other} is running. Run one heavy step at a time ('$0 stop ${label}')." >&2
      exit 1
    fi
  done
}

nominatim_container() {
  # nominatim_container STAGE [DOCKER CREATE OPTIONS...]: creates (not starts) the staging Nominatim
  # over STAGE's cluster and extract. Both image scripts run under `bash -x` and print the password
  # (start.sh in `useradd -p`, init.sh in `ALTER USER`); tracing is turned off in both, or nothing
  # starts. The password is this stage's own, never production's: the import stores it as the
  # cluster's `nominatim` and `www-data` role passwords (docs: Nominatim staging password).
  password_file=$1/staging-password.env
  if [ ! -s "${password_file}" ]; then
    (umask 077 && printf 'NOMINATIM_PASSWORD=%s\n' \
      "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" >"${password_file}.next")
    mv "${password_file}.next" "${password_file}"
  fi
  container_stage=$1
  shift
  docker rm -f navoss-nominatim-stage >/dev/null 2>&1 || true
  docker create --name navoss-nominatim-stage --env-file "${password_file}" --shm-size 2g \
    -p 127.0.0.1:18080:8080 \
    -e FREEZE=true -e GUNICORN_WORKERS=2 -e IMPORT_SECONDARY_WIKIPEDIA=false \
    -e IMPORT_STYLE=full -e IMPORT_WIKIPEDIA=false -e PBF_PATH=/regional-data/regional.osm.pbf \
    -e POSTGRES_AUTOVACUUM_WORK_MEM=256MB -e POSTGRES_EFFECTIVE_CACHE_SIZE=6GB \
    -e POSTGRES_MAINTENANCE_WORK_MEM=1GB -e POSTGRES_MAX_CONNECTIONS=30 \
    -e POSTGRES_MAX_LOCKS_PER_TRANSACTION=256 -e POSTGRES_MAX_WAL_SIZE=2GB \
    -e POSTGRES_SHARED_BUFFERS=2GB -e POSTGRES_WORK_MEM=32MB -e UPDATE_MODE=none "$@" \
    -v "${imports}/${label}-${v}.osm.pbf:/regional-data/regional.osm.pbf:ro" \
    -v "${container_stage}/postgres:/var/lib/postgresql/16/main" \
    "${nominatim_image}" >/dev/null
  image_script=$(mktemp)
  for script in start.sh init.sh; do
    docker cp "navoss-nominatim-stage:/app/${script}" "${image_script}"
    sed -i '1s|^#!/bin/bash -ex$|#!/bin/bash -e|' "${image_script}"
    if [ "${script}" = init.sh ]; then
      # The import's lock limit (the image sets it only for the serving configuration).
      sed -i '/cp \/etc\/postgresql\/16\/main\/conf.d\/postgres-import.conf.disabled/a sed -i "s/^#max_locks_per_transaction = 64/max_locks_per_transaction = ${POSTGRES_MAX_LOCKS_PER_TRANSACTION}/" /etc/postgresql/16/main/postgresql.conf' "${image_script}"
    fi
    if [ "$(head -n 1 "${image_script}")" != '#!/bin/bash -e' ] || grep -q 'set -[a-z]*x' "${image_script}"; then
      rm -f "${image_script}"
      docker rm -f navoss-nominatim-stage >/dev/null
      echo "The image's /app/${script} no longer starts with '#!/bin/bash -ex'; refusing to run it with tracing." >&2
      exit 1
    fi
    docker cp "${image_script}" "navoss-nominatim-stage:/app/${script}"
  done
  rm -f "${image_script}"
}

refuse_live_nominatim() {
  # refuse_live_nominatim STAGE LIVE_DATA_DIR: STAGE/postgres must not be the live cluster, by name
  # or through a link.
  if [ "$1/postgres" = "$2" ] ||
    { [ -e "$1/postgres" ] && [ -e "$2" ] && [ "$(realpath "$1/postgres")" = "$(realpath "$2")" ]; }; then
    echo 'Refusing to touch the live NOMINATIM_DATA_DIR.' >&2
    exit 1
  fi
}

discard_cluster() {
  # discard_cluster STAGE: removes STAGE/postgres. The image chowns a cluster to its postgres user
  # with mode 0700, which the operator cannot delete; a root container with no network and no other
  # mount than STAGE does it. STAGE must be <artifact root>/nominatim/<label>-<YYMMDD>, a real
  # directory, and not hold the live cluster.
  case "${root}" in /*) ;; *) echo "The artifact root must be absolute: ${root}" >&2; exit 1 ;; esac
  if ! printf '%s\n' "${1#"${root}/nominatim/"}" | grep -Eqx '[a-z][a-z-]*-[0-9]{6}' ||
    [ "${1}" != "${root}/nominatim/${1#"${root}/nominatim/"}" ] || [ -L "$1" ] || [ -L "$1/postgres" ]; then
    echo "Refusing to discard ${1}/postgres: not a staged Nominatim directory." >&2
    exit 1
  fi
  refuse_live_nominatim "$1" "${live}"
  docker run --rm --network none --user 0 --cap-drop ALL --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges:true --memory 256m --entrypoint rm \
    -v "$1:/stage" "${nominatim_image}" -rf /stage/postgres
  [ ! -e "$1/postgres" ] || { echo "${1}/postgres is still there." >&2; exit 1; }
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
    hold_stage_lock
    refuse_parallel_heavy_step none
    v=$("${script_dir}/prepare-regional-pbf.sh" "$@")
    "${script_dir}/filter-routing-pbf.sh" "${imports}/${label}-${v}.osm.pbf"
    printf '%s\n' "${v}" >"${version_file}"
    df -h "${root}" | sed -n 2p
    ;;

  valhalla)
    hold_stage_lock
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
    hold_stage_lock
    refuse_parallel_heavy_step navoss-nominatim-stage
    v=$(version)
    stage=${root}/nominatim/${label}-${v}
    if [ -f "${stage}/.navoss-import-complete" ]; then
      echo "Nominatim stage ${stage} is complete."
      exit 0
    fi
    live=$(sed -n 's/^NOMINATIM_DATA_DIR=//p' "${script_dir}/.env" 2>/dev/null | tail -n 1)
    install -d -m 0750 "${stage}"
    refuse_live_nominatim "${stage}" "${live}"
    if [ -f "${stage}/.navoss-import-started" ]; then
      # The image treats any existing cluster as imported; an interrupted import must start over.
      echo "Discarding the interrupted import in ${stage}/postgres."
      docker rm -f navoss-nominatim-stage >/dev/null 2>&1 || true
      discard_cluster "${stage}"
    fi
    install -d -m 0700 "${stage}/postgres"
    nominatim_container "${stage}" --cpus "${NOMINATIM_IMPORT_CPUS:-4}" \
      --memory "${NOMINATIM_IMPORT_MEMORY:-10g}" --memory-swap "${NOMINATIM_IMPORT_MEMORY:-10g}" \
      -e OSM2PGSQL_CACHE="${NOMINATIM_OSM2PGSQL_CACHE:-3000}" \
      -e THREADS="${NOMINATIM_IMPORT_THREADS:-4}"
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
    hold_stage_lock
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
    # Always a new container over this stage's own cluster and extract: the one the last import left
    # may hold another release.
    nominatim_container "${nominatim_stage}" --network "${network}" --cpus 2 \
      --memory "${NOMINATIM_SERVE_MEMORY:-6g}" --memory-swap "${NOMINATIM_SERVE_MEMORY:-6g}" -e THREADS=2
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
    # End the step holding the lock (its whole process group), then take the lock so no step starts
    # while its containers are removed.
    if ! flock -n 9; then
      read -r holder holder_step holder_label <"${holder_file}"
      kill -TERM "-${holder}" 2>/dev/null || kill -TERM "${holder}" 2>/dev/null || true
      flock -w "${STAGE_STOP_TIMEOUT:-120}" 9 ||
        { echo "${holder_step} ${holder_label} (pid ${holder}) did not end; nothing removed." >&2; exit 1; }
      echo "Stopped ${holder_step} ${holder_label}."
    fi
    hold_stage_lock
    docker rm -f navoss-api-stage navoss-valhalla-stage navoss-nominatim-stage >/dev/null 2>&1 || true
    echo 'Staging containers removed; staged artifacts are kept.'
    ;;

  status)
    v=$(cat "${version_file}" 2>/dev/null || echo none)
    echo "release ${label} ${v}"
    if [ -e "${lock_file}" ] && ! flock -n "${lock_file}" true; then
      echo "  step running: $(cut -d ' ' -f 2- "${holder_file}" 2>/dev/null)"
    fi
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
