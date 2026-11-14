#!/bin/sh
# Pre-enable gate for community traffic (infra/offline/dead-end-mask.md, "Install"). Run by the
# operator, with the operator's existing Docker access, from infra/compose with the stack's .env
# exported, after `docker compose -f compose.yaml -f compose.traffic-graph.yaml up -d` and before
# COMMUNITY_TRAFFIC_MODE=live. It proves that the running Valhalla serves the verified graph
# directory through exactly the verifying entrypoint, and that the API reads the same directory
# and sends its traces to that Valhalla: their effective mounts, entrypoint, command, image,
# environment, networks and start times, and the hashes of the files Valhalla's configuration
# names. The API never gets the Docker socket for this. Needs docker, jq, perl and sha256sum (or
# shasum).
set -eu

fail() {
  echo "verify-traffic-graph: $1" >&2
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}

here=$(cd "$(dirname "$0")" && pwd -P)
graph_dir=$(cd "${VALHALLA_DATA_DIR:?Set VALHALLA_DATA_DIR to the serving graph directory}" && pwd -P)
graph_id=${COMMUNITY_TRAFFIC_GRAPH_ID:?Set COMMUNITY_TRAFFIC_GRAPH_ID}
entry_script="$here/valhalla-serve-verified.sh"
engine_image=ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:3d7a08f7e78b356ee873b61711b743ad81bcc114b0ca5731217da8bba6ba39d1
# The API's matcher endpoint must be the inspected Valhalla, as the base profile configures it.
trace_url=http://valhalla:8002/trace_attributes
compose=${NAVOSS_COMPOSE:-docker compose -f compose.yaml -f compose.traffic-graph.yaml}

# 1. The directory: archive, configuration, provenance and mask agree.
[ "$(jq -er '.graphId' "$graph_dir/graph.json")" = "$graph_id" ] || fail 'graph.json is not COMMUNITY_TRAFFIC_GRAPH_ID'
jq -e '.routingEngineVersion == "3.8.2"' "$graph_dir/graph.json" >/dev/null || fail 'graph.json is not a 3.8.2 graph'
jq -e '.mjolnir.tile_extract == "/graph/connected.tar" and .mjolnir.tile_dir == "/nonexistent" and ((.mjolnir.tile_url // "") == "") and ((.mjolnir.traffic_extract // "") == "")' \
  "$graph_dir/valhalla-serving.json" >/dev/null || fail 'valhalla-serving.json has another tile source'
[ "$(sha256 "$graph_dir/connected.tar")" = "$graph_id" ] || fail 'connected.tar is not the configured graph'
config_sha=$(sha256 "$graph_dir/valhalla-serving.json")
provenance_sha=$(sha256 "$graph_dir/provenance.json")
jq -e --arg id "$graph_id" --arg config "$config_sha" \
  '. as $p | .format == "navoss-serving-graph-provenance" and .formatVersion == 1 and .graphId == $id and .servingConfigSha256 == $config and .routingEngineVersion == "3.8.2" and (.input.sha256sums | split("\n") | any(. == "\($p.input.pbfSha256)  \($p.input.pbf)"))' \
  "$graph_dir/provenance.json" >/dev/null || fail 'provenance.json does not describe this graph, configuration and extract'
pbf_sha=$(jq -er '.input.pbfSha256' "$graph_dir/provenance.json")
jq -e --arg id "$graph_id" --arg provenance "$provenance_sha" --arg pbf "$pbf_sha" \
  '.format == "navoss-traffic-dead-end-mask" and .formatVersion == 2 and .inputs.extractPolicyVersion == 3 and .graph.routingEngineVersion == "3.8.2" and .graph.graphId == $id and .graph.provenanceSha256 == $provenance and .inputs.pbfSha256 == $pbf and .rules.terminalMeters >= 400' \
  "$graph_dir/dead-end-mask.json" >/dev/null || fail 'dead-end-mask.json is not the mask of this graph build'

