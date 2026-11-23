# Android navigation core: the Swift ↔ Kotlin boundary

Status: contract v1. Implemented by `apps/mobile/modules/navoss-navigation/android-core` (Swift
facade and JNI layer) and the Kotlin binding `org.navoss.navigation.core.NavOSSCore`.

## Decision

Android runs the same navigation core as iOS. The Swift package in
`apps/mobile/modules/navoss-navigation/ios/Core` is cross-compiled with the swift.org Swift SDK for
Android, and its trip orchestration (`NavigationEngine`: matching, guidance, speech planning,
reroute consent and requests, safety cameras, speeding, trip restore) is driven from Kotlin
through one small boundary:

- **JSON strings in and out.** Every structured argument and result crosses as a UTF-16 Java
  `String` holding JSON. There are no shared structs, so the boundary has no layout to keep in
  sync and the Kotlin side never needs a Swift type.
- **Exported from Swift with `@_cdecl`** as JNI entry points
  (`Java_org_navoss_navigation_core_NavOSSCore_native…`), loaded by `System.loadLibrary("NavOSSCore")`.
  Kotlin declares them as `external` functions of `NavOSSCore`'s companion object; static
  `external` functions receive a `jclass`, not an instance.
- **Callbacks from Swift to Kotlin** go to one Kotlin object implementing `NavOSSCore.Host`. The
  Swift side looks up its method IDs once, keeps a JNI global reference to it, and calls it with
  `Call<Type>MethodA` (the C-variadic forms cannot be called from Swift).
- **The JS shapes are the wire shapes.** The trip passed to `setRoute`, the location sample passed
  to `updateLocation` and every snapshot returned are exactly the records of
  `modules/navoss-navigation/index.ts`, so the Android Expo module passes the JS object through as
  JSON and hands the snapshot JSON back to JS without touching a field.

The Kotlin side owns everything Android-specific: the location provider, text-to-speech and audio
focus, the foreground service, the one-second timer, HTTP, persistence and preferences storage.

## Versioning

`NavOSSCore.ABI_VERSION = 1`. `nativeAbiVersion()` returns the Swift side's value; the Kotlin
binding compares it at class load and refuses to create an engine (`IllegalStateException`
naming both numbers) on a mismatch. The ABI version changes whenever a native function, a
callback, a JSON key or an error code changes meaning. The JS contract version (`version: 11` in
`getCapabilities`) is separate and is reported by `nativeContractVersion()` so the Expo module can
build its capabilities from the core it actually loaded.

## Lifecycle and calls

All calls are synchronous: they return once the engine has applied the input. `handle` is the
opaque `Long` from `nativeCreate`; `0` is never a valid handle.

| Kotlin (`NavOSSCore`)              | JNI function (`native…`)                        | In                                       | Out              |
| ---------------------------------- | ----------------------------------------------- | ---------------------------------------- | ---------------- |
| `NavOSSCore(config, host)`         | `Create(configJson, host)`                      | config JSON, `Host`                      | handle           |
| `close()`                          | `Destroy(handle)`                               |                                          |                  |
| `resumePersistedTrip()`            | `ResumePersistedTrip(handle)`                   |                                          | snapshot         |
| `setRoute(tripJson)`               | `SetRoute(handle, tripJson)`                    | `NativeCarPlayTrip`                      | snapshot         |
| `updateLocation(sampleJson)`       | `UpdateLocation(handle, sampleJson)`            | `NativeNavigationLocationSample`         | snapshot         |
| `clearRoute()`                     | `ClearRoute(handle)`                            |                                          | snapshot         |
| `getSnapshot()`                    | `GetSnapshot(handle)`                           |                                          | snapshot         |
| `acceptRerouteProposal(id)`        | `AcceptRerouteProposal(handle, id)`             | proposal id                              | `Boolean`        |
| `declineRerouteProposal(id)`       | `DeclineRerouteProposal(handle, id)`            | proposal id                              | `Boolean`        |
| `setRerouteMode(mode)`             | `SetRerouteMode(handle, mode)`                  | `adaptive` / `ask-first` / `keep-route`  |                  |
| `setAudioMode(mode)`               | `SetAudioMode(handle, mode)`                    | `all-guidance` / `alerts-only` / `muted` |                  |
| `setSpeedingWarning(kph, audible)` | `SetSpeedingWarning(handle, kph, audible)`      | `Int`, `Boolean`                         |                  |
| `setAnnounceRoadReports(enabled)`  | `SetAnnounceRoadReports(handle, enabled)`       | `Boolean`                                |                  |
| `getPreferences()`                 | `GetPreferences(handle)`                        |                                          | preferences JSON |
| `clockTick()`                      | `ClockTick(handle)`                             |                                          |                  |
| `isCurrentGeneration(g)`           | `IsCurrentGeneration(handle, g)`                | `Long`                                   | `Boolean`        |
| `completeHttpRequest(id, json)`    | `CompleteHttpRequest(handle, id, responseJson)` | request id, response JSON                |                  |

