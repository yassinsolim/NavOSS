#!/bin/sh

set -eu

base_url="${NAVOSS_BASE_URL:-http://127.0.0.1:8080}"

curl --fail --silent --show-error "$base_url/health" >/dev/null
curl --fail --silent --show-error "$base_url/ready" >/dev/null
curl --fail --silent --show-error "$base_url/v2/config" |
  jq -e '.features.productionSearch == true' >/dev/null
# Strict v1 for shipped clients, exactly the declared provinces in /v2/config, per-province data
# readiness and one public route in each (NAVOSS_SERVICE_AREAS from .env; default Alberta+BC).
NAVOSS_BASE_URL="$base_url" "$(dirname "$0")/check-coverage.sh"
curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"limit":3,"q":"Calgary Tower"}' \
  "$base_url/v1/search" |
  jq -e '.degraded == false and .source.id == "calgary-hybrid-search" and .source.freshness == "fresh" and (.results | length) > 0' >/dev/null
curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"limit":8,"q":"Tim Hortons"}' \
  "$base_url/v1/search" |
  jq -e 'any(.results[]; .id | startswith("calgary-business:"))' >/dev/null
curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"limit":3,"q":"800 Macleod Trail Southeast"}' \
  "$base_url/v1/search" |
  jq -e '.results[0].name == "800 Macleod Trail SE" and (.results[0].center.latitude - 51.04539715854496 | fabs) < 0.000001 and (.results[0].center.longitude - -114.05792721246195 | fabs) < 0.000001' >/dev/null
curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"alternatives":0,"origin":{"latitude":51.04427,"longitude":-114.06309},"destination":{"latitude":51.1308592,"longitude":-114.010689},"preferences":{"avoidFerries":false,"avoidHighways":false,"avoidTolls":false,"avoidUnpaved":false}}' \
  "$base_url/v1/routes" |
  jq -e '.degraded == false and .source.id == "valhalla-self-hosted" and .source.mode == "production" and (.routes | length) > 0 and .routes[0].distanceMeters > 18000 and .routes[0].distanceMeters < 20500 and .routes[0].durationSeconds > 1150 and .routes[0].durationSeconds < 1300' >/dev/null
curl --fail --silent --show-error "$base_url/v2/traffic/status" |
  jq -e --arg mode "${COMMUNITY_TRAFFIC_MODE:-off}" '(.mode == (if $mode == "collect" then "collecting" else $mode end)) and (.probes.accepting == (.mode != "off")) and (.publication.minimumContributors >= 3) and (.probes.tripEndTrimMeters >= 400) and (has("coverage") | not)' >/dev/null
if [ "${COMMUNITY_TRAFFIC_MODE:-off}" = live ] || { [ "${COMMUNITY_TRAFFIC_MODE:-off}" != off ] && [ -n "${COMMUNITY_TRAFFIC_GRAPH_ID:-}" ]; }; then
  # The verified serving graph, its mask and the running containers' mounts (compose.traffic-graph.yaml).
  "$(dirname "$0")/verify-traffic-graph.sh"
fi
if [ "${COMMUNITY_TRAFFIC_MODE:-off}" = live ]; then
  curl --fail --silent --show-error "$base_url/v2/traffic/flow?bbox=-114.20,50.95,-113.90,51.15" |
    jq -e '.type == "FeatureCollection" and .source.id == "navoss-community" and .coverage.minimumContributors >= 3' >/dev/null
  curl --fail --silent --show-error "$base_url/v2/config" | jq -e '.features.liveTraffic == true' >/dev/null
fi

offline_manifest="${NAVOSS_OFFLINE_MANIFEST_DIR:+$NAVOSS_OFFLINE_MANIFEST_DIR/manifest.json}"
offline_status=$(curl --silent --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' "$base_url/v1/offline/manifest")
if [ -n "$offline_manifest" ] && [ ! -e "$offline_manifest" ]; then
  # Withdrawn (by the offline guard, or by hand): the API must have gone back to a quiet 503.
  test "$offline_status" = 503
  printf 'Offline manifest withdrawn: %s is missing (see infra/offline/README.md, "Automatic stop")\n' "$offline_manifest" >&2
  exit 1
elif [ -n "$offline_manifest" ]; then
  # Hosting is only offered while the offline guard runs: its timer must be active and its last
  # run (exit 0, or 2 while usage is being established) must have ended in the last 15 minutes.
  guard=navoss-offline-guard
  if ! systemctl is-active --quiet "$guard.timer"; then
    printf 'Offline guard timer %s.timer is not active\n' "$guard" >&2
    exit 1
  fi
  # systemd clears ExecMainExitTimestamp while a oneshot is starting. Wait for that run,
  # bounded by the service's 180-second TimeoutStartSec, then check its actual result.
  guard_wait=0
  while [ "$(systemctl show -p ActiveState --value "$guard.service")" = activating ]; do
    if [ "$guard_wait" -ge 184 ]; then
      printf 'Offline guard did not finish within 184 seconds\n' >&2
      exit 1
    fi
    sleep 2
    guard_wait=$((guard_wait + 2))
  done
  guard_result=$(systemctl show -p Result --value "$guard.service")
  guard_exited=$(systemctl show -p ExecMainExitTimestamp --value "$guard.service")
  if [ "$guard_result" != success ] || [ -z "$guard_exited" ] ||
    [ $(($(date +%s) - $(date -d "$guard_exited" +%s))) -gt 900 ]; then
    printf 'Offline guard last run: result %s, ended %s\n' "$guard_result" "${guard_exited:-never}" >&2
    exit 1
  fi
  if [ ! -e "$offline_manifest" ]; then
    printf 'Offline manifest was withdrawn while the guard ran\n' >&2
    exit 1
  fi
  # The host manifest is served unchanged, and each artifact it names reports its exact length.
  expected_version=$(jq -er '.bundleVersion' "$offline_manifest")
  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$base_url/v1/offline/manifest" |
    jq -e --arg version "$expected_version" '.bundleVersion == $version and (.regions | length) > 0' >/dev/null
  jq -r '[.regions[].artifacts[] | "\(.url) \(.byteSize)"] | unique[]' "$offline_manifest" |
    while read -r artifact_url artifact_size; do
      # A one-byte ranged GET, not HEAD: Cloudflare answers GETs from cache, but every HEAD reaches R2.
      served_size=$(curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
        --range 0-0 --output /dev/null --dump-header - \
        --header 'accept-encoding: identity' "$artifact_url" |
        tr -d '\r' | awk 'tolower($1) == "content-range:" { split($3, total, "/"); print total[2] }')
      if [ "$served_size" != "$artifact_size" ]; then
        printf 'Offline artifact %s: expected %s bytes, served %s\n' "$artifact_url" "$artifact_size" "${served_size:-nothing}" >&2
        exit 1
      fi
    done
else
  # Unconfigured stays a quiet "not available", never an error page or a stale manifest.
  test "$offline_status" = 503
fi

printf 'NavOSS stack checks passed against %s\n' "$base_url"
