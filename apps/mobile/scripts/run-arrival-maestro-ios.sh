#!/bin/sh

set -eu

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_CLI_NO_ANALYTICS=1
export PATH="$PATH:$HOME/.maestro/bin"

simulator_name="${NAVOSS_SIMULATOR_NAME:-NavOSS iPhone 15 Pro Max}"
device_id="$(
  xcrun simctl list devices available |
    awk -F '[()]' -v name="$simulator_name" 'index($0, name) { print $2; exit }'
)"

if [ -z "$device_id" ]; then
  printf 'Simulator not found: %s\n' "$simulator_name" >&2
  exit 1
fi

log_directory="$(mktemp -d "${TMPDIR:-/tmp}/navoss-arrival.XXXXXX")"

cleanup() {
  xcrun simctl location "$device_id" clear >/dev/null 2>&1 || true
  rm -rf "$log_directory"
}

trap cleanup EXIT HUP INT TERM

curl --fail --silent --output /dev/null http://127.0.0.1:3001/health
curl --fail --silent --output /dev/null http://127.0.0.1:8081/status

xcrun simctl install \
  "$device_id" \
  ./ios/build/Build/Products/Debug-iphonesimulator/NavOSS.app

sh ./scripts/run-maestro-ios.sh ../../.maestro/start-airport-simulation.yaml

NAVOSS_SIMULATION_SPEED_MPS=8 \
  NAVOSS_SIMULATION_INTERVAL_SECONDS=0.5 \
  NAVOSS_SIMULATION_TAIL_METERS=180 \
  node ./scripts/replay-route-ios.mjs

xcrun simctl spawn "$device_id" log stream \
  --timeout 40 \
  --style compact \
  --predicate 'process == "NavOSS"' \
  >"$log_directory/navigation.log"

maestro --device "$device_id" test ../../.maestro/assert-arrival-complete.yaml