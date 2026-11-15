#!/bin/sh
# Checks that a NavOSS API serves exactly the provinces it is told to declare, from data that holds
# them. Used by check-stack.sh (live) and against a staged API before a cutover:
#
#   NAVOSS_BASE_URL=http://127.0.0.1:18300 NAVOSS_SERVICE_AREAS=alberta,british-columbia,ontario \
#     ./check-coverage.sh
#
# Every request uses committed public anchors (route-quality-canada.json), never private trips.
set -eu

base_url="${NAVOSS_BASE_URL:-http://127.0.0.1:8080}"
env_file="$(dirname "$0")/.env"
if [ -z "${NAVOSS_SERVICE_AREAS:-}" ] && [ -r "${env_file}" ]; then
  NAVOSS_SERVICE_AREAS=$(sed -n 's/^NAVOSS_SERVICE_AREAS=//p' "${env_file}" | tail -n 1)
fi
areas="${NAVOSS_SERVICE_AREAS:-alberta,british-columbia}"
matrix="${ROUTE_QUALITY_CANADA:-$(dirname "$0")/../../apps/api/scripts/route-quality-canada.json}"

fail() {
  echo "check-coverage: $*" >&2
  exit 1
}

expected=$(printf '%s' "${areas}" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sort | jq -R . | jq -cs .)

# Shipped v1 clients keep the strict Calgary configuration whatever is declared.
curl --fail --silent --show-error "${base_url}/v1/config" |
  jq -e '.apiVersion == "v1" and .coverage.id == "calgary-ab" and .coverage.displayName == "Calgary, Alberta" and .endpoints.routes == "/v1/routes" and (.coverage | has("serviceAreas") | not)' >/dev/null ||
  fail '/v1/config is not the strict v1 Calgary configuration'
curl --fail --silent --show-error "${base_url}/v2/config" |
  jq -e --argjson expected "${expected}" '([.coverage.serviceAreas[].id] | sort) == $expected and all(.coverage.serviceAreas[]; .boundary.type == "MultiPolygon") and .endpoints.routes == "/v2/routes"' >/dev/null ||
  fail "/v2/config does not declare exactly ${areas}"
ready=$(curl --silent --show-error "${base_url}/ready")
printf '%s' "${ready}" | jq -e '.status == "ready" and ((.checks.coverage.status // "ready") == "ready")' >/dev/null ||
  fail "/ready: $(printf '%s' "${ready}" | jq -c '.checks.coverage // .status')"

# One route per declared province: the first matrix corridor tagged with it and with no other
# province, else one wholly inside the declaration. Lanes are required where the matrix requires them.
for area in $(printf '%s' "${areas}" | tr ',' ' '); do
  corridor=$(jq -c --arg area "${area}" --argjson declared "${expected}" '
    def provinces: ["alberta", "british-columbia", "ontario", "quebec", "manitoba", "saskatchewan",
      "new-brunswick", "nova-scotia", "prince-edward-island", "newfoundland-and-labrador", "yukon",
      "northwest-territories", "nunavut"];
    [.corridors[] | select(.tags | index($area))] as $tagged
    | [$tagged[] | select(.tags | index("inter-provincial") | not)]
      + [$tagged[] | select(([.tags[] | select(. as $tag | provinces | index($tag))] - $declared) == [])]
    | first // empty' "${matrix}")
  if [ -z "${corridor}" ]; then
    # Nunavut has no road between communities; the readiness probe above already covers its data.
    continue
  fi
  request=$(jq -c --argjson corridor "${corridor}" '
    {alternatives: 0, origin: .anchors[$corridor.originAnchorId].coordinate,
     destination: .anchors[$corridor.destinationAnchorId].coordinate,
     preferences: {avoidFerries: false, avoidHighways: false, avoidTolls: false, avoidUnpaved: false}}' "${matrix}")
  printf '%s' "${request}" |
    curl --fail --silent --show-error --max-time 30 --header 'content-type: application/json' \
      --data-binary @- "${base_url}/v2/routes" |
    jq -e --argjson corridor "${corridor}" '
      .degraded == false and .source.id == "valhalla-self-hosted"
      and (.routes[0].distanceMeters / 1000) >= $corridor.distanceRangeKm[0]
      and (.routes[0].distanceMeters / 1000) <= $corridor.distanceRangeKm[1]
      and ([.routes[0].steps[] | select((.lanes // []) | length > 0)] | length) >= ($corridor.minimumLaneManeuvers // 0)' >/dev/null ||
    fail "${area}: route $(printf '%s' "${corridor}" | jq -r .id) failed"
done

printf 'Coverage checks passed for %s against %s\n' "${areas}" "${base_url}"