# 2. The running containers.
newest=$(perl -e 'my $m = 0; for (@ARGV) { my $t = (stat $_)[9]; $m = $t if $t > $m } print $m' \
  "$graph_dir" "$graph_dir"/* "$entry_script")
valhalla=$($compose ps -q valhalla)
api=$($compose ps -q api)
[ -n "$valhalla" ] || fail 'valhalla is not running'
[ -n "$api" ] || fail 'api is not running'
valhalla_json=$(docker inspect "$valhalla")
api_json=$(docker inspect "$api")

started_after_change() {
  printf '%s' "$1" | jq -e --argjson newest "$newest" \
    '.[0].State.StartedAt | sub("\\.[0-9]+"; "") | fromdateiso8601 > $newest' >/dev/null
}
started_after_change "$valhalla_json" || fail 'valhalla started before the graph directory last changed; recreate it'
started_after_change "$api_json" || fail 'api started before the graph directory last changed; recreate it'

# Valhalla: the pinned image, exactly the verifying entrypoint with no command or extra
# arguments, exactly the graph directory and that entrypoint mounted read-only, healthy.
printf '%s' "$valhalla_json" | jq -e --arg image "$engine_image" --arg id "$graph_id" \
  --arg graph "$graph_dir" --arg script "$entry_script" '
  .[0]
  | .Config.Image == $image
    and .Config.Entrypoint == ["/bin/sh", "/navoss/serve-verified-graph.sh"]
    and (.Config.Cmd == null or .Config.Cmd == [])
    and .Path == "/bin/sh"
    and .Args == ["/navoss/serve-verified-graph.sh"]
    and ([.Mounts[] | {Destination, RW, Source}] | sort_by(.Destination)) == [
      {Destination: "/graph", RW: false, Source: $graph},
      {Destination: "/navoss/serve-verified-graph.sh", RW: false, Source: $script}
    ]
    and .HostConfig.ReadonlyRootfs == true
    and (.Config.Env | index("NAVOSS_GRAPH_ID=" + $id) != null)
    and .State.Running == true
    and .State.Health.Status == "healthy"' >/dev/null ||
  fail 'valhalla is not the verifying valhalla_service entrypoint serving only the verified graph directory'

# The API: only the graph directory, read-only, and that directory and id configured.
printf '%s' "$api_json" | jq -e --arg id "$graph_id" --arg graph "$graph_dir" '
  .[0]
  | ([.Mounts[] | {Destination, RW, Source}]) == [{Destination: "/graph", RW: false, Source: $graph}]
    and .HostConfig.ReadonlyRootfs == true
    and .State.Running == true
    and (.Config.Env | index("COMMUNITY_TRAFFIC_GRAPH_DIR=/graph") != null)
    and (.Config.Env | index("COMMUNITY_TRAFFIC_GRAPH_ID=" + $id) != null)' >/dev/null ||
  fail 'the API does not read only the verified graph directory and id'

# The API's matcher endpoint, selected as the traffic service selects it: VALHALLA_TRACE_URL when
# set (even empty), otherwise `trace_attributes` resolved against VALHALLA_URL.
selected=$(printf '%s' "$api_json" | jq -r '
  def value($name): [.[0].Config.Env[] | select(startswith($name + "=")) | .[($name | length) + 1:]] | last;
  if value("VALHALLA_TRACE_URL") != null then value("VALHALLA_TRACE_URL")
  elif value("VALHALLA_URL") != null then
    (value("VALHALLA_URL") | sub("[?#].*$"; "")
      | if test("^[A-Za-z][A-Za-z0-9+.-]*://[^/]*$") then . + "/trace_attributes"
        else sub("[^/]*$"; "trace_attributes") end)
  else "" end')
[ "$selected" = "$trace_url" ] || fail "the API matches traces at $selected, not $trace_url"

# `valhalla` must resolve, from the API, to the inspected container only: that container answers
# to `valhalla` on at least one network the API joins, and no other container answers to it on
# any network the API joins (shared with Valhalla or not). Docker's DNS matches names without
# regard to ASCII case, so container names, aliases and DNS names are compared case-folded. A
# network or member that cannot be inspected fails the check.
valhalla_id=$(printf '%s' "$valhalla_json" | jq -er '.[0].Id') || fail 'valhalla has no container id'
api_networks=$(printf '%s' "$api_json" | jq -er '.[0].NetworkSettings.Networks | keys[]') ||
  fail 'the API joins no network'
reachable=
for network in $api_networks; do
  network_json=$(docker network inspect "$network") || fail "network $network cannot be inspected"
  members=$(printf '%s' "$network_json" | jq -er '.[0].Containers | keys[]') ||
    fail "network $network lists no containers"
  for member in $members; do
    member_json=$(docker inspect "$member") || fail "container $member on $network cannot be inspected"
    printf '%s' "$member_json" | jq -e --arg n "$network" '.[0]
      | [(.Name // "" | ltrimstr("/")),
         (.NetworkSettings.Networks[$n].Aliases // [])[],
         (.NetworkSettings.Networks[$n].DNSNames // [])[]]
      | any(.[]; tostring | ascii_downcase == "valhalla")' >/dev/null || continue
    [ "$member" = "$valhalla_id" ] || fail "another container also answers to valhalla on $network"
    reachable=yes
  done
done
[ -n "$reachable" ] || fail 'the API shares no network on which the inspected container is valhalla'
echo "verify-traffic-graph: graph $graph_id verified in the running stack"
