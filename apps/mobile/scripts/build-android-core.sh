#!/usr/bin/env bash
# Builds the Swift navigation core for Android (release, arm64-v8a) into
# modules/navoss-navigation/android-core/build/jniLibs/<abi>/, the folder the Gradle module uses
# as `jniLibs`: libNavOSSCore.so and every shared library it needs that Android does not provide,
# stripped. Prints each library's size and deflated size, and the NEEDED closure.
#
# Runs on macOS and Linux (CI: android-core/scripts/install-toolchain-linux.sh installs the toolchain).
# Requirements (versions pinned in android-core-toolchain.env; see docs/architecture/android-core.md):
#   - the swift.org Swift toolchain on PATH (`. ~/.swiftly/env.sh` after `swiftly install`),
#   - the Swift SDK for Android installed with `swift sdk install`,
#   - ANDROID_NDK_HOME pointing at the pinned NDK, linked into the SDK with its
#     `swift-android/scripts/setup-android-sdk.sh`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=android-core-toolchain.env
. "$here/android-core-toolchain.env"
package="$(cd "$here/../modules/navoss-navigation" && pwd)"
out="$package/android-core/build/jniLibs/$ANDROID_ABI"
scratch="${SCRATCH:-$package/android-core/build/swiftpm}"

fail() {
  echo "build-android-core: $*" >&2
  exit 1
}

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the Android NDK $ANDROID_NDK_RELEASE}"
ndk_revision="$(sed -n 's/^Pkg.Revision = //p' "$ANDROID_NDK_HOME/source.properties" 2>/dev/null || true)"
[[ "$ndk_revision" == "$ANDROID_NDK_VERSION" ]] ||
  fail "ANDROID_NDK_HOME is NDK '$ndk_revision', expected $ANDROID_NDK_VERSION"
# Here-strings, not pipes: `cmd | grep -q` can end `cmd` with SIGPIPE, which pipefail reports.
grep -q "Swift version $SWIFT_VERSION " <<<"$(swift --version 2>&1)" ||
  fail "swift on PATH is not Swift $SWIFT_VERSION (macOS: . ~/.swiftly/env.sh)"
grep -qx "$SWIFT_ANDROID_SDK_ID" <<<"$(swift sdk list 2>/dev/null)" ||
  fail "Swift SDK $SWIFT_ANDROID_SDK_ID is not installed"

# NAVOSS_HOST_HTTP: HTTP goes through the Kotlin host, so the URLSession adapter and with it
# FoundationNetworking (libcurl) are left out. The test builds keep the adapter: the iOS tests
# stub URLSession; the facade tests and the Kotlin test use the host transport this build ships.
build=(swift build -c release --product NavOSSCore --swift-sdk "$SWIFT_ANDROID_SDK_ID"
  --triple "$SWIFT_ANDROID_TRIPLE" --scratch-path "$scratch" -Xswiftc -DNAVOSS_HOST_HTTP "$@")
(cd "$package" && NAVOSS_ANDROID_CORE=1 "${build[@]}")
# SwiftPM's product directory differs between hosts and versions; ask it.
products="$(cd "$package" && NAVOSS_ANDROID_CORE=1 "${build[@]}" --show-bin-path)"

sdk_libs="$(swift sdk configure --show-configuration "$SWIFT_ANDROID_SDK_ID" "$SWIFT_ANDROID_TRIPLE" |
  sed -n 's/^swiftResourcesPath: //p')/android"
prebuilt="$(echo "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*)"
readelf="$prebuilt/bin/llvm-readelf"
strip="$prebuilt/bin/llvm-strip"
ndk_libs="$prebuilt/sysroot/usr/lib/aarch64-linux-android"

needed() {
  "$readelf" -d "$1" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p'
}

rm -rf "$out" && mkdir -p "$out"
cp "$products/libNavOSSCore.so" "$out/"
# The transitive closure of NEEDED libraries that Android itself does not provide.
pending=(libNavOSSCore.so)
while ((${#pending[@]})); do
  lib="${pending[0]}"
  pending=("${pending[@]:1}")
  for need in $(needed "$out/$lib"); do
    [[ -e "$out/$need" ]] && continue
    if [[ -e "$sdk_libs/$need" ]]; then
      cp "$sdk_libs/$need" "$out/"
    elif [[ -e "$ndk_libs/$need" ]]; then
      cp "$ndk_libs/$need" "$out/"
    else
      continue # libc, libm, libdl, liblog, libz, ...: part of Android
    fi
    pending+=("$need")
  done
done
chmod u+w "$out"/*.so
"$strip" --strip-unneeded "$out"/*.so

echo
printf '%-42s %12s %12s\n' library bytes deflated
total=0
total_deflated=0
for so in "$out"/*.so; do
  size=$(wc -c <"$so" | tr -d ' ')
  deflated=$(gzip -9 -c "$so" | wc -c | tr -d ' ')
  total=$((total + size))
  total_deflated=$((total_deflated + deflated))
  printf '%-42s %12d %12d\n' "$(basename "$so")" "$size" "$deflated"
done
printf '%-42s %12d %12d\n' TOTAL "$total" "$total_deflated"
# Android 15 and later devices with 16 KB pages load a library only if its LOAD segments are
# aligned to 16 KB (0x4000) or more.
echo
echo "LOAD alignment:"
misaligned=0
for so in "$out"/*.so; do
  alignments="$("$readelf" -lW "$so" | awk '$1 == "LOAD" { print $NF }' | sort -u | tr '\n' ' ')"
  printf '  %s: %s\n' "$(basename "$so")" "$alignments"
  for alignment in $alignments; do
    ((alignment >= 0x4000)) || misaligned=1
  done
done
((misaligned == 0)) || fail "a library has a LOAD segment aligned below 16 KB (0x4000)"
echo
echo "NEEDED:"
for so in "$out"/*.so; do
  printf '  %s: %s\n' "$(basename "$so")" "$(needed "$so" | tr '\n' ' ')"
done