`nativeAbiVersion()` and `nativeContractVersion()` take no handle.

### Create

```json
{
  "apiBaseUrl": "https://navoss-api.yassin.app",
  "audioMode": "all-guidance",
  "rerouteMode": "adaptive",
  "speedingToleranceKph": 5,
  "speedingAudibleWarning": false,
  "announceRoadReports": true
}
```

Only `apiBaseUrl` is required; the others default as on iOS (`all-guidance`, `adaptive`, 5,
`false`, `true`). The Kotlin module persists preferences itself (SharedPreferences) and passes
them here and through the setters; the core keeps no preference storage of its own.
`resumePersistedTrip()` restores a trip saved through the storage callbacks (below), exactly as
the iOS service does at launch; call it once after creating the engine.

### Set route: the trip JSON

`setRoute` takes the `NativeCarPlayTrip` object JS passes to `setRoute(trip)`, unchanged. The core
decodes it with the same rules as the iOS module's `CarPlayTripRecord` (Expo records), **not** with
`NavOSSCarPlayTrip`'s `Codable` conformance, because the two differ:

| Field                                        | JS record (`index.ts`, iOS `CarPlayTripRecord`)                                                          | `NavOSSCarPlayTrip` `Codable`                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| any missing field                            | defaulted (`0`, `""`, `[]`, `false`), then the trip is validated                                         | decoding error                                                                                                   |
| `steps[].lanes[]`                            | keys `active`, `valid`, `validIndication`, `indications`; a list with any unknown arrow is dropped whole | same keys (Swift names them `isPreferred`, `isValid`, `activeIndication`); an unknown arrow fails the whole trip |
| `congestion`                                 | dropped whole if any level is unknown                                                                    | decoding error                                                                                                   |
| `traffic.oldestObservedAt`                   | ISO 8601 string, with or without fractional seconds                                                      | `Date` as seconds since 2001                                                                                     |
| `waypoints`                                  | `[]` means none                                                                                          | `null` means none                                                                                                |
| `destination.placeCategory`                  | not part of the record                                                                                   | optional                                                                                                         |
| `speedLimitsKph[]`, `steps[].roundaboutExit` | JS numbers (Kotlin maps hold `Double`); integral values accepted                                         | `Int`                                                                                                            |

So the Android module's only mapping is `JSONObject(map).toString()` of the record Expo hands it.
A trip that decodes but fails the core's validation (`NavOSSCarPlayTrip.isValid`) is an
`invalid-route` error, as on iOS.

### Update location: sample in, snapshot out

The sample is `NativeNavigationLocationSample`:
`{latitude, longitude, timestampMs, courseDegrees?, horizontalAccuracyMeters?, speedMetersPerSecond?}`.
`timestampMs` is milliseconds since the Unix epoch (`Location.getTime()`); a fix without it is
refused (`invalid-location`), as on iOS. Negative or unknown course, speed or accuracy must be
omitted, not sent as `-1`. The core also keeps the latest sample's course, speed, accuracy and time
to build a reroute origin (`navOSSNavigationRouteOrigin`), which iOS takes from `CLLocation`.

### The snapshot

Every call that returns a snapshot, and the `onStateChanged` callback, produce a
`NativeNavigationSnapshot` built with the same keys, omissions and conversions as the iOS module's
`serialize(_ state:)`, `serialize(_ trip:)` and `serialize(_ guidance:)`:

