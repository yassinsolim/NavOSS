## Native libraries in the Android app

The Android app carries the navigation core as `libNavOSSCore.so` (NavOSS's own code, MPL-2.0)
together with the prebuilt shared libraries it needs. They are copied unmodified, apart from
stripping symbols, by `apps/mobile/scripts/build-android-core.sh` from the Swift SDK for Android
and the Android NDK pinned in `apps/mobile/scripts/android-core-toolchain.env`. This section is
maintained by hand in `apps/mobile/modules/navoss-navigation/android-core/NOTICES.md`; update it
whenever that file's versions or the list of libraries the build prints change.

### Apache-2.0 WITH Swift-exception

The Swift project's licence: Apache License 2.0 with the Runtime Library Exception, as in the
Swift SDK for Android's own `swift-resources/usr/share/swift/LICENSE.txt`
(<https://swift.org/LICENSE.txt>). Copyright Apple Inc. and the Swift project authors.

- Swift standard library and runtime, Swift 6.4.3 - `libswiftCore.so`, `libswift_Concurrency.so`,
  `libswift_StringProcessing.so`, `libswift_RegexParser.so`, `libswiftObservation.so`,
  `libswiftSynchronization.so`, `libswift_Builtin_float.so`, `libswift_math.so`,
  `libswiftAndroid.so` - <https://github.com/swiftlang/swift>,
  <https://github.com/swiftlang/swift-experimental-string-processing>
- swift-corelibs-libdispatch - `libdispatch.so`, `libBlocksRuntime.so`, `libswiftDispatch.so` -
  <https://github.com/swiftlang/swift-corelibs-libdispatch>
- swift-corelibs-foundation - `libFoundation.so` -
  <https://github.com/swiftlang/swift-corelibs-foundation>
- swift-foundation - `libFoundationEssentials.so`, `libFoundationInternationalization.so` -
  <https://github.com/swiftlang/swift-foundation>
- swift-foundation-icu (the Swift project's packaging) - `lib_FoundationICU.so` -
  <https://github.com/swiftlang/swift-foundation-icu>

### Unicode-3.0

- ICU 76, International Components for Unicode, built into `lib_FoundationICU.so` - Copyright
  Unicode, Inc. - Unicode License v3, with the third-party notices listed in ICU's licence
  file (the Swift SDK ships no copy of it) -
  <https://github.com/unicode-org/icu/blob/release-76-1/LICENSE>

### Apache-2.0 WITH LLVM-exception

- LLVM libc++, libc++abi and libunwind, from Android NDK r30 - `libc++_shared.so` - Copyright
  the LLVM project contributors - as in the NDK's `NOTICE.toolchain`: Apache License 2.0 with
  LLVM Exceptions, and for older contributions the legacy LLVM licence (University of
  Illinois/NCSA or MIT, at the user's choice) - <https://llvm.org/LICENSE.txt>
