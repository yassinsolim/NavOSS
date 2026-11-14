#!/bin/sh
# Pre-enable gate for community traffic (infra/offline/dead-end-mask.md, "Install"). Run by the
# operator, with the operator's existing Docker access, from infra/compose with the stack's .env
# exported, after `docker compose -f compose.yaml -f compose.traffic-graph.yaml up -d` and before
# COMMUNITY_TRAFFIC_MODE=live. It proves that the running Valhalla and API containers serve and
# read the verified graph directory: their effective mounts, entrypoint, image and environment,
# and the hashes of the files Valhalla's configuration actually names. The API never gets the
# Docker socket for this.
set -eu

fail() {
  echo "verify-traffic-graph: $1" >&2
  exit 1
}

graph_dir=$(realpath "${VALHALLA_DATA_DIR:?Set VALHALLA_DATA_DIR to the serving graph directory}")
graph_id=${COMMUNITY_TRAFFIC_GRAPH_ID:?Set COMMUNITY_TRAFFIC_GRAPH_ID}
engine_image=ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:3d7a08f7e78b356ee873b61711b743ad81bcc114b0ca5731217da8bba6ba39d1
compose=${NAVOSS_COMPOSE:-docker compose -f compose.yaml -f compose.traffic-graph.yaml}

# 1. The directory: archive, configuration, provenance and mask agree.
[ "$(jq -er '.graphId' "$graph_dir/graph.json")" = "$graph_id" ] || fail 'graph.json is not COMMUNITY_TRAFFIC_GRAPH_ID'
jq -e '.routingEngineVersion == "3.8.2"' "$graph_dir/graph.json" >/dev/null || fail 'graph.json is not a 3.8.2 graph'
jq -e '.mjolnir.tile_extract == "/graph/connected.tar" and .mjolnir.tile_dir == "/nonexistent" and ((.mjolnir.tile_url // "") == "") and ((.mjolnir.traffic_extract // "") == "")' \
  "$graph_dir/valhalla-serving.json" >/dev/null || fail 'valhalla-serving.json has another tile source'
[ "$(sha256sum "$graph_dir/connected.tar" | cut -d ' ' -f 1)" = "$graph_id" ] || fail 'connected.tar is not the configured graph'
config_sha=$(sha256sum "$graph_dir/valhalla-serving.json" | cut -d ' ' -f 1)
provenance_sha=$(sha256sum "$graph_dir/provenance.json" | cut -d ' ' -f 1)
jq -e --arg id "$graph_id" --arg config "$config_sha" \
  '. as $p | .format == "navoss-serving-graph-provenance" and .formatVersion == 1 and .graphId == $id and .servingConfigSha256 == $config and .routingEngineVersion == "3.8.2" and (.input.sha256sums | split("\n") | any(. == "\($p.input.pbfSha256)  \($p.input.pbf)"))' \
  "$graph_dir/provenance.json" >/dev/null || fail 'provenance.json does not describe this graph, configuration and extract'
pbf_sha=$(jq -er '.input.pbfSha256' "$graph_dir/provenance.json")
jq -e --arg id "$graph_id" --arg provenance "$provenance_sha" --arg pbf "$pbf_sha" \
  '.format == "navoss-traffic-dead-end-mask" and .formatVersion == 2 and .inputs.extractPolicyVersion == 2 and .graph.routingEngineVersion == "3.8.2" and .graph.graphId == $id and .graph.provenanceSha256 == $provenance and .inputs.pbfSha256 == $pbf and .rules.terminalMeters >= 400' \
  "$graph_dir/dead-end-mask.json" >/dev/null || fail 'dead-end-mask.json is not the mask of this graph build'

# 2. The running containers: exactly this directory, read-only at /graph, nothing else mounted.
newest=$(stat -c %Y "$graph_dir" "$graph_dir"/* | sort -n | tail -n 1)
for service in valhalla api; do
  container=$($compose ps -q "$service")
  [ -n "$container" ] || fail "$service is not running"
  docker inspect "$container" | jq -e --arg source "$graph_dir" \
    '.[0] | (.Mounts | length == 1 and .[0].Destination == "/graph" and .[0].RW == false and .[0].Source == $source) and .HostConfig.ReadonlyRootfs == true and .State.Running == true' \
    >/dev/null || fail "$service does not mount only the verified graph directory read-only at /graph"
  started=$(date -d "$(docker inspect --format '{{.State.StartedAt}}' "$container")" +%s)
  [ "$started" -gt "$newest" ] || fail "$service started before the graph directory last changed; recreate it"
done
valhalla=$($compose ps -q valhalla)
docker inspect "$valhalla" | jq -e --arg image "$engine_image" --arg id "$graph_id" \
  '.[0] | .Config.Image == $image and .Path == "/bin/sh" and (.Args | join(" ") | test("exec valhalla_service /graph/valhalla-serving.json 2")) and (.Config.Env | index("NAVOSS_GRAPH_ID=" + $id) != null) and .State.Health.Status == "healthy"' \
  >/dev/null || fail 'valhalla is not the verified valhalla_service serving /graph/valhalla-serving.json'
api=$($compose ps -q api)
docker inspect "$api" | jq -e --arg id "$graph_id" \
  '.[0].Config.Env | (index("COMMUNITY_TRAFFIC_GRAPH_DIR=/graph") != null) and (index("COMMUNITY_TRAFFIC_GRAPH_ID=" + $id) != null)' \
  >/dev/null || fail 'the API is not configured with the verified graph directory and id'
echo "verify-traffic-graph: graph $graph_id verified in the running stack"