- always present: `isOffRoute`, `phase`, `rerouteCount`, `routeProgress`, `routeStatus`,
  `routeVersion`, `sequence`, `stateVersion`, `isDeadReckoning`, `rerouteMode`, `speedingState`;
- present only when known: `tripEndReason`, `isAcquiringPosition` (only ever `true`),
  `speedMetersPerSecond`, `speedLimitKph`, `currentRoadName`, `rerouteProposal`,
  `safetyCameraAlert`, `rawCoordinate`, `matchedCoordinate`, `matchedCourseDegrees`,
  `distanceFromRouteMeters`, `horizontalAccuracyMeters`, and, unless `phase` is `idle`,
  `guidance` and `trip`;
- `rerouteProposal.createdAtMs` is Unix milliseconds; `respondWithinSeconds` is the core's
  constant; the proposal's `trip` and the snapshot's `trip` use the trip serializer (destination
  without `category`, waypoints with it, lanes as `active`/`valid`/`validIndication`,
  `traffic.oldestObservedAt` as ISO 8601 without fractional seconds);
- `communityReportAlert` and `stillTherePrompt` are never present: Android has no community
  reports (they need Apple App Attest), and JS already treats them as optional.

Golden files in `android-core/Tests/Golden` pin these shapes; they were generated from the iOS
module's serializers and are compared key for key by the macOS tests.

### Preferences

`getPreferences()` returns
`{"audioMode", "rerouteMode", "speedingToleranceKph", "speedingAudibleWarning", "announceRoadReports"}`.
`setRerouteMode` / `setAudioMode` with an unknown value is an `invalid-argument` error.
`setSpeedingWarning` clamps the tolerance to 0–20 like iOS. Changing the audio mode away from
`all-guidance` cancels guidance speech (`cancelSpeech`). `announceRoadReports` is kept and
reported back so the Expo module has one owner for it, but has no effect on Android until
community road reports exist there.

### Clock tick

While a trip is active the engine asks for a one-second clock (`startClock`). Each tick calls
`clockTick()`; it expires reroute-consent deadlines, advances dead reckoning through gaps in fixes
and drives camera and speeding state, exactly like the iOS `DispatchSourceTimer`.

## Callbacks: `NavOSSCore.Host`

```kotlin
interface Host {
  fun onStateChanged(snapshotJson: String)
  fun speak(text: String, kind: String, generation: Long)      // kind: "alert" | "maneuver"
  fun cancelSpeech(generation: Long)
  fun needsLocationUpdates()
  fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean)
  fun startClock(generation: Long)
  fun stopClock(generation: Long)
  fun httpRequest(requestId: Long, requestJson: String)
  fun cancelHttpRequest(requestId: Long)
  fun storageRead(key: String): String?
  fun storageWrite(key: String, value: String?)                // null removes the key
  fun nowMs(): Double                                          // wall clock, Unix ms
}
```

- **Generations.** Starting, rerouting or clearing a trip moves the navigation generation on.
  `speak`, `cancelSpeech`, `reconcileLocationUpdates`, `startClock` and `stopClock` carry the
  generation they were produced in. A host that acts on them later (posting to the main thread,
  queueing speech behind other speech) must first check `isCurrentGeneration(generation)` and drop
  the effect if it is stale, as the iOS service does on its main queue. `startClock` for a stale
  generation or while a clock already runs does nothing; `stopClock` stops it only for the
  current generation.
- **Speech.** `kind` is `alert` (camera, speeding, "A new route is ready.") or `maneuver`.
  The core has already applied the audio mode; the host speaks what it is given.
- **Location.** `needsLocationUpdates`: a trip started or a route was installed, start location
  updates. `reconcileLocationUpdates`: a trip ended or arrived; `shouldTrack` is whether the core
  still has an active (not arrived) trip at that moment.
- **`onStateChanged`** carries the current snapshot, read after the engine lock was released. The
  Expo module emits it as `onNavigationSnapshot` unchanged.

### Host services called from Swift

**HTTP: Kotlin performs it.** The core keeps building every request and interpreting every
answer (`/v2/config` discovery, `/v2/routes` with the `/v1/routes` fallback, the retry without
origin metadata, problem details, `/v1/cameras`); only the transport is Kotlin's. Reasons:

