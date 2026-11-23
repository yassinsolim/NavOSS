#!/usr/bin/env bash
# Verifies that an APK carries the Android core exactly as built and that its code still reaches
# it: every library in <jniLibs-dir>/<abi> is packaged under lib/<abi>/ byte for byte (so the
# packaged libc++_shared.so is the verified NDK r30 one, not React Native's), and the dex keeps,
# under their JNI names, the binding's native methods, the Host callbacks and the exception
# constructor the Swift side looks up (jni-contract.py dex-members). For a release APK the second
# check is what catches R8 stripping or renaming them.
#
# Usage: verify-apk-core.sh <apk> [<jniLibs-dir>]  (default: android-core/build/jniLibs)
# Needs ANDROID_HOME (cmdline-tools' apkanalyzer), Java, python3 and unzip.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../../scripts/android-core-toolchain.env
. "$here/../../../../scripts/android-core-toolchain.env"
apk="${1:?apk}"
dir="${2:-$here/../build/jniLibs}/$ANDROID_ABI"

fail() {
  echo "verify-apk-core: $*" >&2
  exit 1
}

[[ -f "$apk" ]] || fail "no APK at $apk"
[[ -f "$dir/libNavOSSCore.so" ]] || fail "no built libNavOSSCore.so at $dir"
if command -v sha256sum >/dev/null; then sha256=(sha256sum); else sha256=(shasum -a 256); fi
digest() { "${sha256[@]}" "$1" | cut -d' ' -f1; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
entries="$(unzip -Z1 "$apk")"
status=0
for so in "$dir"/*.so; do
  name="$(basename "$so")"
  entry="lib/$ANDROID_ABI/$name"
  if ! grep -qxF "$entry" <<<"$entries"; then
    echo "::error::$apk has no $entry"
    status=1
    continue
  fi
  # Extract to a file: `unzip -p | sha256sum` would hide unzip's failure behind the pipe.
  unzip -p "$apk" "$entry" >"$scratch/$name"
  packaged="$(digest "$scratch/$name")"
  if [[ "$packaged" != "$(digest "$so")" ]]; then
    echo "::error::$entry in $apk differs from the built and verified library ($packaged)"
    status=1
  fi
done
((status == 0)) || fail "the APK does not carry the verified core libraries"
echo "verify-apk-core: $(find "$dir" -name '*.so' | wc -l | tr -d ' ') core libraries packaged unchanged; libNavOSSCore.so $(digest "$dir/libNavOSSCore.so")" >&2

"${ANDROID_HOME:?set ANDROID_HOME}/cmdline-tools/latest/bin/apkanalyzer" dex packages --defined-only "$apk" \
  >"$scratch/dex.txt"
python3 "$here/jni-contract.py" dex-members "$scratch/dex.txt"
