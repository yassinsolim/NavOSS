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

log_directory="$(mktemp -d "${TMPDIR:-/tmp}/navoss-reroute.XXXXXX")"

cleanup() {
  xcrun simctl location "$device_id" clear >/dev/null 2>&1 || true
  rm -rf "$log_directory"
}

trap cleanup EXIT HUP INT TERM

curl --fail --silent --output /dev/null http://127.0.0.1:3001/health
curl --fail --silent --output /dev/null http://127.0.0.1:8081/status

sh ./scripts/run-maestro-ios.sh ../../.maestro/start-airport-simulation.yaml

printf '%s\n' \
  '51.044700,-114.071900' \
  '51.042000,-114.071900' |
  xcrun simctl location "$device_id" start --speed=8 --interval=0.5 -

xcrun simctl spawn "$device_id" log stream \
  --timeout 60 \
  --style compact \
  --predicate 'process == "NavOSS"' \
  >"$log_directory/navigation.log"

maestro --device "$device_id" test ../../.maestro/assert-automatic-reroute-complete.yaml