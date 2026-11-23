# Android releases

NavOSS for Android is in testing. **No public Android release exists yet**: releases are created as
GitHub **drafts** and stay drafts until the owner has tried the APK on a device. This file explains
how a release is cut, how to verify and install the APK, and how the in-app updater works.

What the Android app lacks today (see [`apps/mobile/README.md`](../../apps/mobile/README.md)):
Android Auto, offline maps, sharing road reports and traffic speeds, Google place details, and the
iOS navigation core's matching, guidance, speech and rerouting until the Android engine lands. Only
arm64 devices are supported.

## Signing certificate

Every NavOSS Android release is signed with one key (alias `navoss-release`, RSA 4096). Its
certificate SHA-256 is:

```
B8:63:F2:2E:50:BC:25:9C:56:50:C5:83:8C:7A:E0:6C:AC:FF:74:DA:F0:AC:36:66:89:83:A4:9C:77:6C:9F:B7
```

The release workflow refuses an APK signed by anything else, and the app refuses an update whose
signer is not both this certificate and the installed app's own certificate.

## Versions

- `versionName` is `expo.version` from `apps/mobile/app.json`.
- `versionCode` is set at build time: **100 + the `Android release` workflow's run number**. Run
  numbers only increase for a workflow, and re-running a run keeps its number, so a re-run rebuilds
  the same version instead of skipping one. Values up to 100 are left for local builds. Because
  renaming the workflow file would restart its run numbers, the release job also refuses a version
  code that is not above every existing `android-v` release (drafts included).
- The tag is `android-v<versionName>-<versionCode>`, for example `android-v0.1.0-101`.
- The updater compares `versionCode` only.

Locally, `NAVOSS_ANDROID_VERSION_CODE` sets the version code; without it the build uses
`expo.android.versionCode` from `app.json` (1).

## Cutting a release

1. Merge to `main` with CI green (the `Android build and Kotlin tests` job builds the debug APK).
2. In GitHub Actions, run **Android release** on `main`. Leave **publish** off; add one or two
   sentences of notes if useful. The workflow needs the `android-release` environment and its
   secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`.
3. The `build` job decodes the keystore into the runner's temporary directory, builds with
   `corepack pnpm --filter @navoss/mobile android:release`, deletes the keystore, scans the build
   log for key material, and verifies the APK: exactly the pinned signing certificate, package
   `org.navoss.mobile` with the expected version, not debuggable, no cleartext traffic, arm64-v8a
   only, Hermes bytecode. The `release` job (the only one with `contents: write`) creates the
   draft with three assets: `navoss-<versionName>-<versionCode>.apk`, its `.sha256`, and
   `update.json` (`versionCode`, `versionName`, `minSdk`, `apk`, `sha256`, `size`, `notes`). It
   then checks that the SHA-256 GitHub reports for the APK equals the build's own.
4. Download the APK from the draft, verify it (below) and install it on a test device.
5. When it is good, publish the draft (`gh release edit <tag> --draft=false`). From then on, the
   app offers it to installed copies at their next daily check. A draft or pre-release is never
   offered.

## Verifying an APK

Check the file against the published digest, then check its signature. `apksigner` is in the
Android SDK build-tools (`$ANDROID_HOME/build-tools/<version>/apksigner`):

```sh
sha256sum -c navoss-0.1.0-101.apk.sha256
apksigner verify --print-certs navoss-0.1.0-101.apk | grep 'certificate SHA-256'
# Signer #1 certificate SHA-256 digest: b863f22e50bc259c5650c5838c7ae06cacff74daf0ac36668983a49c776c9fb7
```

There must be exactly one signer, with that digest. The APK uses APK Signature Scheme v2 only
(its minimum Android version is 7.0), so `keytool -printcert -jarfile` cannot read it; use
`apksigner`.

## Installing

1. On the Android device (Android 7.0 or later, arm64), open the release page in a browser and
   download `navoss-<version>-<code>.apk`.
2. Open the file. Android asks to allow installs from the browser or file manager the first time;
   allow it, then install.
3. Open NavOSS. Location permission is asked when it is first needed.

### Obtainium

Releases are plain GitHub releases, so [Obtainium](https://github.com/ImranR98/Obtainium) can track
them: add `https://github.com/yassinsolim/NavOSS`, set the release filter to tags starting with
`android-v`, and the APK filter to `navoss-.*\.apk`. Obtainium then becomes the installer and
offers updates itself. If you use it, turn off **Check for updates automatically** in NavOSS so you
are not offered each update twice.

