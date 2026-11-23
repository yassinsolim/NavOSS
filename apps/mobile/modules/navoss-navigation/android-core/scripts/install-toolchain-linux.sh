#!/usr/bin/env bash
# Installs, on Linux x86_64 (CI's ubuntu-latest), what apps/mobile/scripts/build-android-core.sh
# needs: the pinned swift.org toolchain, the Swift SDK for Android and NDK r30, each at the version
# and checksum in apps/mobile/scripts/android-core-toolchain.env.
#
# Usage: install-toolchain-linux.sh <download-dir> <install-dir>
#   <download-dir> keeps the verified tarballs (CI caches it by the pinned versions);
#   <install-dir> receives the extracted toolchain.
# Prints two lines on stdout: the toolchain's bin directory and the NDK r30 directory (for
# ANDROID_NDK_HOME). Everything else goes to stderr.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../../scripts/android-core-toolchain.env
. "$here/../../../../scripts/android-core-toolchain.env"
downloads="${1:?download directory}"
install="${2:?install directory}"

fail() {
  echo "install-toolchain-linux: $*" >&2
  exit 1
}

[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || fail "Linux x86_64 only"
# shellcheck disable=SC1091
os="$(. /etc/os-release && echo "$ID-$VERSION_ID")"
[[ "$os" == "$SWIFT_LINUX_OS_ID-$SWIFT_LINUX_OS_VERSION" ]] ||
  fail "the pinned toolchain is for $SWIFT_LINUX_OS_ID $SWIFT_LINUX_OS_VERSION, this is $os (pin the matching one: docs/architecture/android-core.md)"

# Download once into <download-dir>; verify the pinned SHA-256 every time, cached or not.
fetch() {
  local url="$1" sha="$2" file
  file="$downloads/$(basename "$url")"
  if [[ ! -f "$file" ]]; then
    echo "Downloading $url" >&2
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  sha256sum -c --quiet - <<<"$sha  $file" >&2 || fail "checksum mismatch for $file"
  echo "$file"
}

mkdir -p "$downloads" "$install"
toolchain="$(fetch "$SWIFT_LINUX_TOOLCHAIN_URL" "$SWIFT_LINUX_TOOLCHAIN_SHA256")"
sdk="$(fetch "$SWIFT_ANDROID_SDK_URL" "$SWIFT_ANDROID_SDK_SHA256")"

echo "Extracting the Swift $SWIFT_VERSION toolchain" >&2
tar -xzf "$toolchain" -C "$install" --strip-components 1
swift_bin="$install/usr/bin"
grep -q "Swift version $SWIFT_VERSION " <<<"$("$swift_bin/swift" --version 2>&1)" ||
  fail "the extracted toolchain is not Swift $SWIFT_VERSION"

# The bundle was verified above; `swift sdk install` of a local file takes no checksum.
if ! grep -qx "$SWIFT_ANDROID_SDK_ID" <<<"$("$swift_bin/swift" sdk list 2>/dev/null)"; then
  "$swift_bin/swift" sdk install "$sdk" >&2
fi

# NDK r30 for the core and its libc++_shared.so. React Native's own NDK (r27) is installed
# separately by the workflow; ANDROID_NDK_HOME is set for the core build only.
sdkmanager="${ANDROID_HOME:?set ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager"
"$sdkmanager" "ndk;$ANDROID_NDK_VERSION" >/dev/null
ndk="$ANDROID_HOME/ndk/$ANDROID_NDK_VERSION"
# Where `swift sdk install` put the bundle depends on the host (~/.swiftpm or the XDG directory);
# its resources path is <bundle>/swift-android/swift-resources/….
resources="$(sed -n 's/^swiftResourcesPath: //p' <<<"$("$swift_bin/swift" sdk configure \
  --show-configuration "$SWIFT_ANDROID_SDK_ID" "$SWIFT_ANDROID_TRIPLE")")"
[[ "$resources" == */swift-android/swift-resources/* ]] || fail "unexpected SDK layout: $resources"
ANDROID_NDK_HOME="$ndk" "${resources%%/swift-resources/*}/scripts/setup-android-sdk.sh" >&2

printf '%s\n' "$swift_bin" "$ndk"
