#!/usr/bin/env bash
# The signed Android release build in two phases, so that the release key is on disk only while
# Gradle signs and packages, and nothing is downloaded or generated while it is.
#
#   build-android-release.sh prepare   no key present. Validates the release configuration,
#                                      builds the contracts, runs `expo prebuild`, pins the Gradle
#                                      wrapper (pin-gradle-wrapper.sh), then runs the whole
#                                      `assembleRelease` signed with a throwaway key generated
#                                      here (and deletes key and APK): the distribution, every
#                                      dependency, the JS bundle, R8, resources and native
#                                      libraries are fetched and built now.
#   build-android-release.sh sign      with NAVOSS_ANDROID_KEYSTORE, NAVOSS_ANDROID_KEYSTORE_PASSWORD
#                                      and NAVOSS_ANDROID_KEY_ALIAS set: `./gradlew --offline
#                                      :app:assembleRelease`. Only the tasks whose input is the
#                                      signing configuration run again; the script lists every
#                                      task that executed and fails if one is not a
#                                      signing/packaging task.
#
# Both phases read EXPO_PUBLIC_API_URL and NAVOSS_ANDROID_VERSION_CODE; give them the same
# values. Used by .github/workflows/android-release.yml and the release leg of ci.yml.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile="$(cd "$here/.." && pwd)"
gradle=(./gradlew --console=plain)

fail() {
  echo "build-android-release: $*" >&2
  exit 1
}

# Tasks the sign phase may execute: those whose inputs include the signing configuration.
# Anything else running there means the prepare phase left work for the key-bearing step.
SIGNING_TASKS='^:app:(validateSigningRelease|signingConfigWriterRelease|packageRelease|createReleaseApkListingFileRedirect|assembleRelease)$'

case "${1:-}" in
  prepare)
    for name in NAVOSS_ANDROID_KEYSTORE NAVOSS_ANDROID_KEYSTORE_PASSWORD NAVOSS_ANDROID_KEY_ALIAS; do
      [[ -z "${!name:-}" ]] || fail "$name is set: the prepare phase must run without the release key"
    done
    cd "$mobile"
    node ./scripts/validate-release-env.mjs
    corepack pnpm --filter @navoss/contracts build
    corepack pnpm exec expo prebuild --platform android --clean --no-install
    "$here/pin-gradle-wrapper.sh" "$mobile/android"
    cd android
    "${gradle[@]}" --version
    throwaway="$(mktemp -d)"
    trap 'rm -rf "$throwaway"' EXIT
    password="$(openssl rand -hex 16)"
    keytool -genkeypair -storetype pkcs12 -keystore "$throwaway/warm-up.p12" -storepass "$password" \
      -alias warm-up -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=NavOSS release warm-up' \
      >/dev/null 2>&1
    NAVOSS_ANDROID_KEYSTORE="$throwaway/warm-up.p12" NAVOSS_ANDROID_KEYSTORE_PASSWORD="$password" \
      NAVOSS_ANDROID_KEY_ALIAS=warm-up "${gradle[@]}" :app:assembleRelease
    # The warm-up APK carries the throwaway signature; it must never be mistaken for the release.
    rm -f app/build/outputs/apk/release/*.apk
    ;;
  sign)
    for name in NAVOSS_ANDROID_KEYSTORE NAVOSS_ANDROID_KEYSTORE_PASSWORD NAVOSS_ANDROID_KEY_ALIAS; do
      [[ -n "${!name:-}" ]] || fail "$name is not set"
    done
    cd "$mobile/android"
    log="$(mktemp)"
    "${gradle[@]}" --offline :app:assembleRelease | tee "$log"
    executed="$(sed -n 's/^> Task \(:[^ ]*\)$/\1/p' "$log")"
    rm -f "$log"
    echo "Tasks executed with the release key present:"
    sed 's/^/  /' <<<"$executed"
    unexpected="$(grep -Ev "$SIGNING_TASKS" <<<"$executed" || true)"
    [[ -z "$unexpected" ]] || fail "tasks other than signing and packaging ran with the key present: $(tr '\n' ' ' <<<"$unexpected")"
    ;;
  *)
    fail "usage: build-android-release.sh prepare | sign"
    ;;
esac
