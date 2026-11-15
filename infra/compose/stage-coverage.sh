#!/bin/sh
# Builds and verifies a new coverage release beside the live stack, one heavy step at a time.
# Nothing here touches the live containers, their artifact directories or `.env`.
#
#   export GEOFABRIK_VERSION=261114             # one release for every step (required)
#   ./stage-coverage.sh inputs    canada        # download, verify, filter (9 min on VM 100)
#   ./stage-coverage.sh valhalla  canada        # graph, two passes (≈35 min on VM 100)
#   sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh nominatim canada # search (12–24 h estimated)
#   sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh serve canada
#   sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh verify canada
#   sudo -n env GEOFABRIK_VERSION=261114 ./stage-coverage.sh stop canada
#   ./stage-coverage.sh status    canada
#
# `canada` may be replaced by Geofabrik province names for a regional release, for example
# `alberta british-columbia ontario` (staged search). Run under tmux: every step is resumable and
# re-running a finished step only re-verifies it. One step runs at a time on the host: `inputs`,
# `valhalla`, `nominatim`, `serve` and `stop` hold <artifact root>/.stage.lock for their whole run,
# and a second one is refused. See docs/architecture/north-america.md.
set -eu
# Nothing may wait for an answer during a multi-hour step: anything interactive fails instead.
exec </dev/null

script_dir=$(cd "$(dirname "$0")" && pwd)
root=${NAVOSS_ARTIFACT_ROOT:-/srv/navoss/artifacts}
imports=${root}/imports
valhalla_image=ghcr.io/valhalla/valhalla-scripted:3.8.2
nominatim_image=mediagis/nominatim:5.3
api_image=${STAGE_API_IMAGE:-navoss-api:latest}
speeds_url=https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json
network=navoss-stage

if [ "$#" -lt 2 ]; then
  sed -n '2,18p' "$0" >&2
  exit 64
fi
step=$1
shift
label=$(printf '%s' "$*" | tr ' ' '-')

# The live artifact paths come from the deployed `.env` beside this script; without it no step can
# tell staged from live data, so none runs.
env_file=${script_dir}/.env
if [ ! -r "${env_file}" ]; then
  echo "${env_file} is missing or unreadable. Run from the deployed infra/compose, whose .env names" >&2
  echo "the live VALHALLA_DATA_DIR and NOMINATIM_DATA_DIR." >&2
  exit 1