- dropping `libFoundationNetworking.so` saves 3,479,512 bytes stripped (1,483,976 deflated); it
  embeds libcurl and links `libz`, and it is the one library that keeps the rest of Foundation
  and ICU loaded even once the core itself needs only FoundationEssentials (see Size);
- curl in FoundationNetworking has no access to Android's certificate store: it needs a CA bundle
  file shipped and configured (`URLSessionCertificateAuthorityInfoFile`) and would ignore user
  and system trust changes, proxies and Android's network security config;
- Android's stack (`HttpURLConnection` or OkHttp, already in the React Native app) handles
  Doze, metered networks and cancellation the way the rest of the app does.

`httpRequest(requestId, requestJson)` is called on a Swift background thread and must return
immediately; the host answers later, from any thread, with
`completeHttpRequest(requestId, responseJson)`. Request:

```json
{
  "method": "POST",
  "url": "https://…/v2/routes",
  "headers": { "content-type": "application/json" },
  "body": "{…}",
  "timeoutMs": 20000
}
```

`body` is absent for `GET`. Response, one of:

```json
{"status": 200, "body": "{…}"}
{"error": "unreachable"}
```

`error` is `unreachable` (no connection, DNS, TLS, reset), `timeout`, or `cancelled`; the core
treats `unreachable` and `timeout` like an iOS `URLError` (a reroute retries with backoff). Every
`httpRequest` must be completed exactly once, unless `cancelHttpRequest(requestId)` arrives first
(the trip was cleared or replaced); completing a cancelled or unknown id is ignored. Bodies are
UTF-8 JSON text. The base URL is the one given at creation.

**Trip storage: blobs through the host.** The core stores the active trip and its progress
checkpoint with the same records, keys, 12-hour expiry and checkpoint format as iOS
(`NavOSSActiveTripStore`), through `storageRead` / `storageWrite`. Keys today are
`org.navoss.mobile.active-navigation-trip.v2` and the same with `.progress`; values are opaque
JSON strings the host must store and return byte for byte (SharedPreferences `apply()` is
enough: reads after a write must see it, durability may lag). The trip blob is written when a trip
starts or a reroute is installed; the progress blob at most every fifteen seconds and on an
arrival-deferral change.

**Wall clock.** `nowMs()` returns `System.currentTimeMillis()` as a `Double` in production and a
test-controlled value in tests. Fix times come from the fixes themselves; the clock drives
consent deadlines, reroute backoff, checkpoints and camera refresh.

## Threading

- Every `native…` function may be called from any thread, including several at once. The engine
  guards its state with one recursive lock.
- Callbacks run synchronously on the thread that caused them: the caller's thread for effects of
  a call (`setRoute` calls `onStateChanged`, `speak`, `startClock` … before it returns), or a Swift
  concurrency thread for reroute and camera completions. Swift attaches such a thread to the JVM
  for the call and detaches it afterwards. Hosts that need the main thread post to it.
- `storageRead`, `storageWrite` and `nowMs` are called **with the engine lock held**. They must
  not call into `NavOSSCore` and must not block on a thread that might. Every other callback is
  invoked with the lock released and may call back in (for example `getSnapshot()` from
  `onStateChanged`).
- `httpRequest` must not block (see above).
- After `close()`, no callback is delivered: in-flight background work finishes silently and
  pending requests are cancelled. `close()` must not be called from inside a callback.

## Errors

No Swift trap crosses the boundary: input is never force-unwrapped, every decoding and validation
failure is a value. A failing call throws `org.navoss.navigation.core.NavOSSCoreException`
(raised by the JNI layer with `ThrowNew`, the native function returning `null`/`0`/`false`) with a
stable `code`:

| `code`             | When                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `invalid-json`     | the argument is not JSON or has the wrong JSON type for a field             |
| `invalid-argument` | an unknown enum value (mode strings) or a bad config                        |
| `invalid-route`    | the trip decoded but failed validation (`NavigationCoreError.invalidRoute`) |
| `invalid-location` | an untimed fix or an invalid coordinate                                     |
| `no-active-trip`   | `updateLocation` without a trip (the session refuses it)                    |
| `closed`           | the handle was destroyed                                                    |
| `internal`         | anything else, with the Swift error's description                           |

