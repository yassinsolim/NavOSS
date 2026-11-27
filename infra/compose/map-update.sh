#!/bin/sh
# Keeps the live Canada routing graph and search index on a recent Geofabrik release
# (docs/operations/proxmox-vm.md, "Automatic map updates"). Run weekly by navoss-map-update.timer as
# root from the deployed infra/compose:
#
#   ./map-update.sh run                  # check, gate, build, verify, swap or roll back, prune
#   ./map-update.sh plan                 # dry run: release check, gates and plan; changes nothing
#   ./map-update.sh status               # last run's status file
#   ./map-update.sh rollback valhalla    # back to the previous graph (or `nominatim`: index)
#
# Every build step is stage-coverage.sh; this script decides what is due, refuses when storage or
# memory could not absorb the build, swaps `.env` only after the staged data passed the probes, and
# rolls back when the live stack then fails check-stack.sh or the public probes. It holds
# <artifact root>/.stage.lock for the whole run, so it never overlaps a manual staging step.
#
# Exit status: 0 up to date or updated; 75 refused by a gate or the lock (nothing changed);
# 1 failed (the live data was left or put back as it was); 2 the rollback itself failed.
set -eu
exec </dev/null

script_dir=$(cd "$(dirname "$0")" && pwd)
root=${NAVOSS_ARTIFACT_ROOT:-/srv/navoss/artifacts}
imports=${root}/imports
state_dir=${NAVOSS_MAP_UPDATE_STATE:-/srv/navoss/state/map-update}
env_file=${script_dir}/.env
label=canada
geofabrik=${GEOFABRIK_URL:-https://download.geofabrik.de}
latest_url=${geofabrik}/north-america/canada/canada-latest.osm.pbf
public_url=${NAVOSS_PUBLIC_URL:-https://navoss-api.yassin.app}
local_url=${NAVOSS_LOCAL_URL:-http://127.0.0.1:8080}
valhalla_image=ghcr.io/valhalla/valhalla-scripted:3.8.2
speeds_url=https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json
matrix=${ROUTE_QUALITY_CANADA:-${script_dir}/../../apps/api/scripts/route-quality-canada.json}
# Gates. The pool alerts at 80 %; a build may take it to POOL_MAX_PCT at most, which leaves the
# rest for the other guests while it runs.
pool_max_pct=${MAP_UPDATE_POOL_MAX_PCT:-78}
pool_path=${MAP_UPDATE_POOL_PATH:-/nodes/pve01/storage/nvme-fast/status}
disk_margin_gb=${MAP_UPDATE_DISK_MARGIN_GB:-20}
memory_floor_gib=${MAP_UPDATE_MEMORY_FLOOR_GIB:-4}
nominatim_max_age_days=${MAP_UPDATE_NOMINATIM_MAX_AGE_DAYS:-28}
keep_logs=${MAP_UPDATE_KEEP_LOGS:-30}
export PVE_API_CONF="${PVE_API_CONF:-/home/navoss/.config/proxmox}"
pve_api=${MAP_UPDATE_PVE_API:-pve-api}

command=${1:-}
case "${command}" in
  run | plan | status) ;;
  rollback)
    case "${2:-}" in valhalla | nominatim) ;; *) sed -n '2,10p' "$0" >&2; exit 64 ;; esac
    ;;
  *) sed -n '2,10p' "$0" >&2; exit 64 ;;
esac

if [ "${command}" = status ]; then
  cat "${state_dir}/status.json" 2>/dev/null || echo 'No map update has run yet.'
  exit 0
fi

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ---- Run record: a log per run and one status file -------------------------------------------
install -d -m 0750 "${state_dir}" "${state_dir}/runs"
started=$(date -u +%FT%TZ)
run_log=${state_dir}/runs/$(date -u +%Y%m%dT%H%M%SZ)-${command}.log
fifo=$(mktemp -u)
mkfifo -m 0600 "${fifo}"
tee -a "${run_log}" <"${fifo}" &
tee_pid=$!
exec >"${fifo}" 2>&1
rm -f "${fifo}"