fi
live_valhalla=$(sed -n 's/^VALHALLA_DATA_DIR=//p' "${env_file}" | tail -n 1)
live_nominatim=$(sed -n 's/^NOMINATIM_DATA_DIR=//p' "${env_file}" | tail -n 1)
# Relative values are relative to the .env's directory, as Compose reads them.
case "${live_valhalla}" in '' | /*) ;; *) live_valhalla=${script_dir}/${live_valhalla} ;; esac
case "${live_nominatim}" in '' | /*) ;; *) live_nominatim=${script_dir}/${live_nominatim} ;; esac

# Only hand back individual script-owned entries, never a container's tree or a symlink target.
# A hard-linked regular file may belong to another artifact, so leave it alone too.
handoff() {
  [ "$(id -u)" -eq 0 ] || return 0
  for entry do
    [ ! -L "${entry}" ] || continue
    if [ -f "${entry}" ] && [ "$(stat -c %h -- "${entry}")" != 1 ]; then continue; fi
    chown -h --reference="${root}" -- "${entry}"
  done
}

# Input helpers write their own files, including resumable partial downloads. Run them as the
# artifact owner instead of changing ownership of pre-existing inputs or container-written data.
input_helper() {
  if [ "$(id -u)" -eq 0 ] && [ "$(stat -c %u -- "${root}")" -ne 0 ]; then
    runuser -u "$(stat -c %U -- "${root}")" -- "$@"
  else
    "$@"
  fi
}
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
    handoff "${lock_file}"
    if [ "${step}" != stop ] && ! flock -n 9; then
      echo "Another staging step is running: $(cut -d ' ' -f 4- "${holder_file}" 2>/dev/null)." >&2
      echo "Wait for it, or end it with '$0 stop ${label}'." >&2
      exit 1
    fi
    ;;
esac
process_start() {
  # process_start PID: the kernel's start time of PID (clock ticks since boot); empty if none.
  sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 20
}
hold_stage_lock() {
  # The pid with its start time: `stop` signals it only if that same process still runs.
  holder_next=$(mktemp "${holder_file}.XXXXXX")
  printf '%s %s %s %s %s\n' "$$" "$(process_start "$$")" "$(cat /proc/sys/kernel/random/boot_id)" \
    "${step}" "${label}" >"${holder_next}"
  chmod 0644 "${holder_next}"
  handoff "${holder_next}"
  mv -f "${holder_next}" "${holder_file}"
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

# One Geofabrik release for every step: GEOFABRIK_VERSION must be exported and, after `inputs`,
# match what `inputs` recorded, so no later step can resolve a newer daily release.
version_file=${imports}/${label}.stage-version
pinned_version() {
  if ! printf '%s\n' "${GEOFABRIK_VERSION:-}" | grep -Eqx '[0-9]{6}'; then
    echo "Export the release every step uses first, e.g. 'export GEOFABRIK_VERSION=261114'." >&2
    exit 64
  fi
  printf '%s\n' "${GEOFABRIK_VERSION}"
}
version() {
  pinned=$(pinned_version)
  [ -s "${version_file}" ] || { echo "Run '$0 inputs ${label}' first." >&2; exit 1; }
  recorded=$(cat "${version_file}")
  if [ "${recorded}" != "${pinned}" ]; then
    echo "GEOFABRIK_VERSION=${pinned}, but '${label}' was prepared from ${recorded}; refusing to mix releases." >&2
    exit 1
  fi
  printf '%s\n' "${recorded}"
}

require_free_space() {
  # require_free_space GB: refuses to start a step without its peak disk use plus a margin free on
  # the artifact disk (STAGE_MIN_FREE_GB overrides it, e.g. for a small sample).
  need=${STAGE_MIN_FREE_GB:-$1}
  free_gb=$(df -Pk "${root}" | awk 'NR == 2 { print int($4 * 1024 / 1000000000) }')
  if [ "${free_gb}" -lt "${need}" ]; then
    echo "${step} needs ${need} GB free on ${root}; ${free_gb} GB is. Nothing was started." >&2
    exit 1
  fi
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

refuse_other_steps_containers() {
  # Under the lock, before any container starts: a staging container another step started (or an
  # unlabelled one from an older script) may outlive its crashed parent and still hold its memory.
  # This step's own are replaced by it.
  docker ps --format '{{.Names}} {{.Label "navoss.stage.step"}}' | while read -r name started_by; do
    case "${name}" in navoss-valhalla-stage | navoss-nominatim-stage | navoss-api-stage) ;; *) continue ;; esac
    if [ "${started_by}" != "${step}" ]; then
      echo "${name} is running (started by ${started_by:-an older script}). Run one step at a time ('$0 stop ${label}')." >&2
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
    password_next=$(umask 077 && mktemp "${password_file}.XXXXXX")
    printf 'NOMINATIM_PASSWORD=%s\n' \
      "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" >"${password_next}"
    mv -f "${password_next}" "${password_file}"
  fi
  if [ "$(id -u)" -eq 0 ]; then
    if [ -L "${password_file}" ] || [ ! -f "${password_file}" ] ||
      [ "$(stat -c %h -- "${password_file}")" != 1 ]; then
      echo "Refusing unsafe staging password file ${password_file}." >&2
      exit 1
    fi
    chown 0:0 "${password_file}"
    chmod 0600 "${password_file}"
  fi
  container_stage=$1
  shift
  docker rm -f navoss-nominatim-stage >/dev/null 2>&1 || true
  docker create --name navoss-nominatim-stage --label "navoss.stage.step=${step}" --env-file "${password_file}" --shm-size 2g \
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
      # The image ignores OSM2PGSQL_CACHE, and Nominatim then sizes the node cache from the host's
      # memory and the extract (12.4 GB for Canada), not the container's limit: the import was
      # OOM-killed ten minutes in. Pass the cache explicitly on every import command.
      sed -i 's|nominatim import --osm-file \$OSMFILE --threads \$THREADS|& --osm2pgsql-cache "${OSM2PGSQL_CACHE:?}"|' "${image_script}"
      if ! grep -q 'nominatim import' "${image_script}" ||
        grep 'nominatim import' "${image_script}" | grep -qv -- '--osm2pgsql-cache'; then
        rm -f "${image_script}"
        docker rm -f navoss-nominatim-stage >/dev/null
        echo "The image's /app/init.sh import command changed; refusing to import with an unbounded osm2pgsql cache." >&2
        exit 1
      fi
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

physical_id() {
  # physical_id PATH: device:inode of what PATH resolves to; `absent` only when PATH certainly does
  # not exist (a readable directory on its way lacks the next name). Fails when it cannot tell, e.g.
  # a path through a directory the operator cannot traverse: callers then refuse, never assume
  # "different".
  if canonical=$(realpath -e -- "$1" 2>/dev/null); then
    stat -L -c '%d:%i' -- "${canonical}"
    return
  fi
  name=$(basename -- "$1")
  parent=$(dirname -- "$1")
  case "${name}" in . | .. | /) return 1 ;; esac
  [ ! -L "$1" ] || return 1
  if [ -d "${parent}" ] && [ -x "${parent}" ] && [ -r "${parent}" ]; then
    if ls -A -- "${parent}" | grep -qxF -- "${name}"; then return 1; fi
    echo absent
    return
  fi
  [ "$(physical_id "${parent}")" = absent ] || return 1
  echo absent
}

refuse_live() {
  # refuse_live NAME LIVE_PATH PATH...: stops the step before it changes or mounts anything when a
  # PATH is the live NAME directory (same device and inode, however either is written), or when
  # either cannot be inspected.
  live_name=$1
  live_path=$2
  shift 2
  if [ -z "${live_path}" ] || ! live_id=$(physical_id "${live_path}") || [ "${live_id}" = absent ]; then
    echo "Cannot inspect the live ${live_name} (${live_path:-not set in ${env_file}}); refusing. Rerun this step with sudo." >&2
    exit 1
  fi
  for candidate do
    if ! candidate_id=$(physical_id "${candidate}"); then
      echo "Cannot inspect ${candidate}; refusing." >&2
      exit 1
    fi
    if [ "${candidate_id}" = "${live_id}" ]; then
      echo "${candidate} is the live ${live_name}; refusing." >&2
      exit 1
    fi
  done
}

remove_in_stage() {
  # remove_in_stage valhalla|nominatim STAGE NAME...: removes STAGE/NAME. The Valhalla and Nominatim
  # containers write as root (tiles, archives, configs; the cluster as the image's postgres user),
  # which the operator cannot delete; a root container with no network, only DAC_OVERRIDE and no
  # other mount than STAGE does it. STAGE must be <artifact root>/valhalla-<label>-<YYMMDD> or
  # <artifact root>/nominatim/<label>-<YYMMDD>, a real directory, and not the live data; each NAME
  # is a single entry inside it.
  kind=$1
  target=$2
  shift 2
  case "${root}" in /*) ;; *) echo "The artifact root must be absolute: ${root}" >&2; exit 1 ;; esac
  case "${kind}" in
    valhalla) prefix=${root}/valhalla- live_name=VALHALLA_DATA_DIR live_path=${live_valhalla} ;;
    nominatim) prefix=${root}/nominatim/ live_name=NOMINATIM_DATA_DIR live_path=${live_nominatim} ;;
    *) exit 64 ;;
  esac
  if ! printf '%s\n' "${target#"${prefix}"}" | grep -Eqx '[a-z][a-z-]*-[0-9]{6}' ||
    [ "${target}" != "${prefix}${target#"${prefix}"}" ] || [ -L "${target}" ] || [ ! -d "${target}" ]; then
    echo "Refusing to remove anything in ${target}: not a staged ${kind} directory." >&2
    exit 1
  fi
  inside=
  for name do
    case "${name}" in
      '' | . | .. | */* | *[[:space:]]* | *[*?[]*) echo "Refusing to remove '${name}' in ${target}." >&2; exit 1 ;;
    esac
    refuse_live "${live_name}" "${live_path}" "${target}/${name}"
    inside="${inside} /stage/${name}"
  done
  refuse_live "${live_name}" "${live_path}" "${target}"
  # A bind mount includes the mounts below it: if anything under the stage were a mount of other data,
  # a root `rm -rf` would delete through it. Refuse any mount point at or below the stage, and mount
  # the stage itself without them (Docker 25 or later).
  canonical_target=$(realpath -e -- "${target}")
  if awk '{ print $5 }' /proc/self/mountinfo | sed 's/\\040/ /g' |
    grep -qxE "$(printf '%s' "${canonical_target}" | sed 's/[][\.*^$+?(){}|/]/\\&/g')(/.*)?"; then
    echo "Refusing to remove anything in ${target}: a mount point is at or below it." >&2
    exit 1
  fi
  docker_major=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d . -f 1)
  case "${docker_major}" in '' | *[!0-9]*) docker_major=0 ;; esac
  if [ "${docker_major}" -lt 25 ]; then
    echo "Docker ${docker_major} cannot bind-mount without submounts (needs 25 or later); nothing removed." >&2
    exit 1
  fi
  # shellcheck disable=SC2086 # one path per entry, none with spaces (checked above)
  docker run --rm --network none --user 0 --cap-drop ALL --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges:true --memory 256m --memory-swap 256m --entrypoint rm \
    --mount "type=bind,src=${canonical_target},dst=/stage,bind-recursive=disabled" \
    "${nominatim_image}" -rf ${inside}
  for name do
    [ ! -e "${target}/${name}" ] || { echo "${target}/${name} is still there." >&2; exit 1; }
  done
}

