# Android releases

NavOSS for Android is in testing. **No public Android release exists yet**: releases are created as
GitHub **drafts** and stay drafts until the owner has tried the APK on a device. This file explains
how a release is cut, how to verify and install the APK, and how the in-app updater works.

Turn-by-turn guidance, speech and rerouting run in the same navigation core as iOS. What the
Android app lacks today (see [`apps/mobile/README.md`](../../apps/mobile/README.md)): Android Auto,
offline maps, sharing road reports and traffic speeds, and Google place details. Only arm64 devices
are supported. Nothing has run on a real Android device yet: every check so far used an emulator.

## Release record

| Release              | State             | Built from                                 | Checked                                                                                                                                                                                                                                                                |
| -------------------- | ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android-v0.1.0-101` | Draft, 2026-11-23 | `main` `b80c7d1`, workflow run 45217106042 | The downloaded APK: digest, the pinned signing certificate, package and version, arm64 only, the navigation core's digest; installed on an API 33 arm64 emulator: search, route preview, Start, guidance banner, foreground service, speech requests. Not on a device. |

## Buttons and keys

Handhelds with a controller (for example the Retroid Pocket) and phones with a keyboard can use
NavOSS without touching the screen:

| Control                | Action                                                     |
| ---------------------- | ---------------------------------------------------------- |
| D-pad or left stick    | Move between controls (a ring shows the focused one)       |
| A, Enter, D-pad centre | Press the focused control                                  |
| B                      | Back: close a sheet or leave the app (never ends a trip)   |
| L1 / R1                | Zoom the map out / in                                      |
| Right stick            | Move the map                                               |
| Right stick press (R3) | Centre the map on you again (on the vehicle during a trip) |

When a sheet opens or changes (a place, a route preview, a trip, a settings sheet), its main
control takes focus, so A acts on it at once; closing a settings sheet returns focus to the
button that opened it. End, chosen with a button, asks for a second press within four seconds;
a touch ends at once, as on iOS. The mapping is also under About and privacy, Buttons and keys.
The shoulder buttons and right stick are read by the `navoss-input` module (`modules/navoss-input`);
KEYCODE_BUTTON_L1 (102), KEYCODE_BUTTON_R1 (103), KEYCODE_BUTTON_THUMBR (107) and the stick's
AXIS_Z / AXIS_RZ. Checked on an emulator with key events only; a real controller's codes are
unverified.

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

1. Merge to `main` with CI green (the `Android build and Kotlin tests` job builds the core, a
   debug APK and an R8 release APK signed with a throwaway key, and checks both).
2. In GitHub Actions, run **Android release** on `main`; the workflow refuses any other ref, and
   the `android-release` environment accepts deployments from `main` only. Whether the
   environment also requires a reviewer's approval before the job gets its secrets is the
   owner's choice in the repository settings. Leave
   **publish** off; add one or two sentences of notes if useful. The workflow needs the
   `android-release` environment and its secrets `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`.
3. The `build` job runs, in this order:
   1. refuses a ref other than `main`; checks out, installs Node, JDK and the pnpm dependencies,
      installs the Android SDK packages, chooses the version, refuses test-only configuration;
   2. builds the Swift navigation core **from source** with `.github/actions/build-android-core`
      (`library-cache: false`: built libraries are never restored from a cache for a release; the
      toolchain tarballs may be, and are checked against their pinned SHA-256 before use) and
      verifies the libraries. Every download, install and native build of the core happens here,
      before the keystore exists;
   3. prepares the release build without the key (`apps/mobile/scripts/build-android-release.sh
prepare`): checks the release configuration (`validate-release-env.mjs`), builds the
      contracts, runs `expo prebuild`, pins the Gradle wrapper to the distribution and SHA-256 in
      `apps/mobile/scripts/gradle-wrapper.env` (gradle.org's published checksum; the build fails
      if the generated wrapper names another version), and runs the whole `assembleRelease`
      signed with a throwaway key it generates and then deletes with its APK. The Gradle
      distribution, every dependency, the JavaScript bundle, R8, resources and native libraries
      are all fetched and built here;
   4. decodes the keystore into the runner's temporary directory;
   5. signs and packages (`build-android-release.sh sign`): `./gradlew --offline