result=failed
reason='ended unexpectedly'
latest=
swap_backup=
swap_services=
write_status() {
  next=$(mktemp "${state_dir}/status.json.XXXXXX")
  jq -n --arg command "${command}" --arg started "${started}" --arg finished "$(date -u +%FT%TZ)" \
    --arg result "${result}" --arg reason "${reason}" --arg latest "${latest}" --arg log "${run_log}" \
    --arg valhalla "$(env_value VALHALLA_DATA_DIR)" --arg nominatim "$(env_value NOMINATIM_DATA_DIR)" \
    --arg dataset "$(env_value NOMINATIM_DATASET_VERSION)" \
    --arg previousValhalla "$(cat "${state_dir}/previous-valhalla" 2>/dev/null)" \
    --arg previousNominatim "$(cat "${state_dir}/previous-nominatim" 2>/dev/null)" \
    '{command: $command, started: $started, finished: $finished, result: $result, reason: $reason,
      geofabrikLatest: $latest, log: $log,
      live: {valhalla: $valhalla, nominatim: $nominatim, nominatimDataset: $dataset},
      previous: {valhalla: $previousValhalla, nominatim: $previousNominatim}}' >"${next}"
  chmod 0644 "${next}"
  mv -f "${next}" "${state_dir}/status.json"
}
finish() {
  status=$?
  trap - EXIT INT TERM
  set +e
  # Interrupted or failed between `.env` change and verification: put the live data back.
  if [ -n "${swap_backup}" ]; then
    log "Run ended during a swap; restoring ${swap_backup}."
    rollback_swap
  fi
  # Only staging containers this run started: a manual `serve` session is never removed.
  [ -z "${owns_stage_containers:-}" ] ||
    docker rm -f navoss-valhalla-stage navoss-nominatim-stage navoss-api-stage >/dev/null 2>&1
  if [ "${command}" = run ] && [ "${status}" -ne 0 ] && [ "${result}" = failed ] &&
    [ "${reason}" = 'ended unexpectedly' ]; then
    reason="exit ${status}; see the log"
  fi
  [ "${command}" = plan ] || write_status
  log "Result: ${result} (${reason}). Log: ${run_log}"
  # The newest logs only.
  # shellcheck disable=SC2012 # names this script chose
  ls -1t "${state_dir}"/runs/*.log 2>/dev/null | tail -n "+$((keep_logs + 1))" | xargs -r rm -f
  exec >/dev/null 2>&1
  wait "${tee_pid}"
  exit "${status}"
}
trap finish EXIT
trap 'exit 143' INT TERM

# ---- Live configuration ------------------------------------------------------------------------
env_value() { sed -n "s/^$1=//p" "${env_file}" 2>/dev/null | tail -n 1; }
[ -r "${env_file}" ] || { reason="${env_file} is missing"; exit 1; }
live_valhalla=$(env_value VALHALLA_DATA_DIR)
live_nominatim=$(env_value NOMINATIM_DATA_DIR)
live_pbf=$(env_value NOMINATIM_PBF_PATH)
live_dataset=$(env_value NOMINATIM_DATASET_VERSION)
if [ -n "$(env_value COMMUNITY_TRAFFIC_GRAPH_ID)" ]; then
  # The verified traffic overlay serves a serving-graph.mts archive, which this script cannot build.
  reason='COMMUNITY_TRAFFIC_GRAPH_ID is set: the traffic overlay graph is updated by hand (README)'
  result=refused
  exit 75
fi

# yymmdd of a path or dataset name; empty when it has none.
version_of() { printf '%s\n' "$1" | sed -n 's/.*canada-\([0-9]\{6\}\).*/\1/p' | head -n 1; }
dataset_version_of() { printf '%s\n' "$1" | sed -n 's/^canada-geofabrik-20\([0-9][0-9]\)-\([0-9][0-9]\)-\([0-9][0-9]\)$/\1\2\3/p'; }
days_between() { echo $((($(date -u -d "20$2" +%s) - $(date -u -d "20$1" +%s)) / 86400)); }
same_dir() { [ -e "$1" ] && [ -e "$2" ] && [ "$(stat -L -c %d:%i -- "$1")" = "$(stat -L -c %d:%i -- "$2")" ]; }

live_valhalla_version=$(version_of "$(basename "${live_valhalla}")")
live_nominatim_version=$(dataset_version_of "${live_dataset}")
[ -n "${live_valhalla_version}" ] && [ -n "${live_nominatim_version}" ] || {
  reason="cannot read the live release from VALHALLA_DATA_DIR (${live_valhalla}) or NOMINATIM_DATASET_VERSION (${live_dataset})"
  exit 1
}

# ---- Rollback targets: what the last swap replaced ------------------------------------------
# Before the updater's first swap, the newest `.env` backup that names another existing directory.
previous_valhalla=$(cat "${state_dir}/previous-valhalla" 2>/dev/null || true)
previous_nominatim=$(cat "${state_dir}/previous-nominatim" 2>/dev/null || true)
# shellcheck disable=SC2012,SC2045 # newest first; names without spaces
for backup in $(ls -1t "${script_dir}"/.env.pre-* "${script_dir}"/.env.bak-* 2>/dev/null); do
  if [ -z "${previous_valhalla}" ]; then
    candidate=$(sed -n 's/^VALHALLA_DATA_DIR=//p' "${backup}" | tail -n 1)
    if [ -n "${candidate}" ] && [ -d "${candidate}" ] && ! same_dir "${candidate}" "${live_valhalla}"; then
      previous_valhalla=${candidate}
      log "Rollback graph taken from ${backup}: ${candidate}"
      [ "${command}" = plan ] || printf '%s\n' "${candidate}" >"${state_dir}/previous-valhalla"
    fi
  fi
  if [ -z "${previous_nominatim}" ]; then
    candidate=$(sed -n 's/^NOMINATIM_DATA_DIR=//p' "${backup}" | tail -n 1)
    if [ -n "${candidate}" ] && [ -d "${candidate}" ] && ! same_dir "${candidate}" "${live_nominatim}"; then
      previous_nominatim=${candidate}
      log "Rollback index taken from ${backup}: ${candidate}"
      [ "${command}" = plan ] || printf '%s\n' "${candidate}" >"${state_dir}/previous-nominatim"
    fi
  fi
done
[ -z "${previous_valhalla}" ] || [ -d "${previous_valhalla}" ] || previous_valhalla=
[ -z "${previous_nominatim}" ] || [ -d "${previous_nominatim}" ] || previous_nominatim=

# ---- The staging lock (shared with stage-coverage.sh) -----------------------------------------
lock_file=${root}/.stage.lock
holder_file=${root}/.stage.holder
exec 9>>"${lock_file}"
if ! flock -n 9; then
  result=refused
  reason="a staging step holds ${lock_file}: $(cut -d ' ' -f 4- "${holder_file}" 2>/dev/null || true)"
  exit 75
fi
hold_lock() {
  # The record stage-coverage.sh `stop` checks before it signals the holder.
  [ "${command}" != plan ] || return 0
  printf '%s %s %s %s %s\n' "$$" "$(sed 's/.*) //' "/proc/$$/stat" | cut -d ' ' -f 20)" \
    "$(cat /proc/sys/kernel/random/boot_id)" map-update "${label}" >"${holder_file}.next"
  chmod 0644 "${holder_file}.next"
  mv -f "${holder_file}.next" "${holder_file}"
}
hold_lock
export STAGE_LOCK_INHERITED=1
# A manual `serve` leaves its staging services up after its step ends; leave them alone.
running_stage=$(docker ps --format '{{.Names}}' | grep -E '^navoss-(valhalla|nominatim|api)-stage$' || true)
if [ -n "${running_stage}" ] && [ "${command}" != plan ]; then
  result=refused
  reason="staging containers are running ($(printf '%s' "${running_stage}" | tr '\n' ' ')); end them with stage-coverage.sh stop"
  exit 75
fi
[ "${command}" = plan ] || owns_stage_containers=1

stage() {
  # stage STEP: one stage-coverage.sh step of this run's release, under this run's lock.
  log "stage-coverage.sh $1 ${label} (${latest})"
  GEOFABRIK_VERSION=${latest} "${script_dir}/stage-coverage.sh" "$1" "${label}"
  hold_lock
}

# ---- Pruning: the live and the previous build of each kind, nothing else -------------------
mounted_dirs() {
  docker ps -aq | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null
}
keep_dir() {
  # keep_dir DIR: whether DIR is live, the rollback, under a container mount, or marked by hand.
  [ ! -e "$1/.navoss-keep" ] || return 0
  for kept in "${live_valhalla}" "${previous_valhalla}" "$(dirname "${live_nominatim}")" \
    "$(dirname "${previous_nominatim:-/nonexistent/x}")"; do
    [ -n "${kept}" ] && same_dir "$1" "${kept}" && return 0
  done
  canonical=$(realpath -e -- "$1")
  mounted_dirs | while read -r source; do
    case "${source}" in "${canonical}" | "${canonical}"/*) echo mounted ;; esac
  done | grep -q mounted
}
remove() {
  if [ "${command}" = plan ]; then
    log "would remove $1 ($(du -sh -- "$1" | cut -f 1))"
  else
    log "removing $1 ($(du -sh -- "$1" | cut -f 1))"
    rm -rf --one-file-system -- "$1"
  fi
}
prune() {
  removed=
  for dir in "${root}"/valhalla-"${label}"-[0-9]* "${root}"/nominatim/"${label}"-[0-9]*; do
    [ -d "${dir}" ] && [ ! -L "${dir}" ] || continue
    keep_dir "${dir}" && continue
    remove "${dir}"
    removed=1
  done
  # Extracts of releases no kept build uses (the live index mounts its own).
  kept_versions=
  for dir in "${root}"/valhalla-"${label}"-[0-9]* "${root}"/nominatim/"${label}"-[0-9]* "${live_pbf}"; do
    [ ! -e "${dir}" ] || kept_versions="${kept_versions} $(version_of "$(basename "${dir}")")"
  done
  [ "${command}" = plan ] || [ -z "${latest_in_progress:-}" ] || kept_versions="${kept_versions} ${latest_in_progress}"
  for file in "${imports}/${label}"-[0-9]* "${imports}/SHA256SUMS-${label}"-[0-9]*; do
    [ -e "${file}" ] || continue
    case " ${kept_versions} " in *" $(version_of "$(basename "${file}")") "*) continue ;; esac
    remove "${file}"
    removed=1
  done
  stage_version=$(cat "${imports}/${label}.stage-version" 2>/dev/null || true)
  if [ -n "${stage_version}" ] && ! ls "${imports}/${label}-${stage_version}.osm.pbf" >/dev/null 2>&1; then
    remove "${imports}/${label}.stage-version"
  fi
  [ -e "${imports}/${label}-current.osm.pbf" ] || [ ! -L "${imports}/${label}-current.osm.pbf" ] ||
    remove "${imports}/${label}-current.osm.pbf"
  # The updater's own `.env` backups: the five newest.
  # shellcheck disable=SC2012 # names this script chose
  for backup in $(ls -1t "${script_dir}"/.env.pre-map-update-* 2>/dev/null | tail -n +6); do remove "${backup}"; done
  if [ -n "${removed}" ] && [ "${command}" != plan ]; then
    # Freed blocks return to the Proxmox pool only once discarded; the journal commits first.
    sync
    sleep 10
    fstrim -v "${root}" || log 'fstrim failed; the pool gets the space back at the weekly fstrim.'
  fi
}

# ---- Probes ----------------------------------------------------------------------------------
search_probes='Halifax Citadel|44.6476|-63.5728
Parliament Hill|45.4236|-75.7009
Stanley Park|49.3043|-123.1443
Château Frontenac|46.8119|-71.2049
The Forks|49.8873|-97.1306'

probe_search() {
  # probe_search BASE_URL DATASET: a place in five provinces from the Nominatim index named DATASET.
  printf '%s\n' "${search_probes}" | while IFS='|' read -r query latitude longitude; do
    answer=$(jq -nc --arg q "${query}" --argjson la "${latitude}" --argjson lo "${longitude}" \
      '{limit: 3, q: $q, latitude: $la, longitude: $lo}' |
      curl --fail --silent --show-error --max-time 30 --header 'content-type: application/json' \
        --data-binary @- "$1/v1/search") || { log "search '${query}' failed at $1"; return 1; }
    printf '%s' "${answer}" | jq -e --arg dataset "$2" --argjson la "${latitude}" --argjson lo "${longitude}" '
      .degraded == false and .source.id == "nominatim-self-hosted" and .source.datasetVersion == $dataset
      and ((.results[0].center.latitude - $la) * 111 | fabs) < 2
      and ((.results[0].center.longitude - $lo) * 70 | fabs) < 2' >/dev/null || {
      log "search '${query}' at $1: $(printf '%s' "${answer}" | jq -c '{source, first: .results[0]}')"
      return 1
    }
    log "search '${query}' at $1: $(printf '%s' "${answer}" | jq -r '.results[0].name') (${2})"
  done
}

probe_route() {
  # probe_route BASE_URL: downtown Calgary to the airport, the check-stack.sh window.
  answer=$(curl --fail --silent --show-error --max-time 30 --header 'content-type: application/json' \
    --data '{"alternatives":0,"origin":{"latitude":51.04427,"longitude":-114.06309},"destination":{"latitude":51.1308592,"longitude":-114.010689},"preferences":{"avoidFerries":false,"avoidHighways":false,"avoidTolls":false,"avoidUnpaved":false}}' \
    "$1/v1/routes") || { log "route at $1 failed"; return 1; }
  log "route downtown Calgary to YYC at $1: $(printf '%s' "${answer}" | jq -c '{source: .source.id, meters: .routes[0].distanceMeters, seconds: .routes[0].durationSeconds}')"
  printf '%s' "${answer}" | jq -e '.degraded == false and .source.id == "valhalla-self-hosted" and .routes[0].distanceMeters > 18000 and .routes[0].distanceMeters < 20500 and .routes[0].durationSeconds > 1050 and .routes[0].durationSeconds < 1300' >/dev/null
}

probe_staged_valhalla() {
  # probe_staged_valhalla DIR: serves DIR on 127.0.0.1:18002 (build-free, as the live service
  # starts it) and checks the Calgary airport window and one matrix corridor per province.
  docker rm -f navoss-valhalla-stage >/dev/null 2>&1 || true
  docker run -d --name navoss-valhalla-stage --label navoss.stage.step=map-update --cpus 2 \
    --cpu-shares 256 --oom-score-adj 500 --memory 4g --memory-swap 4g -p 127.0.0.1:18002:8002 \
    -e build_admins=False -e build_elevation=False -e build_tar=True -e build_time_zones=False \
    -e force_rebuild=False -e server_threads=2 -e tile_urls= -e traffic_name= \
    -e use_default_speeds_config=True -e use_tiles_ignore_pbf=True \
    -e default_speeds_config_url="${speeds_url}" -v "$1:/custom_files" "${valhalla_image}" >/dev/null
  waited=0
  until curl --fail --silent --max-time 5 http://127.0.0.1:18002/status >/dev/null 2>&1; do
    docker inspect --format '{{.State.Running}}' navoss-valhalla-stage 2>/dev/null | grep -q true &&
      [ "${waited}" -lt 1200 ] || { docker logs --tail 20 navoss-valhalla-stage; return 1; }
    sleep 15
    waited=$((waited + 15))
  done
  route() {
    curl --fail --silent --show-error --max-time 60 http://127.0.0.1:18002/route \
      -d "{\"locations\":[{\"lat\":$1,\"lon\":$2},{\"lat\":$3,\"lon\":$4}],\"costing\":\"auto\"}" |
      jq -c '.trip.summary | {km: .length, seconds: .time}'
  }
  airport=$(route 51.04427 -114.06309 51.1308592 -114.010689)
  log "staged graph, downtown Calgary to YYC: ${airport}"
  printf '%s' "${airport}" | jq -e '.km > 18 and .km < 20.5 and .seconds > 1050 and .seconds < 1300' >/dev/null || return 1
  for area in alberta british-columbia ontario quebec manitoba saskatchewan new-brunswick nova-scotia \
    prince-edward-island newfoundland-and-labrador yukon northwest-territories; do
    # As check-coverage.sh picks it: the first corridor of the province that crosses no border.
    corridor=$(jq -c --arg area "${area}" '. as $root
      | [.corridors[] | select((.tags | index($area)) and (.tags | index("inter-provincial") | not))] | first
      | if . == null then null else {id, range: .distanceRangeKm,
          o: $root.anchors[.originAnchorId].coordinate, d: $root.anchors[.destinationAnchorId].coordinate} end' "${matrix}")
    [ "${corridor}" != null ] || { log "no ${area} corridor in ${matrix}"; return 1; }
    # shellcheck disable=SC2046 # four numbers
    set -- $(printf '%s' "${corridor}" | jq -r '"\(.o.latitude) \(.o.longitude) \(.d.latitude) \(.d.longitude)"')
    summary=$(route "$1" "$2" "$3" "$4") || { log "${area}: no route"; return 1; }
    log "staged graph, ${area} $(printf '%s' "${corridor}" | jq -r .id): ${summary}"
    jq -en --argjson s "${summary}" --argjson c "${corridor}" '$s.km >= $c.range[0] and $s.km <= $c.range[1]' >/dev/null ||
      { log "${area}: outside $(printf '%s' "${corridor}" | jq -c .range) km"; return 1; }
  done
  docker rm -f navoss-valhalla-stage >/dev/null
}

check_live() {
  # The stack's own gate with the live traffic and offline settings, then the public endpoint.
  (
    cd "${script_dir}"
    COMMUNITY_TRAFFIC_MODE=$(env_value COMMUNITY_TRAFFIC_MODE) \
      NAVOSS_OFFLINE_MANIFEST_DIR=$(env_value NAVOSS_OFFLINE_MANIFEST_DIR) \
      NAVOSS_BASE_URL=${local_url} ./check-stack.sh
  ) || return 1
  probe_route "${public_url}" && probe_search "${public_url}" "$(env_value NOMINATIM_DATASET_VERSION)"
}

# ---- Swap and rollback -----------------------------------------------------------------------
set_env() {
  # set_env FILE KEY VALUE
  sed -i "s|^$2=.*|$2=$3|" "$1"
  grep -qxF "$2=$3" "$1"
}
recreate() {
  # shellcheck disable=SC2086 # service names
  (cd "${script_dir}" && docker compose config --quiet &&
    docker compose up -d --no-build --wait --wait-timeout 1800 $1)
}
rollback_swap() {
  cp -p "${swap_backup}" "${env_file}"
  if recreate "${swap_services}" && check_live; then
    log "Rolled back to ${swap_backup}; the live stack passes its checks."
    swap_backup=
    return 0
  fi
  swap_backup=
  result=rollback-failed
  reason="rollback to the saved .env did not pass check-stack.sh; restore by hand (docs/operations/proxmox-vm.md)"
  return 1
}
swap() {
  # swap SERVICES KEY=VALUE...: the new `.env`, the services recreated, the stack verified.
  swap_services=$1
  shift
  backup=${script_dir}/.env.pre-map-update-$(date -u +%Y%m%dT%H%M%SZ)
  cp -p "${env_file}" "${backup}"
  next=$(mktemp "${env_file}.XXXXXX")
  cp -p "${env_file}" "${next}"
  for pair do set_env "${next}" "${pair%%=*}" "${pair#*=}"; done
  swap_backup=${backup}
  mv -f "${next}" "${env_file}"
  log "Swapping ${swap_services}: $*"
  if recreate "${swap_services}" &&
    { case " ${swap_services} " in *" nominatim "*) (cd "${script_dir}" && ./refresh-nominatim-special-phrases.sh) ;; esac; } &&
    check_live; then
    swap_backup=
    log 'The live stack passes check-stack.sh and the public probes.'
    return 0
  fi
  log 'The live stack failed its checks on the new data; rolling back.'
  rollback_swap || exit 2
  return 1
}

if [ "${command}" = rollback ]; then
  kind=$2
  case "${kind}" in
    valhalla)
      [ -n "${previous_valhalla}" ] || { reason='no previous graph is recorded'; exit 1; }
      swap 'valhalla api' "VALHALLA_DATA_DIR=${previous_valhalla}" || { reason='rollback did not pass checks; restored'; exit 1; }
      printf '%s\n' "${live_valhalla}" >"${state_dir}/previous-valhalla"
      ;;
    nominatim)
      [ -n "${previous_nominatim}" ] || { reason='no previous index is recorded'; exit 1; }
      v=$(version_of "${previous_nominatim}")
      swap 'nominatim api' "NOMINATIM_DATA_DIR=${previous_nominatim}" \
        "NOMINATIM_PBF_PATH=${imports}/${label}-${v}.osm.pbf" \
        "NOMINATIM_DATASET_VERSION=${label}-geofabrik-20${v%????}-$(printf '%s' "${v}" | cut -c3-4)-$(printf '%s' "${v}" | cut -c5-6)" ||
        { reason='rollback did not pass checks; restored'; exit 1; }
      printf '%s\n' "${live_nominatim}" >"${state_dir}/previous-nominatim"
      ;;
  esac
  result=rolled-back
  reason="${kind} rolled back by hand"
  exit 0
fi

# ---- What is due -----------------------------------------------------------------------------
log "Live: graph ${live_valhalla} (release ${live_valhalla_version}), index ${live_nominatim} (${live_dataset})."
log "Rollback: graph ${previous_valhalla:-none}, index ${previous_nominatim:-none}."
prune
effective=$(curl --fail --silent --show-error --location --head --max-time 60 --output /dev/null \
  --write-out '%{url_effective}' "${latest_url}") || { reason="cannot reach ${latest_url}"; exit 1; }
latest=$(basename "${effective}" | sed -n 's/^canada-\([0-9]\{6\}\)\.osm\.pbf$/\1/p')
[ -n "${latest}" ] || { reason="${latest_url} did not resolve to a dated release (${effective})"; exit 1; }
curl --fail --silent --location --max-time 60 "$(dirname "${effective}")/canada-${latest}.osm.pbf.md5" | grep -Eq '^[0-9a-f]{32} ' ||
  { reason="Geofabrik has no checksum for ${latest} yet"; result=up-to-date; exit 0; }
log "Geofabrik Canada: ${latest}."

valhalla_due=
[ "${latest}" -le "${live_valhalla_version}" ] || valhalla_due=1
nominatim_due=
nominatim_age=$(days_between "${live_nominatim_version}" "${latest}")
# The index is rebuilt with a graph of the same release (the staged API serves both), so only when
# a graph is due too.
[ -z "${valhalla_due}" ] || [ "${nominatim_age}" -lt "${nominatim_max_age_days}" ] || nominatim_due=1
if [ -z "${valhalla_due}" ]; then
  result=up-to-date
  reason="the live graph is release ${live_valhalla_version}, the newest is ${latest}"
  exit 0
fi
log "Due: graph ${live_valhalla_version} -> ${latest}; index ${nominatim_due:+${live_nominatim_version} -> ${latest}}${nominatim_due:-not due (${nominatim_age} of ${nominatim_max_age_days} days)}."

# ---- Gates: storage and memory -----------------------------------------------------------------
# Peaks from the live artifacts: the extract twice (download and routing filter) and three times
# the graph (tile tree, archive and slack), then two and a half times the index (the measured
# 2026-11-15 import peaked about 45 GB for an 18 GB index).
bytes() { du -sb --exclude='*.osm.pbf' -- "$1" | cut -f 1; }
pbf_bytes=$(stat -L -c %s -- "${live_pbf}")
valhalla_peak=$((2 * pbf_bytes + 3 * $(bytes "${live_valhalla}")))
nominatim_peak=$(($(bytes "$(dirname "${live_nominatim}")") * 5 / 2))
pool=$(${pve_api} GET "${pool_path}") || { result=refused; reason="cannot read ${pool_path}; refusing"; exit 75; }
pool_used=$(printf '%s' "${pool}" | jq -er '.data.used')
pool_total=$(printf '%s' "${pool}" | jq -er '.data.total')
disk_free=$(df -B1 --output=avail "${root}" | tail -n 1 | tr -d ' ')
memory_available=$(awk '/^MemAvailable:/ { printf "%d\n", $2 * 1024 }' "${MAP_UPDATE_MEMINFO:-/proc/meminfo}")
gb() { awk -v b="$1" 'BEGIN { printf "%.1f GB", b / 1e9 }'; }
pct() { awk -v u="$1" -v t="${pool_total}" 'BEGIN { printf "%.2f %%", u * 100 / t }'; }
gate() {
  # gate NAME PEAK_BYTES BUILD_MEMORY_GIB: refusal reason on stdout, nothing when it fits.
  projected=$((pool_used + $2))
  if [ $((projected * 100)) -gt $((pool_total * pool_max_pct)) ]; then
    echo "nvme-fast would reach $(pct "${projected}") ($(pct "${pool_used}") now + $(gb "$2") $1 peak); limit ${pool_max_pct} %"
  elif [ "${disk_free}" -lt $(($2 + disk_margin_gb * 1000000000)) ]; then
    echo "${root} has $(gb "${disk_free}") free; $1 needs $(gb "$2") + ${disk_margin_gb} GB"
  elif [ "${memory_available}" -lt $((($3 + memory_floor_gib) * 1073741824)) ]; then
    echo "$(gb "${memory_available}") memory available; $1 needs $3 GiB + ${memory_floor_gib} GiB floor"
  fi
}
log "nvme-fast $(pct "${pool_used}") used; ${root} $(gb "${disk_free}") free; $(gb "${memory_available}") memory available."
log "Estimated peaks: graph $(gb "${valhalla_peak}"), index $(gb "${nominatim_peak}") more."
valhalla_refusal=$(gate graph "${valhalla_peak}" 8)
if [ -n "${valhalla_refusal}" ]; then
  result=refused
  reason="storage gate: ${valhalla_refusal}"
  if [ "${command}" = run ]; then
    log "Refused: ${valhalla_refusal}. Nothing was started."
    exit 75
  fi
  log "A run now would be refused: ${valhalla_refusal}."
fi
if [ -n "${nominatim_due}" ]; then
  # Import 10 GiB, then the staged API's 10.75 GiB.
  nominatim_refusal=$(gate 'graph and index' $((valhalla_peak + nominatim_peak)) 11)
  if [ -n "${nominatim_refusal}" ]; then
    log "Index deferred: ${nominatim_refusal}."
    nominatim_due=
  fi
fi

if [ "${command}" = plan ]; then
  services='valhalla api'
  [ -z "${nominatim_due}" ] || services='valhalla nominatim api'
  log "Plan for ${label}-${latest}${valhalla_refusal:+ (once the gate passes)}:"
  log "  1. stage-coverage.sh inputs ${label}: download, MD5, osmium check, routing filter"
  log "  2. stage-coverage.sh valhalla ${label}: both passes, admin repair, Calgary/Ontario speed profile -> ${root}/valhalla-${label}-${latest}"
  log "  3. staged graph on 127.0.0.1:18002: Calgary airport window and one corridor per province"
  [ -z "${nominatim_due}" ] ||
    log "  4. stage-coverage.sh nominatim, serve, verify ${label}; search probes on the staged API"
  log "  5. swap ${services} in .env (backup .env.pre-map-update-*), check-stack.sh, public probes; roll back on failure"
  log "  6. prune to the live and previous build of each kind, fstrim"
  log 'Checking the live stack now (read-only probes):'
  if check_live; then log 'Live stack passes check-stack.sh and the public probes.'; else log 'Live stack checks FAILED.'; fi
  [ -n "${valhalla_refusal}" ] || { result=planned; reason="would build ${latest}"; }
  exit 0
fi

# ---- Build -------------------------------------------------------------------------------------
latest_in_progress=${latest}
if [ "$(cat "${imports}/${label}.stage-version" 2>/dev/null)" != "${latest}" ]; then
  rm -f "${imports}/${label}.stage-version"
fi
stage inputs || { reason="inputs for ${latest} failed; live unchanged"; latest_in_progress=; prune; exit 1; }
stage valhalla || { reason="graph build for ${latest} failed; live unchanged"; latest_in_progress=; prune; exit 1; }
new_valhalla=${root}/valhalla-${label}-${latest}
log 'Probing the staged graph.'
probe_staged_valhalla "${new_valhalla}" || { reason="the staged graph ${new_valhalla} failed its probes; live unchanged"; latest_in_progress=; prune; exit 1; }

new_dataset="${label}-geofabrik-20${latest%????}-$(printf '%s' "${latest}" | cut -c3-4)-$(printf '%s' "${latest}" | cut -c5-6)"
new_nominatim=${root}/nominatim/${label}-${latest}/postgres
index_ready=
if [ -n "${nominatim_due}" ]; then
  if stage nominatim && stage serve && stage verify &&
    probe_search http://127.0.0.1:18300 "${new_dataset}"; then
    index_ready=1
  else
    log "The staged index ${new_nominatim} failed; only the graph is swapped."
  fi
  stage stop || true
fi

# ---- Swap ------------------------------------------------------------------------------------
log 'Checking the live stack before the swap.'
check_live || { reason='the live stack failed its checks before the swap; nothing changed'; latest_in_progress=; prune; exit 1; }
if [ -n "${index_ready}" ]; then
  swap 'valhalla nominatim api' "VALHALLA_DATA_DIR=${new_valhalla}" "NOMINATIM_DATA_DIR=${new_nominatim}" \
    "NOMINATIM_PBF_PATH=${imports}/${label}-${latest}.osm.pbf" "NOMINATIM_DATASET_VERSION=${new_dataset}" ||
    { reason="graph and index ${latest} failed live checks; rolled back"; result=rolled-back; latest_in_progress=; prune; exit 1; }
  printf '%s\n' "${live_valhalla}" >"${state_dir}/previous-valhalla"
  printf '%s\n' "${live_nominatim}" >"${state_dir}/previous-nominatim"
  previous_nominatim=${live_nominatim}
  live_nominatim=${new_nominatim}
  live_pbf=${imports}/${label}-${latest}.osm.pbf
  reason="graph and index ${latest}"
else
  swap 'valhalla api' "VALHALLA_DATA_DIR=${new_valhalla}" ||
    { reason="graph ${latest} failed live checks; rolled back"; result=rolled-back; latest_in_progress=; prune; exit 1; }
  printf '%s\n' "${live_valhalla}" >"${state_dir}/previous-valhalla"
  reason="graph ${latest}${nominatim_due:+; index import failed, kept ${live_dataset}}"
fi
previous_valhalla=${live_valhalla}
live_valhalla=${new_valhalla}
latest_in_progress=
result=updated
prune