## In-app updates

The app checks the GitHub Releases API (one anonymous `GET` of
`api.github.com/repos/yassinsolim/NavOSS/releases`) when it opens, at most once every 24 hours and
never during a trip, and on **Check now** under About and privacy, App updates, where
**Check for updates automatically** turns the daily check off. This is disclosed in
[`docs/privacy.md`](../privacy.md). It reads the list rather than `/releases/latest` because iOS
and Android releases share the repository, and rather than `update.json` because the list already
carries the tag, the APK's size and the SHA-256 GitHub computed for it, in one request to one host.
Rate limiting, no network, a malformed answer or a release without a usable APK leave the app as
it was; only a manual check says what happened.

When a newer published `android-v` release with an APK exists, a card over the map says
"NavOSS <version> is available" with the download size, **Install** and **Later** (which hides it
until the next day, or until a newer version). It never appears during a trip.

**Install** downloads the APK into the app's private cache, with progress and **Cancel download**,
on any network. A download that stops (no connection, the app closed, the phone restarted)
continues where it stopped on the next **Install**. Before anything is installed, the app checks:

1. the file's SHA-256 equals the digest GitHub published for the asset;
2. it is an APK of `org.navoss.mobile`;
3. it is signed by exactly the installed app's own certificate, which must be the release
   certificate above;
4. its `versionCode` is higher than the installed one.

A file that fails any check is deleted and the card says why in plain words. A passing file is
streamed into an Android `PackageInstaller` session (hashed again on the way) and committed.

- The first time, Android asks to allow installs from NavOSS; the card opens that setting and
  continues when you come back.
- Android then shows its own install prompt. Cancelling it returns to the offer.
- On Android 12 and later the app asks Android not to require that prompt
  (`USER_ACTION_NOT_REQUIRED`). Android honours this only when NavOSS is already the installer of
  record of itself, which is true **after the first in-app update**: an APK installed from a
  browser, file manager, `adb` or Obtainium has that app as its installer, so the first in-app
  update still shows the prompt, and later ones install without it. On Android 11 and earlier
  every update shows the prompt.
- Installing replaces the app and closes it; saved places, recents and settings stay.

## Building a release APK locally

```sh
export NAVOSS_ANDROID_KEYSTORE=~/.navoss-android/navoss-release.p12
export NAVOSS_ANDROID_KEY_ALIAS=navoss-release
export EXPO_PUBLIC_API_URL=https://navoss-api.yassin.app
NAVOSS_ANDROID_KEYSTORE_PASSWORD="$(security find-generic-password -s navoss-android-release-keystore -a store-password -w)" \
  corepack pnpm --filter @navoss/mobile android:release
# apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

A release build without all three `NAVOSS_ANDROID_*` signing variables fails with an explicit
error; it never falls back to the debug key. R8 and resource shrinking are on.

### Testing the updater against a local feed

`EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL=http://127.0.0.1:<port>/releases` at build time points the
updater at a fake releases endpoint on the device's loopback (forward it with
`adb reverse tcp:<port> tcp:<port>`) and allows cleartext traffic to `127.0.0.1` only. It must
answer in the GitHub releases-list shape, with each asset's `digest`. Use it for test builds only;
the release workflow refuses to build with it set.

## Size

Measured on a local release-signed build of 2026-11-22 (arm64-v8a, the only ABI). Native libraries
are stored uncompressed so Android can map them directly.

| Item                                                              | Size    |
| ----------------------------------------------------------------- | ------- |
| APK (arm64-v8a, R8 + resource shrinking)                          | 48.2 MB |
| JavaScript bundle (Hermes bytecode)                               | 5.5 MB  |
| Native libraries, `lib/arm64-v8a` (24 files, stored uncompressed) | 32.5 MB |
| of which `libappmodules.so`                                       | 1.7 MB  |
| of which `libc++_shared.so`                                       | 1.3 MB  |
| of which `libexpo-modules-core.so`                                | 1.5 MB  |
| of which `libhermesvm.so`                                         | 2.5 MB  |
| of which `libmaplibre.so`                                         | 10.5 MB |
| of which `libreact_codegen_rnscreens.so`                          | 1.1 MB  |
| of which `libreactnative.so`                                      | 7.0 MB  |
| of which `libreanimated.so`                                       | 1.5 MB  |
| of which `libworklets.so`                                         | 1.1 MB  |
| Other ABIs                                                        | none    |
