import XCTest

@testable import NavOSSNavigationCore

final class OfflineManifestTests: XCTestCase {
  private func manifestObject() throws -> [String: Any] {
    try XCTUnwrap(OfflineFixtures.json("manifest-2026-11-11.json") as? [String: Any])
  }

  private func parse(_ object: Any) throws -> NavOSSOfflineManifest {
    try NavOSSOfflineManifest.parse(JSONSerialization.data(withJSONObject: object))
  }

  private func mutated(_ change: (inout [String: Any]) -> Void) throws -> [String: Any] {
    var object = try manifestObject()
    change(&object)
    return object
  }

  private func mutatedRegion(_ change: (inout [String: Any]) -> Void) throws -> [String: Any] {
    try mutated { object in
      var regions = object["regions"] as! [[String: Any]]
      change(&regions[0])
      object["regions"] = regions
    }
  }

  private func mutatedArtifact(_ key: String, _ change: (inout [String: Any]) -> Void) throws
    -> [String: Any]
  {
    try mutatedRegion { region in
      var artifacts = region["artifacts"] as! [String: Any]
      var artifact = artifacts[key] as! [String: Any]
      change(&artifact)
      artifacts[key] = artifact
      region["artifacts"] = artifacts
    }
  }

  func testParsesTheRealGeneratedManifest() throws {
    let manifest = try NavOSSOfflineManifest.parse(OfflineFixtures.data("manifest-2026-11-11.json"))
    XCTAssertEqual(manifest.bundleVersion, "2026-11-11-v1-798f5c442644")
    XCTAssertEqual(manifest.graph.routingEngineVersion, "3.9.1")
    XCTAssertEqual(manifest.regions.map(\.id), ["alberta", "calgary"])
    let calgary = try XCTUnwrap(manifest.region(id: "calgary"))
    XCTAssertEqual(calgary.maps.byteSize, 38_084_635)
    XCTAssertEqual(calgary.routing.byteSize, 99_164_160)
    XCTAssertEqual(calgary.search.byteSize, 147_111_936)
    XCTAssertEqual(calgary.resources.artifact.byteSize, 61_597_437)
    XCTAssertEqual(calgary.regionDownloadBytes, 284_360_731)
    XCTAssertEqual(
      calgary.bounds,
      NavOSSOfflineBounds(
        west: -114.94061159290979, south: 50.46917701586312, east: -113.10938840709025,
        north: 51.68142625124934))
    XCTAssertFalse(calgary.attribution.isEmpty)
    // Coverage comes from the polygon, not the bounding box.
    XCTAssertTrue(calgary.covers(NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0631)))
    XCTAssertFalse(calgary.covers(NavOSSCarPlayCoordinate(latitude: 53.5461, longitude: -113.4938)))
    XCTAssertTrue(
      try XCTUnwrap(manifest.region(id: "alberta")).covers(
        NavOSSCarPlayCoordinate(latitude: 53.5461, longitude: -113.4938)))
  }

  func testRefusesNewerSchemaContractOrEngineAsUnsupported() throws {
    let cases: [[String: Any]] = [
      try mutated { $0["schemaVersion"] = 2 },
      try mutated { $0["minimumAppContractVersion"] = 2 },
      try mutated { object in
        var graph = object["graph"] as! [String: Any]
        graph["routingEngineVersion"] = "3.10.0"
        object["graph"] = graph
      },
      try mutatedArtifact("routing") { $0["tileFormatVersion"] = "3.10.0" },
      try mutatedArtifact("routing") { $0["formatVersion"] = 2 },
      try mutatedArtifact("search") { $0["schemaVersion"] = 2 },
      try mutatedArtifact("maps") { $0["formatVersion"] = 4 },
      try mutatedArtifact("resources") { $0["schemaVersion"] = 2 },
    ]
    for object in cases {
      XCTAssertThrowsError(try parse(object)) { error in
        guard case .unsupported = error as? NavOSSOfflineManifestError else {
          return XCTFail("expected unsupported, got \(error)")
        }
      }
    }
  }

  func testRejectsMalformedManifests() throws {
    let cases: [(String, [String: Any])] = [
      ("unknown key", try mutated { $0["extra"] = true }),
      ("unknown region key", try mutatedRegion { $0["extra"] = 1 }),
      ("missing graph", try mutated { $0.removeValue(forKey: "graph") }),
      ("inverted bounds", try mutatedRegion { $0["bounds"] = [-113, 51, -114, 50] }),
      (
        "bounds exclude polygon",
        try mutatedRegion { $0["bounds"] = [-114.5, 50.9, -113.9, 51.2] }
      ),
      ("uppercase hash", try mutatedArtifact("maps") { $0["sha256"] = String(repeating: "A", count: 64) }),
      ("zero bytes", try mutatedArtifact("maps") { $0["byteSize"] = 0 }),
      ("fractional bytes", try mutatedArtifact("maps") { $0["byteSize"] = 1.5 }),
      ("http remote url", try mutatedArtifact("maps") { $0["url"] = "http://example.com/maps.pmtiles" }),
      ("query token", try mutatedArtifact("maps") { $0["url"] = "https://example.com/m.pmtiles?sig=1" }),
      ("credentials", try mutatedArtifact("maps") { $0["url"] = "https://u:p@example.com/m.pmtiles" }),
      ("mixed graph", try mutatedArtifact("routing") { $0["graphId"] = String(repeating: "0", count: 64) }),
      ("mixed date", try mutatedRegion { $0["dataDate"] = "2026-11-10" }),
      ("bad region id", try mutatedRegion { $0["id"] = "../calgary" }),
      ("open ring", try mutatedRegion { region in
        region["polygon"] = [
          "type": "MultiPolygon",
          "coordinates": [[[[-114, 51], [-113, 51], [-113, 52], [-114, 52]]]],
        ]
      }),
      ("styles", try mutatedArtifact("resources") { $0["styles"] = ["liberty"] }),
      ("timestamp date", try mutated { $0["osmTimestamp"] = "2026-11-10T21:22:47Z" }),
      (
        "duplicate region",
        try mutated { object in
          let regions = object["regions"] as! [[String: Any]]
          object["regions"] = [regions[1], regions[1]]
        }
      ),
    ]
    for (name, object) in cases {
      XCTAssertThrowsError(try parse(object), name) { error in
        guard case .malformed = error as? NavOSSOfflineManifestError else {
          return XCTFail("\(name): expected malformed, got \(error)")
        }
      }
    }
    XCTAssertThrowsError(try NavOSSOfflineManifest.parse(Data("{".utf8)))
  }

  func testAcceptsLoopbackHttpOnlyForLocalVerification() throws {
    for url in ["http://127.0.0.1:3023/a/maps.pmtiles", "http://localhost/maps.pmtiles"] {
      XCTAssertNoThrow(try parse(try mutatedArtifact("maps") { $0["url"] = url }), url)
    }
    XCTAssertNoThrow(
      try parse(try mutatedArtifact("maps") { $0["url"] = "https://cdn.example.org/r/maps.pmtiles" }))
  }
}