:app:assembleRelease -x lintVitalRelease -x :expo-constants:createExpoConfig`, so nothing
      can be downloaded while the key is on disk and no app-config JavaScript is evaluated. What
      still executes (measured in CI): Gradle's lifecycle and plugin version-assert tasks, AGP's
      always-run CMake configure/build tasks (ninja finds nothing to do), their JSON model and
      prefab configuration, and `packageRelease`, which signs and packages. The step lists the
      tasks it executed and fails if any other ran, if `packageRelease` did not run, or if the
      log has no task records it understands (`test-build-android-release.sh` checks each of
      those). The CI release leg runs the same two phases with throwaway keys, so this is
      checked on every change;
   6. deletes the keystore (also when the build fails);
   7. scans the sign step's log for key material (the password and encoded keystore are given to
      `grep` as patterns on a file descriptor, never on a command line);
   8. verifies the APK: exactly the pinned signing certificate, package `org.navoss.mobile` with
      the expected version, not debuggable, no cleartext traffic, arm64-v8a only, Hermes
      bytecode, every verified core library packaged byte for byte (including NDK r30's
      `libc++_shared.so`), and R8 kept the classes and members JNI reaches by name.

   Any failed check stops the release: an APK without a working core is never published (see
   [android-core.md](../architecture/android-core.md#in-ci-and-releases)). The release notes name
   the core's contract version and the SHA-256 of `libNavOSSCore.so`. The `release` job (the only
   one with `contents: write`) creates the draft with three assets:
   `navoss-<versionName>-<versionCode>.apk`, its `.sha256`, and `update.json` (`versionCode`,
   `versionName`, `minSdk`, `apk`, `sha256`, `size`, `notes`). It then checks that the SHA-256
   GitHub reports for the APK equals the build's own.

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
It asks for the newest 10 releases (`per_page=10`) and reads only those, at most 20 assets each.
The request is made by the app's native updater module, which refuses an answer that announces or
sends more than 1 MiB (ten NavOSS releases are a few tens of kilobytes), and gives up within about 35
seconds: a 30 s deadline is checked before every hop and between reads, and no single connect or
read waits more than 5 s.

Every request follows redirects itself, at most three, and refuses a hop that is not HTTPS on the
default port to an expected host, before connecting to it:

| Request | Hosts                                                                                 |
| ------- | ------------------------------------------------------------------------------------- |
| Feed    | `api.github.com`                                                                      |
| APK     | `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` |

On 2026-11-22, `curl -sIL` on a release asset of `cli/cli` showed `github.com` answering 302 to
`release-assets.githubusercontent.com`; `objects.githubusercontent.com` is the host GitHub used
before. Requests send `User-Agent: NavOSS-Android` and nothing that identifies the phone. Rate limiting, no network, a malformed or oversized answer or a release without a usable
APK leave the app as it was; only a manual check says what happened.

When a newer published `android-v` release with an APK exists, a card over the map says
"NavOSS <version> is available" with the download size, **Install** and **Later** (which hides it
until the next day, or until a newer version). It never appears during a trip.
Nothing installs during a trip either: a download that finishes while a trip is active (including
one continued on return from the install-permission setting) is kept, and the card comes back after
the trip as "NavOSS <version> is ready to install". The system's install prompt opens only after
the driver taps **Install** then. **Start** marks the trip for the updater synchronously, and the
app reads that mark immediately before committing an install session (it abandons the session
during a trip) and before opening Android's install prompt (it cancels the prompt during a trip).

The updater never refuses or delays navigation. Two narrow cases are accepted: a trip that starts in
the instant after that check, and a trip started while Android is installing an update the driver
approved seconds earlier. Android may then replace the app; the trip is saved and restored when
NavOSS reopens.

**Install** downloads the APK into the app's private cache, with progress and **Cancel download**,
on any network. A download that stops (no connection, the app closed, the phone restarted)
continues where it stopped on the next **Install**. An APK announced above 250 MB (the release APK
is about 48 MB) is never offered or downloaded, and a download stops as soon as the server sends or
announces more than the release declared. Before the first byte the app checks that the phone has
room for the rest of the file plus the installer's own copy of it; when it does not, or when
writing the file fails, the card says storage is full (not that the connection dropped) and the
partial file is deleted. Before anything is installed, the app checks:

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
  (`USER_ACTION_NOT_REQUIRED`). Android documents that it may honour this only when NavOSS is
  already the installer of record of itself, which is true after the first in-app update (an APK
  installed from a browser, file manager, `adb` or Obtainium has that app as its installer). **In
  testing it was not honoured:** on an Android 15 emulator, a second in-app update with NavOSS as
  its own installer of record still showed the system prompt. Expect the prompt for every update.
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

Build the navigation core first (`apps/mobile/scripts/build-android-core.sh`, see
[android-core.md](../architecture/android-core.md#build-and-packaging)); without it the APK reports
guidance unavailable. A release build without all three `NAVOSS_ANDROID_*` signing variables fails with an explicit
error; it never falls back to the debug key. R8 and resource shrinking are on. Check the result
with `apps/mobile/modules/navoss-navigation/android-core/scripts/verify-apk-core.sh` and the APK path.

### Testing the updater against a local feed

`EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL=http://127.0.0.1:<port>/releases` at build time points the
updater at a fake releases endpoint on the device's loopback (forward it with
`adb reverse tcp:<port> tcp:<port>`) and allows cleartext traffic to `127.0.0.1` only. Any other
value fails the build (`localhost` included), and a chain that starts there must stay on
`127.0.0.1`; a GitHub chain can never redirect to it. It must
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
