import XCTest

@testable import NavOSSNavigationCore

/// Extraction is exercised with archives written by the system `tar`/`gzip` and by a minimal
/// independent ustar writer for hostile members the system tools refuse to create.
final class OfflineArchiveTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = try OfflineFixtures.temporaryDirectory()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func run(_ tool: String, _ arguments: [String], in cwd: URL) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    process.currentDirectoryURL = cwd
    // No AppleDouble `._` members for extended attributes.
    process.environment = ["COPYFILE_DISABLE": "1"]
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0, "\(tool) \(arguments)")
  }

  private func gzip(_ tar: Data) throws -> URL {
    let tarURL = directory.appending(path: "hostile-\(UUID().uuidString).tar")
    try tar.write(to: tarURL)
    try run("/usr/bin/gzip", ["-n", tarURL.path], in: directory)
    return URL(fileURLWithPath: tarURL.path + ".gz")
  }

  /// One ustar member with a correct checksum.
  private func member(_ name: String, type: Character, contents: Data = Data(), link: String = "")
    -> Data
  {
    var header = [UInt8](repeating: 0, count: 512)
    func put(_ string: String, _ offset: Int, _ length: Int) {
      for (index, byte) in string.utf8.prefix(length).enumerated() { header[offset + index] = byte }
    }
    put(name, 0, 100)
    put("0000644", 100, 8)
    put(String(format: "%011o", contents.count), 124, 12)
    put("00000000000", 136, 12)
    put(String(type), 156, 1)
    put(link, 157, 100)
    put("ustar", 257, 6)
    put("00", 263, 2)
    for index in 148..<156 { header[index] = 32 }
    let checksum = header.reduce(0) { $0 + Int($1) }
    put(String(format: "%06o", checksum) + "\0 ", 148, 8)
    var data = Data(header) + contents
    data.append(Data(count: (512 - contents.count % 512) % 512))
    return data
  }

  private func archive(_ members: [Data]) -> Data {
    members.reduce(Data(), +) + Data(count: 1024)
  }

  func testExtractsASystemTarWithNestedNamesAndSpaces() throws {
    let source = directory.appending(path: "src", directoryHint: .isDirectory)
    let glyphs = source.appending(path: "glyphs/Noto Sans Regular", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: glyphs, withIntermediateDirectories: true)
    let pbf = Data((0..<70_000).map { UInt8($0 % 251) })
    try pbf.write(to: glyphs.appending(path: "0-255.pbf"))
    try Data("{}".utf8).write(to: source.appending(path: "routing-config.json"))
    try Data().write(to: source.appending(path: "empty.txt"))
    let archiveURL = directory.appending(path: "resources.tar.gz")
    try run("/usr/bin/tar", ["-czf", archiveURL.path, "-C", source.path, "."], in: directory)

    let destination = directory.appending(path: "out", directoryHint: .isDirectory)
    let written = try navOSSExtractTarGzip(
      archive: archiveURL, destination: destination, maximumBytes: 1_000_000)
    XCTAssertEqual(written, Int64(pbf.count + 2))
    XCTAssertEqual(
      try Data(contentsOf: destination.appending(path: "glyphs/Noto Sans Regular/0-255.pbf")), pbf)
    XCTAssertEqual(
      try Data(contentsOf: destination.appending(path: "routing-config.json")), Data("{}".utf8))
  }

  func testRefusesTraversalAbsoluteAndLinkMembers() throws {
    let hostile: [(String, Data)] = [
      ("traversal", archive([member("../escape.txt", type: "0", contents: Data("x".utf8))])),
      ("nested traversal", archive([member("a/../../escape.txt", type: "0")])),
      ("absolute", archive([member("/tmp/escape.txt", type: "0")])),
      ("symlink", archive([member("styles", type: "2", link: "/etc")])),
      ("hardlink", archive([member("a.json", type: "1", link: "b.json")])),
      ("fifo", archive([member("pipe", type: "6")])),
    ]
    for (name, data) in hostile {
      let destination = directory.appending(path: "out-\(UUID().uuidString)", directoryHint: .isDirectory)
      XCTAssertThrowsError(
        try navOSSExtractTarGzip(archive: try gzip(data), destination: destination, maximumBytes: 1_000),
        name)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: directory.appending(path: "escape.txt").path), name)
    }
  }

  func testStopsAtTheSizeLimitAndOnTruncation() throws {
    let big = archive([member("big.bin", type: "0", contents: Data(count: 5_000))])
    XCTAssertThrowsError(
      try navOSSExtractTarGzip(
        archive: try gzip(big), destination: directory.appending(path: "a"), maximumBytes: 4_000)
    ) { error in
      XCTAssertEqual(error as? NavOSSOfflineArchiveError, .sizeLimitExceeded)
    }
    let gz = try Data(contentsOf: try gzip(big))
    let truncated = directory.appending(path: "truncated.tar.gz")
    try gz.prefix(gz.count / 2).write(to: truncated)
    XCTAssertThrowsError(
      try navOSSExtractTarGzip(
        archive: truncated, destination: directory.appending(path: "b"), maximumBytes: 10_000))
    let notGzip = directory.appending(path: "plain.tar")
    try big.write(to: notGzip)
    XCTAssertThrowsError(
      try navOSSExtractTarGzip(
        archive: notGzip, destination: directory.appending(path: "c"), maximumBytes: 10_000)
    ) { error in
      XCTAssertEqual(error as? NavOSSOfflineArchiveError, .notGzip)
    }
  }

  /// The real shared resources artifact, when a release is available locally.
  func testExtractsTheRealResourcesArtifact() throws {
    let release = try OfflineFixtures.release()
    let destination = directory.appending(path: "resources", directoryHint: .isDirectory)
    let written = try navOSSExtractTarGzip(
      archive: release.appending(path: "resources.tar.gz"), destination: destination,
      maximumBytes: 105_001_070)
    XCTAssertEqual(written, 105_001_070)
    for path in [
      "styles/liberty.json", "styles/dark.json", "sprites/ofm@2x.png", "search-query.sql",
      "glyphs/Noto Sans Bold/0-255.pbf", "routing-config.json", "search-normalization.json",
    ] {
      XCTAssertTrue(FileManager.default.fileExists(atPath: destination.appending(path: path).path), path)
    }
  }
}