The Expo module turns the exception into a rejected call, as the iOS module's `throws` does.
Malformed JSON from the host in `completeHttpRequest` is treated as `{"error":"unreachable"}`.

## Memory and strings

- Strings cross as Java `String`s. Swift reads them with `GetStringChars` / `GetStringLength`
  (UTF-16) and returns them with `NewString`, never the "modified UTF-8" `…UTF` functions, so text
  outside the Basic Multilingual Plane (an emoji in a place name) survives both ways. Swift
  releases every `GetStringChars` buffer and local reference before returning; returned strings
  belong to the JVM.
- The handle is a retained Swift object; `nativeDestroy` releases it once. Kotlin's `close()` is
  idempotent and zeroes the handle before calling it. The `Host` is held as a JNI global
  reference until the engine is deallocated.
- Callback-produced local references are deleted before the callback returns, so a long-running
  background thread does not grow the local reference table.

## C++ runtime (libc++)

The Swift runtime libraries need `libc++_shared.so`; so does React Native. React Native 0.86's
`react-android` AAR ships the NDK r27 copy, the Swift SDK is built against NDK r30, and only one
`libc++_shared.so` can be loaded in the app process. Measured on 2026-11-22:

- The Swift libraries import 17 libc++ symbols. r27's `libc++_shared.so` lacks one of them,
  `std::__ndk1::__hash_memory(void const*, unsigned long)`, imported by `libswiftCore.so` and
  `libswift_Concurrency.so`. With r27 the Swift libraries still load and both XCTest suites pass
  (384 and 17 tests on the emulator) only because `lib_FoundationICU.so` exports its own copy of
  1,636 libc++ symbols, `__hash_memory` among them, and bionic resolves within the load group.
  That is an accident, and it would break as soon as ICU is dropped.
- The 43 React Native, Expo and MapLibre libraries in the Debug APK import 308 libc++ symbols;
  r30's `libc++_shared.so` exports every one. r30 drops 12 r27 exports (the
  `declare_reachable` family and two `pmr` internals); nothing in the app imports them.
- AGP does not report the duplicate: React Native's packaging `pickFirst` silently kept the r27
  copy in the NavOSS Debug APK.
- The NavOSS Debug app with r30's `libc++_shared.so` replacing React Native's started on an
  API 35 emulator, ran its JavaScript (Hermes, Fabric) and drew the MapLibre map, while the
  Swift core in the same process set the Calgary route and matched five fixes.
- Linking the C++ runtime statically into the Swift side is not available with this SDK:
  `--static-swift-stdlib` still leaves `libc++_shared.so` in NEEDED.

**Recommendation:** the app ships NDK r30's `libc++_shared.so` (the one
`build-android-core.sh` copies into `jniLibs`). Because `pickFirst` order is not something to
rely on, the module that packages the core replaces the merged copy explicitly, for every
variant, after `merge<Variant>NativeLibs` (a few lines of Gradle in the config plugin). Building
the rest of the app with NDK r30 is not needed and would not help: the prebuilt React Native AAR
brings its own r27 copy either way.

## Size

Release, arm64-v8a, stripped, in bytes (uncompressed / deflate -9; AGP stores `.so` files
uncompressed by default, so the first column is what the APK grows by):

| Step                                                                |      Total |   Deflated |
| ------------------------------------------------------------------- | ---------: | ---------: |
| Spike (`libNavOSSNavigationJNI`, FoundationNetworking linked)       | 70,102,456 | 25,846,446 |
| This facade, FoundationNetworking linked                            | 70,346,904 | 25,960,413 |
| HTTP through the host (`NAVOSS_HOST_HTTP`), no FoundationNetworking | 66,864,096 | 24,475,222 |

