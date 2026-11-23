#!/usr/bin/env bash
# Cross-compiles the Android subset of the navigation core and its XCTest suite, pushes
# them to a running emulator or device, and runs every test there.
#
# Requirements: the swift.org toolchain and Swift SDK for Android from swift.org (default
# swift-6.4.3-RELEASE_android, override with SWIFT_ANDROID_SDK), ANDROID_NDK_HOME (NDK r30),
# adb on PATH and ANDROID_SERIAL.
#
# Three test files locate repository fixtures from `#filePath`, which is the host's absolute
# path and does not exist on the device. The staged copy rewrites only those fixture roots to
# the mirrored device path; no test logic changes.
set -euo pipefail

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
: "${ANDROID_SERIAL:?set ANDROID_SERIAL}"
SDK="${SWIFT_ANDROID_SDK:-swift-6.4.3-RELEASE_android}"
TRIPLE="${SWIFT_ANDROID_TRIPLE:-aarch64-unknown-linux-android28}"
DEVICE_ROOT="${DEVICE_ROOT:-/data/local/tmp/navoss-core-tests}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/navoss-android-core.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

module_rel="apps/mobile/modules/navoss-navigation"
mkdir -p "$stage/$module_rel" "$stage/apps/mobile/test" "$stage/packages/contracts/test"
rsync -a --exclude .build "$repo/$module_rel/ios" "$repo/$module_rel/android-core" "$stage/$module_rel/"
cp -R "$repo/apps/mobile/test/fixtures" "$stage/apps/mobile/test/"
cp -R "$repo/packages/contracts/test/fixtures" "$stage/packages/contracts/test/"

tests="$stage/$module_rel/android-core/Tests"
device_tests="$DEVICE_ROOT/repo/$module_rel/android-core/Tests"
for file in "$tests"/*.swift; do
  name="$(basename "$file")"
  if grep -q 'URL(fileURLWithPath: #filePath)' "$file"; then
    rm "$file"
    sed "s|URL(fileURLWithPath: #filePath)|URL(fileURLWithPath: \"$device_tests/$name\")|" \
      "$stage/$module_rel/ios/Tests/$name" >"$file"
  fi
done

products="$stage/.build/out/Products/Debug-android-${TRIPLE%%-*}"
(cd "$stage/$module_rel/android-core" &&
  swift build --build-tests --swift-sdk "$SDK" --triple "$TRIPLE" --scratch-path "$stage/.build")

sdk_libs="$(swift sdk configure --show-configuration "$SDK" "$TRIPLE" |
  sed -n 's/^swiftResourcesPath: //p')/android"
ndk_cxx="$(echo "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so)"

adb shell "rm -rf $DEVICE_ROOT && mkdir -p $device_tests $DEVICE_ROOT/repo/apps/mobile/test $DEVICE_ROOT/repo/packages/contracts/test"
adb push "$sdk_libs"/*.so "$ndk_cxx" "$DEVICE_ROOT/" >/dev/null
adb push "$products/NavOSSNavigationCoreTests-test-runner" "$products/NavOSSNavigationCoreTests.so" \
  "$products"/*NavOSSNavigationCoreTests.bundle "$DEVICE_ROOT/" >/dev/null
adb push "$stage/apps/mobile/test/fixtures" "$DEVICE_ROOT/repo/apps/mobile/test/" >/dev/null
adb push "$stage/packages/contracts/test/fixtures" "$DEVICE_ROOT/repo/packages/contracts/test/" >/dev/null

adb shell "cd $DEVICE_ROOT && LD_LIBRARY_PATH=$DEVICE_ROOT ./NavOSSNavigationCoreTests-test-runner $*"
