#!/bin/sh
# Entrypoint of the verified serving graph (compose.traffic-graph.yaml), mounted read-only at
# /navoss/serve-verified-graph.sh in the Valhalla 3.8.2 container. It serves /graph/connected.tar
# only after checking that graph.json is the configured graph, the archive hashes to it, and the
# configuration and provenance name only that archive. verify-traffic-graph.sh checks that the
# running container's entrypoint is exactly this script and nothing else.
set -eu
cd /graph
id=$(jq -er '.graphId | select(test("^[0-9a-f]{64}$"))' graph.json)
[ "$id" = "${NAVOSS_GRAPH_ID:-}" ] || {
  echo 'graph.json is not the configured graph' >&2
  exit 1
}
jq -e '.mjolnir.tile_extract == "/graph/connected.tar" and .mjolnir.tile_dir == "/nonexistent" and ((.mjolnir.tile_url // "") == "") and ((.mjolnir.traffic_extract // "") == "")' \
  valhalla-serving.json >/dev/null || {
  echo 'valhalla-serving.json has a tile source other than /graph/connected.tar' >&2
  exit 1
}
[ ! -e /nonexistent ]
config=$(sha256sum valhalla-serving.json | cut -d ' ' -f 1)
jq -e --arg id "$id" --arg config "$config" \
  '.graphId == $id and .servingConfigSha256 == $config and .routingEngineVersion == "3.8.2"' \
  provenance.json >/dev/null || {
  echo 'provenance.json does not describe this graph and configuration' >&2
  exit 1
}
[ "$(sha256sum connected.tar | cut -d ' ' -f 1)" = "$id" ] || {
  echo "connected.tar is not graph $id" >&2
  exit 1
}
exec valhalla_service /graph/valhalla-serving.json 2
