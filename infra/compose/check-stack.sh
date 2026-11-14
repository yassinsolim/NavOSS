#!/bin/sh

set -eu

base_url="${NAVOSS_BASE_URL:-http://127.0.0.1:8080}"

curl --fail --silent --show-error "$base_url/health" >/dev/null
curl --fail --silent --show-error "$base_url/ready" >/dev/null
curl --fail --silent --show-error "$base_url/v2/config" |
  jq -e '.features.productionSearch == true and .coverage.id == "calgary-kelowna-service-areas" and (.coverage.serviceAreas | map(.id) == ["calgary-ab", "kelowna-bc"])' >/dev/null
curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"limit":3,"q":"Calgary Tower"}' \
  "$base_url/v1/search" |
  jq -e '.degraded == false and .source.id == "calgary-hybrid-search" and .source.freshness == "fresh" and (.results | length) > 0' >/dev/null
curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"limit":3,"q":"Cosmos Collision"}' \
  "$base_url/v1/search" |
  jq -e '.results[0].id == "calgary-business:40592"' >/dev/null
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
if [ "${COMMUNITY_TRAFFIC_MODE:-off}" = live ] || [ -n "${COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH:-}" ]; then
  # The dead-end mask and the graph Valhalla serves must be the same build: graph.json's id, the
  # configured id, the canonical tile archive's SHA-256 and the mask's graph id all agree.
  graph_dir="${VALHALLA_DATA_DIR:?Set VALHALLA_DATA_DIR to the serving graph directory}"
  graph_id=$(jq -er '.graphId | select(test("^[0-9a-f]{64}$"))' "$graph_dir/graph.json")
  [ "$graph_id" = "${COMMUNITY_TRAFFIC_GRAPH_ID:-}" ]
  [ "${COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH:-}" = /graph/dead-end-mask.json ]
  [ "$(sha256sum "$graph_dir/connected.tar" | cut -d ' ' -f 1)" = "$graph_id" ]
  jq -e --arg id "$graph_id" '.format == "navoss-traffic-dead-end-mask" and .formatVersion == 1 and .graph.graphId == $id and .rules.terminalMeters >= 400' \
    "$graph_dir/dead-end-mask.json" >/dev/null
fi
if [ "${COMMUNITY_TRAFFIC_MODE:-off}" = live ]; then
  curl --fail --silent --show-error "$base_url/v2/traffic/flow?bbox=-114.20,50.95,-113.90,51.15" |
    jq -e '.type == "FeatureCollection" and .source.id == "navoss-community" and .coverage.minimumContributors >= 3' >/dev/null
  curl --fail --silent --show-error "$base_url/v2/config" | jq -e '.features.liveTraffic == true' >/dev/null
fi

printf 'NavOSS stack checks passed against %s\n' "$base_url"