valhalla_run() {
  # valhalla_run DIR BUILD_ADMINS FORCE_REBUILD IGNORE_PBF
  docker rm -f navoss-valhalla-stage >/dev/null 2>&1 || true
  docker run -d --name navoss-valhalla-stage --label "navoss.stage.step=${step}" \
    --cpus "${VALHALLA_BUILD_CPUS:-4}" --cpuset-cpus "${VALHALLA_BUILD_CPUSET:-0-3}" \
    --memory "${VALHALLA_BUILD_MEMORY:-8g}" --memory-swap "${VALHALLA_BUILD_MEMORY:-8g}" \
    -p 127.0.0.1:18002:8002 \
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
    refuse_other_steps_containers
    pinned=$(pinned_version)
    if [ -s "${version_file}" ] && [ "$(cat "${version_file}")" != "${pinned}" ]; then
      echo "'${label}' is staged from $(cat "${version_file}"); remove ${version_file} to start ${pinned}." >&2
      exit 1
    fi
    require_free_space 20
    v=$(input_helper "${script_dir}/prepare-regional-pbf.sh" "$@")
    [ "${v}" = "${pinned}" ] || { echo "Prepared ${v}, not ${pinned}." >&2; exit 1; }
    input_helper "${script_dir}/filter-routing-pbf.sh" "${imports}/${label}-${v}.osm.pbf"
    version_next=$(mktemp "${version_file}.XXXXXX")
    printf '%s\n' "${v}" >"${version_next}"
    chmod 0644 "${version_next}"
    handoff "${version_next}"
    mv -f "${version_next}" "${version_file}"
    df -h "${root}" | sed -n 2p
    ;;

  valhalla)
    hold_stage_lock
    refuse_other_steps_containers
    v=$(version)
    stage=${root}/valhalla-${label}-${v}
    refuse_live VALHALLA_DATA_DIR "${live_valhalla}" "${stage}"
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
    require_free_space 30
    install -d -m 0750 "${stage}"
    handoff "${stage}"
    if [ ! -f "${staged_pbf}" ]; then
      ln "${routing}" "${staged_pbf}" 2>/dev/null || { cp "${routing}" "${staged_pbf}"; handoff "${staged_pbf}"; }
    fi
    if [ ! -f "${stage}/timezones.sqlite" ]; then
      cp "${live_valhalla}/timezones.sqlite" "${stage}/timezones.sqlite"
      handoff "${stage}/timezones.sqlite"
    fi
    tz=$(docker run --rm --network none --memory 1g --memory-swap 1g --entrypoint spatialite -v "${stage}:/d:ro" "${valhalla_image}" \
      -batch -noheader -list /d/timezones.sqlite \
      "SELECT COUNT(DISTINCT TZID) FROM tz_world WHERE TZID IN ('America/St_Johns','America/Halifax','America/Moncton','America/Toronto','America/Winnipeg','America/Regina','America/Edmonton','America/Vancouver','America/Whitehorse');")
    [ "${tz}" = 9 ] || { echo "timezones.sqlite lacks Canadian zones (${tz}/9)." >&2; exit 1; }
    if [ ! -f "${stage}/.pass1-complete" ]; then
      # An interrupted first pass leaves partial tiles, written as root by the container; start clean.
      remove_in_stage valhalla "${stage}" valhalla_tiles valhalla_tiles.tar admins.sqlite \
        admins.pre-country-parent.sqlite file_hashes.txt valhalla.json
    fi
    VALHALLA_HYBRID_PROVINCES="${hybrid}" "${script_dir}/prepare-valhalla-speeds.sh" "${stage}"
    handoff "${stage}/default_speeds.json" "${stage}/default_speeds.provenance"
    if [ ! -f "${stage}/.pass1-complete" ]; then
      valhalla_run "${stage}" True False True
      docker rm -f navoss-valhalla-stage >/dev/null
      touch "${stage}/.pass1-complete"
      handoff "${stage}/.pass1-complete"
    fi
    VALHALLA_ADMIN_PROVINCES="${codes}" "${script_dir}/repair-valhalla-admins.sh" "${stage}"
    valhalla_run "${stage}" False True False
    docker rm -f navoss-valhalla-stage >/dev/null
    (cd "${stage}" && sha256sum valhalla_tiles.tar admins.sqlite default_speeds.json timezones.sqlite \
      >.navoss-stage-complete.next)
    handoff "${stage}/.navoss-stage-complete.next"
    mv -f "${stage}/.navoss-stage-complete.next" "${stage}/.navoss-stage-complete"
    du -sh "${stage}"
    ;;

  nominatim)
    hold_stage_lock
    refuse_other_steps_containers
    v=$(version)
    stage=${root}/nominatim/${label}-${v}
    refuse_live NOMINATIM_DATA_DIR "${live_nominatim}" "${stage}" "${stage}/postgres"
    if [ -f "${stage}/.navoss-import-complete" ]; then
      handoff "${stage}" "${stage}/.navoss-import-complete"
      echo "Nominatim stage ${stage} is complete."
      exit 0
    fi
    if [ ! -d "${root}/nominatim" ]; then
      install -d -m 0750 "${root}/nominatim"
      handoff "${root}/nominatim"
    fi
    install -d -m 0750 "${stage}"
    handoff "${stage}"
    if [ -f "${stage}/.navoss-import-started" ]; then
      # The image treats any existing cluster as imported; an interrupted import must start over.
      echo "Discarding the interrupted import in ${stage}/postgres."
      docker rm -f navoss-nominatim-stage >/dev/null 2>&1 || true
      remove_in_stage nominatim "${stage}" postgres
    fi
    install -d -m 0700 "${stage}/postgres"
    require_free_space 130
    nominatim_container "${stage}" --cpus "${NOMINATIM_IMPORT_CPUS:-4}" \
      --memory "${NOMINATIM_IMPORT_MEMORY:-10g}" --memory-swap "${NOMINATIM_IMPORT_MEMORY:-10g}" \
      -e OSM2PGSQL_CACHE="${NOMINATIM_OSM2PGSQL_CACHE:-3000}" \
      -e THREADS="${NOMINATIM_IMPORT_THREADS:-4}"
    touch "${stage}/.navoss-import-started"
    handoff "${stage}/.navoss-import-started"
    started=$(date +%s)
    docker start navoss-nominatim-stage >/dev/null
    wait_for http://127.0.0.1:18080/status navoss-nominatim-stage "${NOMINATIM_IMPORT_TIMEOUT:-129600}"
    printf 'Import took %s min.\n' $(( ($(date +%s) - started) / 60 ))
    docker stop navoss-nominatim-stage >/dev/null
    mv -f "${stage}/.navoss-import-started" "${stage}/.navoss-import-complete"
    du -sh "${stage}/postgres"
    ;;

  serve)
    hold_stage_lock
    refuse_other_steps_containers
    v=$(version)
    valhalla_stage=${root}/valhalla-${label}-${v}
    nominatim_stage=${root}/nominatim/${label}-${v}
    refuse_live VALHALLA_DATA_DIR "${live_valhalla}" "${valhalla_stage}"
    refuse_live NOMINATIM_DATA_DIR "${live_nominatim}" "${nominatim_stage}" "${nominatim_stage}/postgres"
    [ -f "${valhalla_stage}/.navoss-stage-complete" ] && [ -f "${nominatim_stage}/.navoss-import-complete" ] ||
      { echo 'Finish the valhalla and nominatim steps first.' >&2; exit 1; }
    handoff "${nominatim_stage}" "${nominatim_stage}/.navoss-import-complete"
    require_free_space 2
    docker network inspect "${network}" >/dev/null 2>&1 || docker network create "${network}" >/dev/null
    # Serving only: tiles exist, so the image builds nothing.
    docker rm -f navoss-valhalla-stage >/dev/null 2>&1 || true
    docker run -d --name navoss-valhalla-stage --label "navoss.stage.step=${step}" --network "${network}" --cpus 2 \
      --memory "${VALHALLA_SERVE_MEMORY:-4g}" --memory-swap "${VALHALLA_SERVE_MEMORY:-4g}" \
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
    docker run -d --name navoss-api-stage --label "navoss.stage.step=${step}" --network "${network}" --memory 768m --memory-swap 768m \
      --cpus 0.75 \
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
      # Signal only a holder whose recorded start time matches the running process: the record
      # may be stale (a reused pid after a crash or reboot) or not yet written by a step that has
      # just taken the lock.
      waited=0
      while :; do
        holder= holder_start= holder_boot= holder_step= holder_label=
        read -r holder holder_start holder_boot holder_step holder_label <"${holder_file}" 2>/dev/null || true
        # Start times count from boot: a record from another boot names no running process.
        if [ -n "${holder}" ] && [ -n "${holder_start}" ] &&
          [ "${holder_boot}" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
          [ "$(process_start "${holder}")" = "${holder_start}" ]; then
          break
        fi
        if [ "${waited}" -ge "${STAGE_HOLDER_WAIT:-10}" ]; then
          echo "The staging lock is held, but its holder cannot be verified (${holder_file}); nothing signalled or removed." >&2
          exit 1
        fi
        sleep 1
        waited=$((waited + 1))
      done
      if [ "$(sed 's/.*) //' "/proc/${holder}/stat" | cut -d ' ' -f 3)" = "${holder}" ]; then
        kill -TERM "-${holder}" 2>/dev/null || true
      else
        kill -TERM "${holder}" 2>/dev/null || true
      fi
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
      echo "  step running: $(cut -d ' ' -f 4- "${holder_file}" 2>/dev/null)"
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
