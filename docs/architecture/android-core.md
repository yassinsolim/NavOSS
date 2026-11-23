# Android navigation core: the Swift ↔ Kotlin boundary

Status: contract v2 (`ABI_VERSION = 2`). Implemented by `apps/mobile/modules/navoss-navigation/android-core` (Swift
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

`NavOSSCore.ABI_VERSION = 2`. `nativeAbiVersion()` returns the Swift side's value; the Kotlin
binding compares it at class load and refuses to create an engine (`IllegalStateException`
naming both numbers) on a mismatch. The ABI version changes whenever a native function, a
callback, a JSON key or an error code changes meaning. The JS contract version (`version: 11` in
`getCapabilities`) is separate and is reported by `nativeContractVersion()` so the Expo module can
build its capabilities from the core it actually loaded.

Version 2 (review of the first implementation) changed, against version 1:

- `nativeClose(handle)` is new and `nativeDestroy(handle)` only releases memory; `close()` has
  defined waiting and re-entrancy rules ("Closing").
- A non-optional record field refuses an explicit `null`; integer fields round ("Set route").
- `cancelHttpRequest` is ordered after its `httpRequest` and is also sent by `close()` ("HTTP").
- Error messages no longer quote input; a trip or HTTP answer above 16 MiB is refused.

The Kotlin API (`NavOSSCore`'s methods and `Host`) has the same signatures as in version 1.

## Lifecycle and calls

All calls are synchronous: they return once the engine has applied the input. `handle` is the
opaque `Long` from `nativeCreate`; `0` is never a valid handle.

| Kotlin (`NavOSSCore`)              | JNI function (`native…`)                        | In                                       | Out              |
| ---------------------------------- | ----------------------------------------------- | ---------------------------------------- | ---------------- |
| `NavOSSCore(config, host)`         | `Create(configJson, host)`                      | config JSON, `Host`                      | handle           |
| `close()`                          | `Close(handle)`, later `Destroy(handle)`        |                                          |                  |
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
| explicit `null`                              | `nil` for an optional field; an error (`invalid-json`) for any other, as Expo's "required, got nil"      | decoding error                                                                                                   |
| `steps[].lanes[]`                            | keys `active`, `valid`, `validIndication`, `indications`; a list with any unknown arrow is dropped whole | same keys (Swift names them `isPreferred`, `isValid`, `activeIndication`); an unknown arrow fails the whole trip |
| `congestion`                                 | dropped whole if any level is unknown                                                                    | decoding error                                                                                                   |
| `traffic.oldestObservedAt`                   | ISO 8601 string, with or without fractional seconds                                                      | `Date` as seconds since 2001                                                                                     |
| `waypoints`                                  | `[]` means none                                                                                          | `null` means none                                                                                                |
| `destination.placeCategory`                  | not part of the record                                                                                   | optional                                                                                                         |
| `speedLimitsKph[]`, `steps[].roundaboutExit` | JS numbers (Kotlin maps hold `Double`), rounded to nearest, halves away from zero, as Expo does          | `Int`                                                                                                            |

So the Android module's only mapping is `JSONObject(map).toString()` of the record Expo hands it.
A trip that decodes but fails the core's validation (`NavOSSCarPlayTrip.isValid`) is an
`invalid-route` error, as on iOS.

Two differences from the iOS record remain, both stricter and both stated here rather than
silent:

- **A value that is not an array where an array is expected** (`geometry`, `steps`, `waypoints`,
  `congestion`, `speedLimitsKph`, `steps[].geometry`, `steps[].lanes`, `lanes[].indications`,
  `steps[].signpostBranch`, `steps[].signpostToward`): Expo wraps it into a one-element array;
  this boundary refuses it (`invalid-json`, "Wrong type at …"). The JS builders
  (`apps/mobile/src/features/navigation/native-navigation.ts`) only ever send arrays.
- **A number no `Int` can hold** in an integer field: Expo traps; this boundary refuses it.

The trip JSON may be at most 16 MiB of UTF-8 (`invalid-argument` above that).
`android-core/Tests/Golden/record-rules.json` lists every one of these cases (each field with
`null`, the rounding, the non-array forms) with the outcome the tests require.

### Update location: sample in, snapshot out

The sample is `NativeNavigationLocationSample`:
`{latitude, longitude, timestampMs, courseDegrees?, horizontalAccuracyMeters?, speedMetersPerSecond?}`.
`timestampMs` is milliseconds since the Unix epoch (`Location.getTime()`); a fix without it is
refused (`invalid-location`), as on iOS. Negative or unknown course, speed or accuracy must be
omitted, not sent as `-1`. `latitude` and `longitude` default to `0` when absent and are refused
when `null`, like the trip's fields.

A reroute's origin (`navOSSNavigationRouteOrigin`: heading, accuracy, age) comes on iOS from
the service's latest `CLLocation`. Here it comes from the matcher itself: `NavigationCore`
records the fix it last applied to the current route (`lastAppliedFix`), at the point where it
numbers an applied fix, under the engine lock. A fix it refuses (`invalid-location`) or ignores
(one not captured after the previous one: a duplicate, or an older one arriving late) is never
recorded, whatever threads the fixes arrive on, and the record is dropped inside the same
critical section that sets or clears a route, before any callback of that call runs. The facade
keeps no fix of its own. The origin's heading and accuracy are sent only when the recorded fix
is at the very coordinate being routed from.

Compared with iOS: the service keeps its latest location across a reroute install, the matcher
drops its record there. No request can tell the difference, because after an install the
snapshot has no raw coordinate and the engine requests a reroute only from one; the next applied
fix is recorded before anything is requested.

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
- **Order is not guaranteed.** Callbacks caused on different threads (a fix on the location
  thread, a reroute result on a Swift thread, a clock tick) are not serialized against each
  other, and each `onStateChanged` reads the state when it runs. Two snapshots can therefore
  arrive out of order, or carry the same state twice. Every snapshot has `stateVersion`, which
  only grows: a consumer keeps the snapshot with the highest `stateVersion` it has seen and drops
  an older one. The same holds for a snapshot returned by a call against one delivered by a
  callback.

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
(the trip was cleared or replaced, or the engine was closed); completing a cancelled or unknown
id is ignored. Bodies are UTF-8 JSON text. The base URL is the one given at creation.

Order and threads of the two calls, for one request id:

- `cancelHttpRequest(id)` is only ever called after `httpRequest(id, …)` has returned. A request
  cancelled before the host was given it is never given to it; one cancelled while
  `httpRequest` is running is cancelled on the same thread as soon as it returns.
- `cancelHttpRequest` is never called with the engine lock held. The engine cancels a reroute
  under its lock, so the host is told a moment later from a Swift thread, not from inside the
  call that cancelled (`clearRoute()` may return first). `close()` tells it on the closing thread
  before it returns.
- A cancel can cross the host's own answer: `cancelHttpRequest` for a request the host has just
  completed must be ignored.

**Size.** The host bounds what it reads from the network: it must stop reading and answer
`{"error":"unreachable"}` beyond its own cap. The boundary has its own ceiling as a second line: a
`responseJson` above 16 MiB of UTF-8 is refused unread and the request fails as an invalid
response. Arrays inside a trip or an answer are bounded only by that size.

**Trip storage: blobs through the host.** The core stores the active trip and its progress
checkpoint with the same records, keys, 12-hour expiry and checkpoint format as iOS
(`NavOSSActiveTripStore`), through `storageRead` / `storageWrite`. Keys today are
`org.navoss.mobile.active-navigation-trip.v2` and the same with `.progress`; values are opaque
JSON strings the host must store and return byte for byte (SharedPreferences `apply()` is
enough: reads after a write must see it, durability may lag). The trip blob is written when a trip
starts or a reroute is installed; the progress blob at most every fifteen seconds and on an
arrival-deferral change.

The app's host (`TripStorage.kt`) writes one file per key under `noBackupFilesDir` (temporary
file, sync, rename). A write that fails stays in memory and is retried, in order, before the next
write (the next checkpoint), so a durable progress record is never newer than its durable trip;
meanwhile the trip sheet says the trip is not saved. Staging files are deleted on failure and on
key deletion and swept at startup. While a simulated drive runs, the host writes nothing (a
trip it replaces is deleted), so a simulated route can never be restored as a real trip.

**HTTP in the app's host.** `apiBaseUrl` is the origin the JS bundle is built with
(`EXPO_PUBLIC_API_URL`, written to the manifest as `org.navoss.mobile.API_URL` by the config
plugin). `HttpTransport.kt` contacts only that origin (HTTPS, or HTTP on the loopback interface
for a local API), follows no redirects, fails a body over 8 MB as `unreachable`, and never sends a
request whose cancel arrived before it.

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
- No callback is called with a lock of the binding held.

### Closing

`close()` ends the engine for every thread:

1. From the moment it is called, every other call throws `NavOSSCoreException("closed")` without
   reaching native code. Calls already running finish against an engine that no longer calls
   back.
2. It cancels at the host every request the host still holds (`cancelHttpRequest`, on the
   closing thread).
3. It revokes the host: no callback starts after this point. The check and the count of running
   callbacks are one step, so a callback either began before and is waited for, or never runs.
4. It waits for callbacks running on other threads to return, then returns. So after `close()`
   returns, no callback is running and none will run.
5. The native memory is released when the last call that was using the handle has returned
   (usually at once; otherwise on that call's thread).

Two consequences for the host:

- **Do not call `close()` holding a lock a callback takes**, or from a thread a callback is
  waiting for: step 4 would wait for that callback forever.
- **`close()` from inside a callback is allowed and does not wait** (it cannot wait for the
  callback it is in, and two callbacks closing at once would wait for each other). Steps 1 to 3
  happen; callbacks already running, including the calling one, finish; the memory is released
  when the outermost call on that thread returns. The call that caused the callback still
  returns its result. "Inside a callback" means inside a callback of any engine in the
  process, tracked per thread: a callback of one engine may close another.

`close()` is idempotent. A second `close()` made while the first is still waiting returns at
once, before the first has finished.

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
| `internal`         | anything else, with the Swift error's type name                             |

The Expo module turns the exception into a rejected call, as the iOS module's `throws` does.
Malformed JSON from the host in `completeHttpRequest` is treated as `{"error":"unreachable"}`.

**Nothing from a payload is in a message or a log.** Messages are fixed text plus, for
`invalid-json`, the path of the field (`Wrong type at steps[0].lanes[0].valid`,
`Missing value at destination.latitude`, `Not JSON`); never a value, a mode string, a
coordinate or a parser's quotation of the input. The native layer writes one kind of line to
logcat (tag `NavOSSCore`): `Host callback <name> failed with a Java exception; it was cleared`.
It does not print the exception (`ExceptionDescribe` would print its message and stack, which
can quote a snapshot or a request). A host that wants its own exceptions logged catches them
inside its callback.

**JNI failures.** A JNI call that fails leaves a Java exception pending (`NewString`,
`GetStringChars` and `PushLocalFrame` an `OutOfMemoryError`). The native layer checks each one
and makes no further JNI call on that path except those permitted with an exception pending. An
entry point returns `null`/`0`/`false` and lets the exception reach its Kotlin caller (so a call
can throw `OutOfMemoryError` as well as `NavOSSCoreException`). A host callback is skipped, the
exception is cleared and the line above is logged; an exception thrown by the host's own method
is cleared the same way. A failing `storageRead` reads as no value and a failing `nowMs` as the
system clock.

## Memory and strings

- Strings cross as Java `String`s. Swift reads them with `GetStringChars` / `GetStringLength`
  (UTF-16) and returns them with `NewString`, never the "modified UTF-8" `…UTF` functions, so text
  outside the Basic Multilingual Plane (an emoji in a place name) survives both ways. Swift
  releases every `GetStringChars` buffer and local reference before returning; returned strings
  belong to the JVM.
- The handle is a retained Swift object; `nativeDestroy` releases it once. The binding counts the
  calls using the handle (`HandleGate`): a call takes it only while the engine is open, and it
  is released after `close()` once that count is zero, so no thread can pass a released handle
  to native code. The `Host` is held as a JNI global reference until the engine is deallocated.
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
| Contract v2 (review fixes; `libNavOSSCore.so` 1,259,568 / 509,360)  | 66,908,984 | 24,491,062 |

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
- `apps/mobile/scripts/run-android-core-tests.sh` runs both XCTest suites on a device or emulator. Give the
  emulator six cores: the engine tests hold requests by blocking Swift concurrency threads, and
  on a two-core emulator the pool runs out and the core suite stalls (the facade suite passes
  either way).
- `android-core/binding` is a Gradle library project holding the Kotlin binding
  (`NavOSSCore.kt`, `HandleGate.kt`, `NavOSSCoreException.kt`), a JVM test of the handle's
  lifetime rules (`testDebugUnitTest`) and the instrumented test (`connectedAndroidTest`), which
  replays the recorded Calgary trip through JNI, compares it with the committed macOS
  transcript, and exercises closing against running calls and callbacks. Run the instrumented
  test with CheckJNI on (`adb shell setprop debug.checkjni 1`).
- Third-party notices for the shipped Swift runtime, Foundation, ICU and libc++ libraries are in
  `android-core/NOTICES.md`, which `pnpm licenses:generate` appends to `THIRD_PARTY_NOTICES.md`.
  Update it with the toolchain pins.
- Every shipped `.so` must have 16 KB-aligned `LOAD` segments (`llvm-readelf -l`, alignment
  `0x4000`): Android 15 and later devices with 16 KB pages refuse anything else.

### In CI and releases

The composite action `.github/actions/build-android-core` is the one implementation both
`ci.yml` (job `Android build and Kotlin tests`) and `android-release.yml` call before Gradle. On
`ubuntu-latest` (Ubuntu 26.04, x86_64) it:

1. runs `android-core/scripts/jni-contract.py check`: the Kotlin binding's `external` functions
   and the Swift `@_cdecl` entry points must name the same JNI symbols, and every `Host` method
   the Swift side looks up (`GetMethodID`) must exist in `NavOSSCore.Host` with that signature;
2. restores `android-core/build/jniLibs` from the cache `android-core-libs-v1-…`, keyed on the
   pinned Swift version, toolchain and SDK checksums, NDK version, and a hash of
   `Package.swift`, `ios/Core/**`, `android-core/Facade/**`, `android-core/JNI/**`,
   `build-android-core.sh` and `android-core-toolchain.env`;
3. on a miss, restores the toolchain tarballs (cache `android-core-toolchain-v1-…`, keyed on the
   pins only, so a source change does not download them again), and
   `android-core/scripts/install-toolchain-linux.sh` checks each against its pinned SHA-256,
   extracts the toolchain, installs the SDK bundle, installs NDK r30 with `sdkmanager` and links
   it into the SDK; then `build-android-core.sh` builds;
4. always, cache hit or not, runs `android-core/scripts/verify-android-core.sh`, which fails on
   any ABI directory but `arm64-v8a`, a missing `libNavOSSCore.so`, a NEEDED library that is
   neither shipped nor one of Android's own (the NDK's API 28 stubs), a shipped library nothing
   needs, a Kotlin `external` not exported by `libNavOSSCore.so`, a `LOAD` segment aligned below
   16 KB, or a `libc++_shared.so` that lacks the symbol the config plugin checks for r30;
5. saves the libraries to the cache only after they passed.

After Gradle, `android-core/scripts/verify-apk-core.sh` checks an APK: every verified library is
packaged under `lib/arm64-v8a/` byte for byte (so the packaged `libc++_shared.so` is r30's, not
React Native's r27 copy), and `apkanalyzer dex packages` shows the binding class with every
native method, `NavOSSCore$Host` with every callback, and `NavOSSCoreException(String, String)`
under their own names (the list comes from the Kotlin `external` functions and from every
`FindClass` / `GetMethodID` the Swift JNI layer makes; `jni-contract.py check` fails on a lookup
kind it cannot attribute), plus the NavOSS classes the manifest names (Android instantiates those by name; the app's Expo
modules are referenced as classes, and R8 renames them harmlessly).
On a release APK that is the check that R8 neither stripped nor renamed them. The keep rules are
`modules/navoss-navigation/android/consumer-rules.pro`; without them R8 removed the `Host`
callbacks and `NavOSSCoreException` (CI run 45151549163), so `nativeCreate` would fail in every
release. CI runs it in two parallel legs, on a debug APK and on a release APK built with a throwaway
key generated in the job (the release signing plugin accepts any keystore named by its three
variables; the release workflow is what pins the certificate). The release workflow runs it on
the signed APK, and every check fails the run.

React Native keeps NDK r27 (`ndk;27.1.12297006`, installed by the workflows); the core and its
`libc++_shared.so` use r30, which the action installs and passes to the build as
`ANDROID_NDK_HOME` for that step only.

### Pins and how to bump them

Every pin is in `apps/mobile/scripts/android-core-toolchain.env`:

| Pin                            | Value                                                                     | Source                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SWIFT_VERSION`                | 6.4.3                                                                     | swift.org release                                                                                                                                      |
| `SWIFT_LINUX_TOOLCHAIN_URL`    | `…/ubuntu2604/swift-6.4.3-RELEASE/swift-6.4.3-RELEASE-ubuntu26.04.tar.gz` | swift.org download for the runner's Ubuntu                                                                                                             |
| `SWIFT_LINUX_TOOLCHAIN_SHA256` | `0e408a92…3045613`                                                        | computed 2026-11-23 from the download whose `.sig` verified against swift.org's keys (swift.org publishes a signature, not a checksum, for toolchains) |
| `SWIFT_ANDROID_SDK_SHA256`     | `a78839ed…71f0a9`                                                         | published by swift.org on <https://www.swift.org/install/linux/>                                                                                       |
| `ANDROID_NDK_VERSION`          | 30.0.16248370                                                             | installed by `sdkmanager`, which checks Google's own checksum                                                                                          |

To bump the toolchain: change `SWIFT_VERSION`, the URLs and the SDK ID; take the SDK checksum
from swift.org's install page; for the Linux toolchain, download the tarball and its `.sig`,
verify it (`gpg --import` <https://www.swift.org/keys/all-keys.asc> (served gzip-encoded:
`curl --compressed`), then `gpg --verify`) and pin `sha256sum` of the verified file. When
GitHub moves `ubuntu-latest` to another Ubuntu, `install-toolchain-linux.sh` stops with a
message naming both versions: pin the toolchain built for the new one
(`SWIFT_LINUX_OS_VERSION`, URL, checksum). Every pin is part of both cache keys, so a bump
rebuilds. Update `android-core/NOTICES.md` with the pins.

Locally, the macOS steps (swiftly, `swift sdk install … --checksum`, the NDK zip with its SHA-1)
are unchanged; `build-android-core.sh` runs on both hosts.
