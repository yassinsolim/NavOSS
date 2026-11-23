#!/usr/bin/env bash
# Verifies the Android core libraries apps/mobile/scripts/build-android-core.sh produced, whether
# just built or restored from a cache. Fails on the first class of problem it finds:
#   - an ABI directory other than the pinned one, or no libNavOSSCore.so;
#   - a NEEDED library that is neither shipped nor part of Android (the NDK's API-level stubs),
#     or a shipped library nothing needs;
#   - a JNI entry point the Kotlin binding declares (jni-contract.py) not exported;
#   - a LOAD segment aligned below 16 KB;
#   - a libc++_shared.so without the symbol the config plugin checks for NDK r30.
# Prints the libraries' SHA-256 sums (`sha256sum` format) on stdout.
#
# Usage: verify-android-core.sh [<jniLibs-dir>]  (default: android-core/build/jniLibs)
# Needs NDK r30 at ANDROID_NDK_HOME or $ANDROID_HOME/ndk/<pinned version>, and python3.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../../scripts/android-core-toolchain.env
. "$here/../../../../scripts/android-core-toolchain.env"
root="${1:-$here/../build/jniLibs}"
dir="$root/$ANDROID_ABI"
plugin="$here/../../../../plugins/with-navoss-android-navigation.cjs"

fail() {
  echo "verify-android-core: $*" >&2
  exit 1
}

ndk="${ANDROID_NDK_HOME:-}"
if [[ "$(sed -n 's/^Pkg.Revision = //p' "$ndk/source.properties" 2>/dev/null || true)" != "$ANDROID_NDK_VERSION" ]]; then
  ndk="${ANDROID_HOME:-}/ndk/$ANDROID_NDK_VERSION"
fi
[[ -f "$ndk/source.properties" ]] || fail "NDK $ANDROID_NDK_VERSION not found (ANDROID_NDK_HOME or ANDROID_HOME)"
prebuilt="$(echo "$ndk"/toolchains/llvm/prebuilt/*)"
readelf="$prebuilt/bin/llvm-readelf"
nm="$prebuilt/bin/llvm-nm"
platform_libs="$prebuilt/sysroot/usr/lib/aarch64-linux-android/${SWIFT_ANDROID_TRIPLE##*android}"
[[ -d "$platform_libs" ]] || fail "no NDK platform libraries at $platform_libs"
if command -v sha256sum >/dev/null; then sha256=(sha256sum); else sha256=(shasum -a 256); fi

abis="$(cd "$root" 2>/dev/null && ls)" || fail "no libraries at $root"
[[ "$abis" == "$ANDROID_ABI" ]] || fail "expected only $ANDROID_ABI under $root, found: $(tr '\n' ' ' <<<"$abis")"
[[ -f "$dir/libNavOSSCore.so" ]] || fail "libNavOSSCore.so is missing"

# Every tool's output is captured, and its exit status checked, before anything parses it: a
# reader that fails must fail the verification, not yield an empty (and so passing) list.
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
tool() {
  local out
  out="$("$@" 2>"$errors")" || fail "$(basename "$1") failed on ${*: -1}: $(head -c 400 "$errors")"
  printf '%s\n' "$out"
}

needed() {
  local dynamic
  dynamic="$(tool "$readelf" -d "$1")" || exit 1
  sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' <<<"$dynamic"
}

# The NEEDED closure from libNavOSSCore.so: each library either shipped or Android's own.
# (A newline-separated list, not an associative array: macOS ships bash 3.2.)
reached=libNavOSSCore.so
pending=(libNavOSSCore.so)
while ((${#pending[@]})); do
  lib="${pending[0]}"
  pending=("${pending[@]:1}")
  needs="$(needed "$dir/$lib")" || exit 1
  for need in $needs; do
    grep -qxF "$need" <<<"$reached" && continue
    if [[ -f "$dir/$need" ]]; then
      reached+=$'\n'"$need"
      pending+=("$need")
    elif [[ "$need" == libc++.so || ! -f "$platform_libs/$need" ]]; then
      fail "$lib needs $need, which is neither shipped nor part of Android"
    fi
  done
done
for so in "$dir"/*; do
  name="$(basename "$so")"
  grep -qxF "$name" <<<"$reached" || fail "$name is shipped but nothing in the core needs it"
done

# JNI entry points: every Kotlin `external` (read from the binding) is exported.
exports="$(tool "$nm" -D --defined-only --format=just-symbols "$dir/libNavOSSCore.so")" || exit 1
symbols="$(tool python3 "$here/jni-contract.py" symbols)" || exit 1
[[ -n "$symbols" ]] || fail "jni-contract.py listed no JNI symbols"
missing=0
while read -r symbol; do
  grep -qxF "$symbol" <<<"$exports" || { echo "::error::libNavOSSCore.so does not export $symbol"; missing=1; }
done <<<"$symbols"
((missing == 0)) || fail "JNI entry points missing from libNavOSSCore.so"

# Android 15+ devices with 16 KB pages load only libraries whose LOAD segments are 16 KB aligned.
# A library with no LOAD segment at all cannot be loaded either.
for so in "$dir"/*.so; do
  headers="$(tool "$readelf" -lW "$so")" || exit 1
  alignments="$(awk '$1 == "LOAD" { print $NF }' <<<"$headers")"
  [[ -n "$alignments" ]] || fail "$(basename "$so") has no LOAD segment"
  for alignment in $alignments; do
    [[ "$alignment" =~ ^0x[0-9a-fA-F]+$ ]] || fail "$(basename "$so"): unreadable LOAD alignment '$alignment'"
    ((alignment >= 0x4000)) || fail "$(basename "$so") has a LOAD segment aligned to $alignment, below 16 KB"
  done
done

# NDK r30's libc++_shared.so, recognised by the same symbol the config plugin checks.
symbol="$(grep -o '_ZNSt6__ndk1[A-Za-z0-9_]*' "$plugin" | sort -u)"
[[ "$(wc -l <<<"$symbol")" -eq 1 && -n "$symbol" ]] || fail "cannot read the libc++ symbol from $plugin"
[[ -f "$dir/libc++_shared.so" ]] || fail "libc++_shared.so is missing"
libcxx_exports="$(tool "$nm" -D --defined-only --format=just-symbols "$dir/libc++_shared.so")" || exit 1
grep -qxF "$symbol" <<<"$libcxx_exports" || fail "libc++_shared.so does not define $symbol: not NDK r30's"

echo "verify-android-core: $(wc -l <<<"$reached" | tr -d ' ') libraries, JNI exports, 16 KB alignment and r30 libc++ OK" >&2
sums="$(cd "$dir" && "${sha256[@]}" -- *.so)" || fail "cannot hash the libraries"
printf '%s\n' "$sums"
