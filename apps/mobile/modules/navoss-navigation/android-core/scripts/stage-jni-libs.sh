#!/usr/bin/env bash
# Builds libNavOSSNavigationJNI.so (release, arm64) and copies it with every shared library it
# needs from the Swift SDK and the NDK into jni-proof/build/swift-jni-libs/arm64-v8a, then
# prints each file's size and its deflated size (what an APK stores when it compresses them).
set -euo pipefail

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
SDK="${SWIFT_ANDROID_SDK:-swift-6.4.3-RELEASE_android}"
TRIPLE="${SWIFT_ANDROID_TRIPLE:-aarch64-unknown-linux-android28}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${SCRATCH:-$here/.build}"
out="$here/jni-proof/build/swift-jni-libs/arm64-v8a"

(cd "$here" && swift build -c release --product NavOSSNavigationJNI \
  --swift-sdk "$SDK" --triple "$TRIPLE" --scratch-path "$scratch" "$@")

sdk_libs="$(swift sdk configure --show-configuration "$SDK" "$TRIPLE" |
  sed -n 's/^swiftResourcesPath: //p')/android"
prebuilt="$(echo "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*)"
readelf="$prebuilt/bin/llvm-readelf"
strip="$prebuilt/bin/llvm-strip"
ndk_libs="$prebuilt/sysroot/usr/lib/aarch64-linux-android"

rm -rf "$out" && mkdir -p "$out"
cp "$scratch/out/Products/Release-android-${TRIPLE%%-*}/libNavOSSNavigationJNI.so" "$out/"
# Copy the transitive closure of NEEDED libraries that are not part of Android itself.
pending=(libNavOSSNavigationJNI.so)
while ((${#pending[@]})); do
  lib="${pending[0]}"
  pending=("${pending[@]:1}")
  for need in $("$readelf" -d "$out/$lib" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p'); do
    [[ -e "$out/$need" ]] && continue
    if [[ -e "$sdk_libs/$need" ]]; then
      cp "$sdk_libs/$need" "$out/"
    elif [[ -e "$ndk_libs/$need" ]]; then
      cp "$ndk_libs/$need" "$out/"
    else
      continue # provided by the platform (libc, libm, libdl, liblog, ...)
    fi
    pending+=("$need")
  done
done
chmod u+w "$out"/*.so
"$strip" --strip-unneeded "$out"/*.so

total=0
total_deflated=0
for so in "$out"/*.so; do
  size=$(stat -f %z "$so" 2>/dev/null || stat -c %s "$so")
  deflated=$(gzip -9 -c "$so" | wc -c | tr -d ' ')
  total=$((total + size))
  total_deflated=$((total_deflated + deflated))
  printf '%-45s %10d %10d\n' "$(basename "$so")" "$size" "$deflated"
done
printf '%-45s %10d %10d\n' TOTAL "$total" "$total_deflated"
