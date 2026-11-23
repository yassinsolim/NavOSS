#!/usr/bin/env bash
# Cross-compiles the Android subset of the navigation core with its XCTest suites
# (NAVOSS_ANDROID_CORE=1), pushes them to a running emulator or device and runs every test there.
#
# Requirements: as build-android-core.sh, plus adb on PATH and ANDROID_SERIAL.
# CXX_RUNTIME=/path/to/libc++_shared.so pushes that C++ runtime instead of the pinned NDK's.
#
# Some test files locate repository fixtures from `#filePath`, the host's absolute path, which
# does not exist on the device. The staged copy rewrites only `URL(fileURLWithPath: #filePath)`
# to the file's mirrored device path; no test logic changes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=android-core-toolchain.env
. "$here/android-core-toolchain.env"
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
: "${ANDROID_SERIAL:?set ANDROID_SERIAL}"
DEVICE_ROOT="${DEVICE_ROOT:-/data/local/tmp/navoss-core-tests}"

repo="$(cd "$here/../../.." && pwd)"
module_rel="apps/mobile/modules/navoss-navigation"
stage="$(mktemp -d "${TMPDIR:-/tmp}/navoss-android-core.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/$module_rel" "$stage/apps/mobile/test" "$stage/packages/contracts/test"
rsync -a --exclude build --exclude .build "$repo/$module_rel/Package.swift" "$repo/$module_rel/ios" \
  "$repo/$module_rel/android-core" "$stage/$module_rel/"
cp -R "$repo/apps/mobile/test/fixtures" "$stage/apps/mobile/test/"
cp -R "$repo/packages/contracts/test/fixtures" "$stage/packages/contracts/test/"

for tests in ios/Tests android-core/Tests; do
  for file in "$stage/$module_rel/$tests"/*.swift; do
    device_file="$DEVICE_ROOT/repo/$module_rel/$tests/$(basename "$file")"
    sed -i.orig "s|URL(fileURLWithPath: #filePath)|URL(fileURLWithPath: \"$device_file\")|" "$file"
    rm "$file.orig"
  done
done

triple_arch="${SWIFT_ANDROID_TRIPLE%%-*}"
products="$stage/.build/out/Products/Debug-android-$triple_arch"
(cd "$stage/$module_rel" && NAVOSS_ANDROID_CORE=1 swift build --build-tests \
  --swift-sdk "$SWIFT_ANDROID_SDK_ID" --triple "$SWIFT_ANDROID_TRIPLE" --scratch-path "$stage/.build")

sdk_libs="$(swift sdk configure --show-configuration "$SWIFT_ANDROID_SDK_ID" "$SWIFT_ANDROID_TRIPLE" |
  sed -n 's/^swiftResourcesPath: //p')/android"
cxx="${CXX_RUNTIME:-$(echo "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so)}"

adb shell "rm -rf $DEVICE_ROOT && mkdir -p $DEVICE_ROOT/repo/apps/mobile/test $DEVICE_ROOT/repo/packages/contracts/test $DEVICE_ROOT/repo/$module_rel/ios/Tests $DEVICE_ROOT/repo/$module_rel/android-core/Tests"
adb push "$sdk_libs"/*.so "$cxx" "$DEVICE_ROOT/" >/dev/null
adb push "$products"/*-test-runner "$products"/*Tests.so "$products"/*.bundle "$DEVICE_ROOT/" >/dev/null
adb push "$stage/apps/mobile/test/fixtures" "$DEVICE_ROOT/repo/apps/mobile/test/" >/dev/null
adb push "$stage/packages/contracts/test/fixtures" "$DEVICE_ROOT/repo/packages/contracts/test/" >/dev/null

status=0
for runner in "$products"/*-test-runner; do
  name="$(basename "$runner")"
  echo "== $name"
  adb shell "cd $DEVICE_ROOT && LD_LIBRARY_PATH=$DEVICE_ROOT ./$name $*" || status=$?
done
exit "$status"
