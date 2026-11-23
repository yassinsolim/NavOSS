#!/usr/bin/env bash
# Pins the generated Android project's Gradle wrapper to the distribution recorded in
# gradle-wrapper.env: fails unless `distributionUrl` is exactly that version's binary ZIP on
# services.gradle.org, and sets `distributionSha256Sum`, so the wrapper refuses any other file.
# Run after `expo prebuild` and before the first `./gradlew`.
#
# Usage: pin-gradle-wrapper.sh [<android-project-dir>]  (default: apps/mobile/android)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gradle-wrapper.env
. "$here/gradle-wrapper.env"
properties="${1:-$here/../android}/gradle/wrapper/gradle-wrapper.properties"

fail() {
  echo "pin-gradle-wrapper: $*" >&2
  exit 1
}

[[ -f "$properties" ]] || fail "no $properties (run expo prebuild first)"
expected="distributionUrl=https\\://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
urls="$(grep '^distributionUrl=' "$properties" || true)"
[[ "$urls" == "$expected" ]] ||
  fail "the wrapper wants '${urls#distributionUrl=}', the pin is Gradle $GRADLE_VERSION (update gradle-wrapper.env from https://gradle.org/release-checksums/)"
pinned="$(grep -v '^distributionSha256Sum=' "$properties")"
printf '%s\ndistributionSha256Sum=%s\n' "$pinned" "$GRADLE_DISTRIBUTION_SHA256" >"$properties"
echo "Gradle wrapper pinned to $GRADLE_VERSION ($GRADLE_DISTRIBUTION_SHA256)"
