// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "NavOSSNavigationCoreAndroid",
  platforms: [
    .macOS(.v13)
  ],
  products: [
    .library(name: "NavOSSNavigationCore", targets: ["NavOSSNavigationCore"]),
    .executable(name: "NavOSSReplay", targets: ["NavOSSReplay"]),
    .library(name: "NavOSSNavigationJNI", type: .dynamic, targets: ["NavOSSNavigationJNI"]),
  ],
  targets: [
    .target(name: "NavOSSNavigationCore", path: "Sources/NavOSSNavigationCore"),
    .target(name: "CNavOSSJNI", path: "Sources/CNavOSSJNI"),
    .target(
      name: "NavOSSNavigationJNI",
      dependencies: ["NavOSSNavigationCore", "CNavOSSJNI"],
      path: "Sources/NavOSSNavigationJNI"
    ),
    .executableTarget(
      name: "NavOSSReplay",
      dependencies: ["NavOSSNavigationCore"],
      path: "Sources/NavOSSReplay"
    ),
    .testTarget(
      name: "NavOSSNavigationCoreTests",
      dependencies: ["NavOSSNavigationCore"],
      path: "Tests",
      resources: [.copy("Fixtures")]
    )
  ]
)
