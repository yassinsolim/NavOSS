// swift-tools-version: 5.9

import Foundation
import PackageDescription

// `NAVOSS_ANDROID_CORE=1` selects the Android subset of the navigation core
// (docs/architecture/android-core.md): the community sources (CryptoKit, App Attest) and the
// offline sources (Valhalla, SQLite) are left out, and the JSON facade, its JNI layer and their
// tests are added. Without it the package is the iOS core exactly as the Xcode build and
// `test:native:ios` use it.
//
// The subset is defined by exclusion, so a new Core source or test file is built and run on
// Android automatically; only the files named here are left out.
let androidCore = Context.environment["NAVOSS_ANDROID_CORE"] == "1"

/// Families that do not build on Android, by file name prefix, in `ios/Core` and `ios/Tests`.
let androidExcludedPrefixes = ["Community", "Offline"]
/// Tests that need excluded sources or fixtures without carrying their prefix.
let androidExcludedTests: Set<String> = [
  // Decodes offline Valhalla fixtures with the offline route decoder.
  "CarPlayCardTextTests.swift"
]

func androidExcluded(in directory: String, keeping extra: Set<String> = []) -> [String] {
  let path = Context.packageDirectory + "/" + directory
  let names = (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
  return names.filter { name in
    name.hasSuffix(".swift")
      && (androidExcludedPrefixes.contains { name.hasPrefix($0) } || extra.contains(name))
  }.sorted()
}

/// Everything under the package root except `kept` (and the directories leading to them), for a
/// target rooted at the package root that builds only some of its directories.
func excludingAllBut(_ kept: [String]) -> [String] {
  func entries(_ directory: String) -> [String] {
    let path = directory.isEmpty ? Context.packageDirectory : Context.packageDirectory + "/" + directory
    let names = (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
    return names.filter { !$0.hasPrefix(".") }.map { directory.isEmpty ? $0 : directory + "/" + $0 }
  }
  func walk(_ directory: String) -> [String] {
    entries(directory).flatMap { entry -> [String] in
      if kept.contains(entry) { return [] }
      if kept.contains(where: { $0.hasPrefix(entry + "/") }) { return walk(entry) }
      return [entry]
    }
  }
  return walk("").sorted()
}

let package: Package

if androidCore {
  package = Package(
    name: "NavOSSNavigationCore",
    platforms: [.macOS(.v13)],
    products: [
      .library(name: "NavOSSNavigationCore", targets: ["NavOSSNavigationCore"]),
      .library(name: "NavOSSCore", type: .dynamic, targets: ["NavOSSCoreJNI"]),
    ],
    targets: [
      // One module, so the facade can drive the engine's internal API.
      .target(
        name: "NavOSSNavigationCore",
        path: ".",
        exclude: excludingAllBut(["ios/Core", "android-core/Facade"])
          + androidExcluded(in: "ios/Core").map { "ios/Core/" + $0 },
        sources: ["ios/Core", "android-core/Facade"]
      ),
      .target(name: "CNavOSSJNI", path: "android-core/JNI/CNavOSSJNI"),
      .target(
        name: "NavOSSCoreJNI",
        dependencies: ["NavOSSNavigationCore", "CNavOSSJNI"],
        path: "android-core/JNI/NavOSSCoreJNI"
      ),
      .testTarget(
        name: "NavOSSNavigationCoreTests",
        dependencies: ["NavOSSNavigationCore"],
        path: "ios/Tests",
        exclude: androidExcluded(in: "ios/Tests", keeping: androidExcludedTests),
        resources: [.copy("Fixtures")]
      ),
      .testTarget(
        name: "NavOSSCoreFacadeTests",
        dependencies: ["NavOSSNavigationCore"],
        path: "android-core/Tests",
        resources: [.copy("Golden"), .copy("Fixtures")]
      ),
    ]
  )
} else {
  package = Package(
    name: "NavOSSNavigationCore",
    platforms: [
      .iOS(.v16),
      .macOS(.v13),
    ],
    products: [
      .library(name: "NavOSSNavigationCore", targets: ["NavOSSNavigationCore"])
    ],
    targets: [
      .target(name: "NavOSSNavigationCore", path: "ios/Core"),
      .testTarget(
        name: "NavOSSNavigationCoreTests",
        dependencies: ["NavOSSNavigationCore"],
        path: "ios/Tests",
        resources: [.copy("Fixtures")]
      ),
    ]
  )
}
