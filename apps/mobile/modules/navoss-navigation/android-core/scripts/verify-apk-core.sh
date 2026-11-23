#!/usr/bin/env bash
# Verifies that an APK carries the Android core exactly as built and that its code still reaches
# it: every library in <jniLibs-dir>/<abi> is packaged under lib/<abi>/ byte for byte (so the
# packaged libc++_shared.so is the verified NDK r30 one, not React Native's), and the dex keeps,
# under their JNI names, the binding's native methods, the Host callbacks and the exception
# constructor the Swift side looks up (jni-contract.py dex-members), and the NavOSS classes the
# manifest names. For a release APK the dex checks are what catch R8
# stripping or renaming them.
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

apkanalyzer="${ANDROID_HOME:?set ANDROID_HOME}/cmdline-tools/latest/bin/apkanalyzer"
"$apkanalyzer" dex packages --defined-only "$apk" >"$scratch/dex.txt"
python3 "$here/jni-contract.py" dex-members "$scratch/dex.txt"

# The same hole outside JNI: NavOSS classes Android instantiates by name from the manifest
# (activities, services, receivers, providers) must be in the dex under their names. (The app's
# Expo modules are not: ExpoModulesPackageList refers to their classes directly, so R8 may and
# does rename them.)
classes="$(awk -F'\t' '/^C / { print $NF }' "$scratch/dex.txt")"
"$apkanalyzer" manifest print "$apk" >"$scratch/manifest.xml"
named="$(python3 - "$scratch/manifest.xml" <<'PY'
import pathlib, re, sys
manifest = pathlib.Path(sys.argv[1]).read_text()
for tag in re.findall(r"<(?:activity|service|receiver|provider)\b[^>]*>", manifest):
    name = re.search(r'android:name="(org\.navoss\.[^"]+)"', tag)
    if name:
        print(name.group(1))
PY
)"
count=0
while read -r name; do
  [[ -n "$name" ]] || continue
  count=$((count + 1))
  grep -qxF "$name" <<<"$classes" || { echo "::error::$name is not in the APK's dex under its name"; status=1; }
done <<<"$named"
((status == 0 && count > 0)) || fail "manifest components are missing or renamed"
echo "verify-apk-core: $count NavOSS manifest components present by name" >&2