final class OfflineMapStyleTests: XCTestCase {
  private let maps = URL(
    fileURLWithPath: "/var/mobile/Application Support/NavOSSOffline/regions/calgary/v/maps.pmtiles")
  private let resources = URL(
    fileURLWithPath: "/var/mobile/Application Support/NavOSSOffline/shared/abc", isDirectory: true)

  private func styleData(sources: [String: Any]? = nil, glyphs: String? = nil) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "version": 8,
      "sources": sources ?? ["openmaptiles": ["type": "vector", "url": "pmtiles://maps.pmtiles"]],
      "glyphs": glyphs ?? "./glyphs/{fontstack}/{range}.pbf",
      "sprite": "./sprites/ofm",
      "layers": [["id": "background", "type": "background"]],
    ])
  }

  func testBindsToEncodedLocalFileURLsLikeTheReferenceBinder() throws {
    let bound = try navOSSBindOfflineStyle(styleData(), mapsFile: maps, resourcesRoot: resources)
    let style = try XCTUnwrap(JSONSerialization.jsonObject(with: bound) as? [String: Any])
    let source = try XCTUnwrap((style["sources"] as? [String: Any])?["openmaptiles"] as? [String: Any])
    XCTAssertEqual(
      source["url"] as? String,
      "pmtiles://file:///var/mobile/Application%20Support/NavOSSOffline/regions/calgary/v/maps.pmtiles")
    XCTAssertEqual(
      style["glyphs"] as? String,
      "file:///var/mobile/Application%20Support/NavOSSOffline/shared/abc/glyphs/{fontstack}/{range}.pbf")
    XCTAssertEqual(
      style["sprite"] as? String,
      "file:///var/mobile/Application%20Support/NavOSSOffline/shared/abc/sprites/ofm")
    XCTAssertFalse(String(decoding: bound, as: UTF8.self).contains("http"))
  }

  func testRefusesStylesThatWouldReachTheNetwork() throws {
    XCTAssertThrowsError(
      try navOSSBindOfflineStyle(
        styleData(sources: ["openmaptiles": ["type": "vector", "url": "https://tiles.openfreemap.org/planet"]]),
        mapsFile: maps, resourcesRoot: resources))
    XCTAssertThrowsError(
      try navOSSBindOfflineStyle(
        styleData(sources: [
          "openmaptiles": ["type": "vector", "url": "pmtiles://maps.pmtiles"],
          "ne2_shaded": ["type": "raster", "url": "https://tiles.openfreemap.org/natural_earth"],
        ]),
        mapsFile: maps, resourcesRoot: resources))
    XCTAssertThrowsError(
      try navOSSBindOfflineStyle(
        styleData(glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"),
        mapsFile: maps, resourcesRoot: resources))
  }

  func testBindsEveryRealBundleStyle() throws {
    let release = try OfflineFixtures.release()
    let resourcesRoot = try OfflineFixtures.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: resourcesRoot) }
    try FileManager.default.removeItem(at: resourcesRoot)
    try navOSSExtractTarGzip(
      archive: release.appending(path: "resources.tar.gz"), destination: resourcesRoot,
      maximumBytes: 200_000_000)
    for slug in navOSSOfflineStyleSlugs {
      let data = try Data(contentsOf: resourcesRoot.appending(path: "styles/\(slug).json"))
      let bound = try navOSSBindOfflineStyle(
        data, mapsFile: release.appending(path: "regions/calgary/maps.pmtiles"),
        resourcesRoot: resourcesRoot)
      // Attribution keeps its hyperlinks; nothing the renderer fetches may be remote.
      let style = try XCTUnwrap(JSONSerialization.jsonObject(with: bound) as? [String: Any])
      let sources = try XCTUnwrap(style["sources"] as? [String: [String: Any]])
      XCTAssertEqual(Array(sources.keys), ["openmaptiles"], slug)
      XCTAssertTrue((sources["openmaptiles"]?["url"] as? String)?.hasPrefix("pmtiles://file:///") == true)
      XCTAssertTrue((style["glyphs"] as? String)?.hasPrefix("file:///") == true, slug)
      XCTAssertTrue((style["sprite"] as? String)?.hasPrefix("file:///") == true, slug)
      XCTAssertFalse(String(decoding: bound, as: UTF8.self).contains("openfreemap"), slug)
    }
  }
}
