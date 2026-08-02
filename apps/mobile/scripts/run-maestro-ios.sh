#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <flow-file>\n' "$0" >&2
  exit 2
fi

flow_file=$1

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

curl --fail --silent --output /dev/null http://127.0.0.1:3001/health
curl --fail --silent --output /dev/null http://localhost:8081/status

xcrun simctl boot "$device_id" >/dev/null 2>&1 || true
open -a Simulator --args -CurrentDeviceUDID "$device_id"
xcrun simctl bootstatus "$device_id" -b
installed_app="$(xcrun simctl get_app_container "$device_id" org.navoss.mobile app)"
staged_directory="$(mktemp -d "${TMPDIR:-/tmp}/navoss-maestro-app.XXXXXX")"
staged_app="$staged_directory/NavOSS.app"
maestro_log="$(mktemp "${TMPDIR:-/tmp}/navoss-maestro.XXXXXX.log")"
maestro_debug="$staged_directory/maestro-debug"
ditto "$installed_app" "$staged_app"
trap 'rm -rf "$staged_directory"; rm -f "$maestro_log"' EXIT HUP INT TERM
xcrun simctl terminate "$device_id" org.navoss.mobile >/dev/null 2>&1 || true
xcrun simctl uninstall "$device_id" org.navoss.mobile >/dev/null 2>&1 || true
xcrun simctl install "$device_id" "$staged_app"
xcrun simctl privacy "$device_id" grant location org.navoss.mobile
xcrun simctl location "$device_id" set 51.0447,-114.0719
xcrun simctl spawn "$device_id" defaults write org.navoss.mobile EXDevMenuIsOnboardingFinished -bool YES
xcrun simctl launch "$device_id" org.navoss.mobile >/dev/null
xcrun simctl location "$device_id" set 51.0447,-114.0719
xcrun simctl openurl \
  "$device_id" \
  'exp+navoss://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'

run_maestro() {
  rm -rf "$maestro_debug"
  if maestro --device "$device_id" test --debug-output "$maestro_debug" "$flow_file" >"$maestro_log" 2>&1; then
    cat "$maestro_log"
    return 0
  else
    exit_code=$?
    cat "$maestro_log" >&2
    return "$exit_code"
  fi
}

if ! run_maestro; then
  if ! {
    cat "$maestro_log"
    find "$maestro_debug" -type f -name 'maestro.log' -exec cat {} + 2>/dev/null || true
  } | node "$(dirname "$0")/maestro-retry.mjs" --check-stdin; then
    exit 1
  fi
  xcrun simctl shutdown "$device_id" >/dev/null 2>&1 || true
  xcrun simctl boot "$device_id"
  xcrun simctl bootstatus "$device_id" -b
  xcrun simctl privacy "$device_id" grant location org.navoss.mobile
  xcrun simctl location "$device_id" set 51.0447,-114.0719
  xcrun simctl launch "$device_id" org.navoss.mobile >/dev/null
  xcrun simctl openurl \
    "$device_id" \
    'exp+navoss://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
  : >"$maestro_log"
  run_maestro
fi