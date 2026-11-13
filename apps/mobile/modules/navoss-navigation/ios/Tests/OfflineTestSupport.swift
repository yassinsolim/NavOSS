import Foundation
import XCTest

/// Fixtures under `Tests/Fixtures/Offline` are real artifacts: the manifest and Valhalla 3.9.1
/// responses were produced from offline bundle release `2026-11-11-v1-798f5c442644` (the engine
/// pinned in `infra/offline/routing-engine.lock.json`), and the search expectations were produced
/// by the pipeline's own `infra/offline/query-search.py`. OpenStreetMap data, ODbL 1.0.
enum OfflineFixtures {
  static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appending(path: "Fixtures/Offline", directoryHint: .isDirectory)

  static let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // OfflineTestSupport.swift
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // ios
    .deletingLastPathComponent()  // navoss-navigation
    .deletingLastPathComponent()  // modules
    .deletingLastPathComponent()  // mobile
    .deletingLastPathComponent()  // apps

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: directory.appending(path: name))
  }

  static func json(_ name: String) throws -> Any {
    try JSONSerialization.jsonObject(with: data(name))
  }

  /// A full release directory (`regions/calgary/{maps.pmtiles,routing.tar,search.sqlite}` and
  /// `resources.tar.gz`), when one has been copied locally. Large artifacts are never committed;
  /// tests that need them skip without one. Set `NAVOSS_OFFLINE_TEST_RELEASE` to point elsewhere.
  static func release() throws -> URL {
    let configured = ProcessInfo.processInfo.environment["NAVOSS_OFFLINE_TEST_RELEASE"]
    let url =
      configured.map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? repositoryRoot.appending(
        path: "artifacts/offline-test/releases/2026-11-11-v1-798f5c442644",
        directoryHint: .isDirectory)
    guard FileManager.default.fileExists(atPath: url.appending(path: "regions/calgary").path) else {
      throw XCTSkip("No local offline bundle release at \(url.path)")
    }
    return url
  }

  static func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(
      path: "navoss-offline-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
}
