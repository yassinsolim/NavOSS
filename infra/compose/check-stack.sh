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
  jq -e '.degraded == false and (.results | length) > 0' >/dev/null

printf 'NavOSS stack checks passed against %s\n' "$base_url"