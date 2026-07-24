#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <flow-file>\n' "$0" >&2
  exit 2
fi

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
curl --fail --silent --output /dev/null http://127.0.0.1:8081/status

xcrun simctl boot "$device_id" >/dev/null 2>&1 || true
open -a Simulator --args -CurrentDeviceUDID "$device_id"
xcrun simctl bootstatus "$device_id" -b
xcrun simctl privacy "$device_id" grant location org.navoss.mobile
xcrun simctl location "$device_id" set 51.0447,-114.0719
xcrun simctl spawn "$device_id" defaults write org.navoss.mobile EXDevMenuIsOnboardingFinished -bool YES
xcrun simctl launch "$device_id" org.navoss.mobile >/dev/null
xcrun simctl openurl \
  "$device_id" \
  'exp+navoss://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'

maestro --device "$device_id" test "$1"