`lib_FoundationICU.so` (40,042,536 / 15,614,315) is now 60 % of the set. Dropping it means
building the core against FoundationEssentials alone. A trial build of the Android subset with
`import FoundationEssentials` stopped at 214 errors in 22 files (only the first errors of each
file are reported), most in the CarPlay presentation and model files the navigation path
depends on (`CarPlayGuidancePresentation`, `CarPlayTrip`, `CarPlayDestinations`,
`CarPlayPreferences`), and the APIs it needs replaced or shimmed are broad: `trimmingCharacters`,
`NSRegularExpression`, `NSLock`/`NSRecursiveLock` (the engine's lock), `UserDefaults`,
`NotificationCenter`, `folding`, `Measurement`, `ISO8601DateFormatter`, `String(format:)` and
libm through `Android`. That is a refactor of iOS sources across most of the core, each
replacement needing tests against Foundation's behaviour, for about 49 MB uncompressed
(19.6 MB deflated). It is left for its own change; the measured inventory is in the pull request
that introduced this file.

## Package layout

One manifest, `apps/mobile/modules/navoss-navigation/Package.swift`, gated on the environment:

- Without `NAVOSS_ANDROID_CORE` it is the iOS core exactly as before (`ios/Core`, `ios/Tests`),
  which `test:native:ios` and the Xcode build use.
- With `NAVOSS_ANDROID_CORE=1` it builds the Android subset: `ios/Core` without the `Community*`
  and `Offline*` sources (CryptoKit, App Attest, Valhalla, SQLite), plus `android-core/Facade`
  in the same module (the facade drives the engine's internal API); the `CNavOSSJNI` and
  `NavOSSCoreJNI` targets (product `NavOSSCore`, a dynamic library); `ios/Tests` without the
  `Community*` / `Offline*` tests and `CarPlayCardTextTests` (offline fixtures); and
  `android-core/Tests` (facade tests, golden snapshots, the replay).

The subset is defined by exclusion, so a new Core file or test is built and run on Android
without touching the manifest; a test that cannot build there fails the build instead of being
skipped. A second manifest was rejected: SwiftPM cannot share one source file between two
packages without symlinks, which have to be maintained by hand and silently drop new tests.

## Build and packaging

- `apps/mobile/scripts/android-core-toolchain.env` pins every version and checksum.
- `apps/mobile/scripts/build-android-core.sh` builds the release `.so` set for `arm64-v8a` into
  `android-core/build/jniLibs/arm64-v8a` (Gradle `jniLibs`), strips it, and prints sizes and the
  NEEDED closure. It defines `NAVOSS_HOST_HTTP`, which leaves out the URLSession adapter and with it
  FoundationNetworking.
- `apps/mobile/scripts/run-android-core-tests.sh` runs both XCTest suites on a device or emulator.
- `android-core/binding` is a Gradle library project holding the Kotlin binding and its
  instrumented test (`connectedAndroidTest`), which replays the recorded Calgary trip through JNI
  and compares it with the committed macOS transcript.

### On a GitHub `ubuntu-latest` runner

Not yet a workflow; the steps are:

```sh
. apps/mobile/scripts/android-core-toolchain.env
curl -fsSLO "https://download.swift.org/swiftly/linux/swiftly-$(uname -m).tar.gz"
tar zxf "swiftly-$(uname -m).tar.gz" && ./swiftly init --quiet-shell-followup --skip-install -y
. "$HOME/.local/share/swiftly/env.sh" && swiftly install "$SWIFT_VERSION" --use
swift sdk install "$SWIFT_ANDROID_SDK_URL" --checksum "$SWIFT_ANDROID_SDK_SHA256"
curl -fsSLO "https://dl.google.com/android/repository/android-ndk-$ANDROID_NDK_RELEASE-linux.zip"
echo "$ANDROID_NDK_LINUX_SHA1  android-ndk-$ANDROID_NDK_RELEASE-linux.zip" | sha1sum -c
unzip -q "android-ndk-$ANDROID_NDK_RELEASE-linux.zip" && export ANDROID_NDK_HOME="$PWD/android-ndk-$ANDROID_NDK_RELEASE"
"$HOME/.swiftpm/swift-sdks/$SWIFT_ANDROID_SDK_ID.artifactbundle/swift-android/scripts/setup-android-sdk.sh"
apps/mobile/scripts/build-android-core.sh
```

swiftly verifies the toolchain's signature; the SDK and NDK are checked against the pinned
checksums. Expected time (not measured on a runner): toolchain about 3 minutes, SDK and NDK
downloads about 2 minutes, release build about 5 minutes on a 4-core runner; cache
`~/.local/share/swiftly`, `~/.swiftpm/swift-sdks` and the NDK by the pinned versions.
