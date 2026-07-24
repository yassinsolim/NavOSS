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

log_directory="$(mktemp -d "${TMPDIR:-/tmp}/navoss-camera.XXXXXX")"

cleanup() {
  xcrun simctl location "$device_id" clear >/dev/null 2>&1 || true
  rm -rf "$log_directory"
}

trap cleanup EXIT HUP INT TERM

curl --fail --silent --output /dev/null http://127.0.0.1:3001/health
curl --fail --silent --output /dev/null http://127.0.0.1:8081/status

app_path="$(
  xcodebuild \
    -workspace ios/NavOSS.xcworkspace \
    -scheme NavOSS \
    -configuration Debug \
    -sdk iphonesimulator \
    -showBuildSettings 2>/dev/null |
    awk -F ' = ' '/^[[:space:]]*TARGET_BUILD_DIR = / && $2 ~ /Debug-iphonesimulator$/ { print $2 "/NavOSS.app"; exit }'
)"

if [ ! -d "$app_path" ]; then
  printf 'Simulator app not found: %s\n' "$app_path" >&2
  exit 1
fi

xcrun simctl boot "$device_id" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$device_id" -b
xcrun simctl install "$device_id" "$app_path"

sh ./scripts/run-maestro-ios.sh ../../.maestro/start-airport-simulation.yaml

NAVOSS_SIMULATION_SPEED_MPS=25 \
  NAVOSS_SIMULATION_INTERVAL_SECONDS=0.5 \
  NAVOSS_SIMULATION_HEAD_METERS=1200 \
  node ./scripts/replay-route-ios.mjs

xcrun simctl spawn "$device_id" log stream \
  --timeout 55 \
  --style compact \
  --predicate 'process == "NavOSS"' \
  >"$log_directory/navigation.log"

maestro --device "$device_id" test ../../.maestro/assert-safety-camera-alert.yaml