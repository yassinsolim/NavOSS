#!/usr/bin/env bash
# Checks that the sign phase's task check (build-android-release.sh check-log) fails closed: a
# log of signing and packaging only passes, and each way the log could hide other work, or prove
# nothing, fails. Run by the release leg of ci.yml.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cases=0
failures=0

good() {
  cat <<'LOG'
> Task :app:preBuild UP-TO-DATE
> Task :app:preReleaseBuild UP-TO-DATE
> Task :expo:assertNamespaceTask
> Task :app:mergeReleaseResources UP-TO-DATE
> Task :app:compileReleaseKotlin FROM-CACHE
> Task :app:configureCMakeRelWithDebInfo[arm64-v8a]
> Task :app:buildCMakeRelWithDebInfo[arm64-v8a][appmodules]
> Task :app:validateSigningRelease
> Task :app:packageRelease
> Task :app:createReleaseApkListingFileRedirect
> Task :app:assembleRelease

BUILD SUCCESSFUL in 21s
412 actionable tasks: 9 executed, 403 up-to-date
LOG
}

# expect <pass|fail> <name> <message the failure must carry, or ''>: reads the log on stdin.
expect() {
  local want="$1" name="$2" message="$3" output status
  cat > "$work/$name.log"
  output="$("$here/build-android-release.sh" check-log "$work/$name.log" 2>&1)"
  status=$?
  cases=$((cases + 1))
  if [[ "$want" == pass && $status -eq 0 ]]; then return; fi
  if [[ "$want" == fail && $status -ne 0 && "$output" == *"$message"* ]]; then return; fi
  failures=$((failures + 1))
  echo "test-build-android-release: $name: wanted $want, got status $status: $output" >&2
}

# The log comes from a process substitution, not a pipe: a pipe would run `expect` in a subshell
# and lose its counts, and this test would then pass without having checked anything.
expect pass signing-only '' < <(good)
expect fail empty-log 'is empty' < /dev/null
expect fail no-task-records 'lists no tasks' < <(good | grep -v '^> Task ')
expect fail packaging-missing 'packageRelease did not run' < <(good | grep -v 'packageRelease$')
expect fail packaging-up-to-date 'packageRelease did not run' \
  < <(good | sed 's/^> Task :app:packageRelease$/& UP-TO-DATE/')
expect fail packaging-from-cache 'packageRelease did not run' \
  < <(good | sed 's/^> Task :app:packageRelease$/& FROM-CACHE/')
expect fail bundling-with-the-key 'createBundleReleaseJsAndAssets' \
  < <(good | awk '/validateSigningRelease$/ { print "> Task :app:createBundleReleaseJsAndAssets" } { print }')
expect fail app-config-with-the-key 'createExpoConfig' \
  < <(good | awk '/validateSigningRelease$/ { print "> Task :expo-constants:createExpoConfig" } { print }')
expect fail unknown-outcome 'does not understand' \
  < <(good | awk '/validateSigningRelease$/ { print "> Task :app:minifyReleaseWithR8 FAILED" } { print }')
expect fail build-failed 'successful build' < <(good | sed 's/^BUILD SUCCESSFUL.*/BUILD FAILED in 3s/')

((cases == 10)) || { echo "test-build-android-release: ran $cases of 10 cases" >&2; exit 1; }
((failures == 0)) || { echo "test-build-android-release: $failures of $cases cases wrong" >&2; exit 1; }
echo "test-build-android-release: $cases cases as expected"
