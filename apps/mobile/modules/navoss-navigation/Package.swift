// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "NavOSSNavigationCore",
  platforms: [
    .iOS(.v16),
    .macOS(.v13)
  ],
  products: [
    .library(name: "NavOSSNavigationCore", targets: ["NavOSSNavigationCore"])
  ],
  targets: [
    .target(name: "NavOSSNavigationCore", path: "ios/Core"),
    .testTarget(
      name: "NavOSSNavigationCoreTests",
      dependencies: ["NavOSSNavigationCore"],
      path: "ios/Tests"
    )
  ]
)