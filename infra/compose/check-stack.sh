#!/bin/sh

set -eu

base_url="${NAVOSS_BASE_URL:-http://127.0.0.1:8080}"

curl --fail --silent --show-error "$base_url/health" >/dev/null
curl --fail --silent --show-error "$base_url/ready" >/dev/null
curl --fail --silent --show-error "$base_url/v1/config" |
  jq -e '.features.productionSearch == true and .coverage.id == "calgary-ab"' >/dev/null
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

printf 'NavOSS stack checks passed against %s\n' "$base_url"
