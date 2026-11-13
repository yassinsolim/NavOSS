import Foundation

// Pure installation model for offline regions: the per-region download state machine, the
// on-disk layout from `docs/architecture/offline.md`, the persisted active snapshot, storage
// budgeting and coverage. File I/O and networking live in the app module; everything here is
// deterministic so it can be tested with `swift test`.

// MARK: - State machine

public enum NavOSSOfflineFailure: Error, Codable, Equatable, Sendable {
  /// Not enough free space for the download plus installation.
  case insufficientStorage(requiredBytes: Int64, availableBytes: Int64)
  /// The transfer failed; the partial bytes are kept for a later resume.
  case network
  /// The server answered with something other than the expected bytes.
  case server(statusCode: Int)
  /// A downloaded file did not match the manifest's byte count or SHA-256.
  case integrity
  /// The bundle uses a format or version this app cannot read.
  case unsupported
  /// The files were downloaded but could not be installed (extraction, validation, disk).
  case installation
}

public enum NavOSSOfflineActivity: Codable, Equatable, Sendable {
  case idle
  case queued
  case downloading(receivedBytes: Int64, totalBytes: Int64)
  case paused(receivedBytes: Int64, totalBytes: Int64)
  case verifying
  case installing
  case failed(NavOSSOfflineFailure, receivedBytes: Int64, totalBytes: Int64)
}

public enum NavOSSOfflineEvent: Equatable, Sendable {
  case request
  case start(totalBytes: Int64, receivedBytes: Int64)
  case progress(receivedBytes: Int64)
  case pause
  case downloaded
  case verified
  case installed
  case fail(NavOSSOfflineFailure)
  case cancel
}

/// Applies `event` to `activity`. Returns `nil` for a transition that is not allowed, which the
/// store ignores: for example progress after a pause, or a pause after verification started.
public func navOSSOfflineTransition(
  _ activity: NavOSSOfflineActivity,
  _ event: NavOSSOfflineEvent
) -> NavOSSOfflineActivity? {
  switch (activity, event) {
  case (.idle, .request), (.paused, .request), (.failed, .request):
    return .queued
  case (.queued, .start(let total, let received)):
    guard total > 0, (0...total).contains(received) else { return nil }
    return .downloading(receivedBytes: received, totalBytes: total)
  case (.downloading(_, let total), .progress(let received)):
    guard (0...total).contains(received) else { return nil }
    return .downloading(receivedBytes: received, totalBytes: total)
  case (.downloading(let received, let total), .pause):
    return .paused(receivedBytes: received, totalBytes: total)
  case (.queued, .pause):
    return .idle
  case (.downloading(let received, let total), .downloaded):
    guard received == total else { return nil }
    return .verifying
  case (.verifying, .verified):
    return .installing
  case (.installing, .installed):
    return .idle
  case (.queued, .fail(let failure)):
    return .failed(failure, receivedBytes: 0, totalBytes: 0)
  case (.downloading(let received, let total), .fail(let failure)):
    return .failed(failure, receivedBytes: received, totalBytes: total)
  case (.verifying, .fail(let failure)), (.installing, .fail(let failure)):
    // Verification and installation failures discard the bytes; a retry starts over.
    return .failed(failure, receivedBytes: 0, totalBytes: 0)
  case (.queued, .cancel), (.downloading, .cancel), (.paused, .cancel), (.failed, .cancel):
    return .idle
  default:
    return nil
  }
}

extension NavOSSOfflineActivity {
  /// Whether the region holds the download queue or the disk.
  public var isBusy: Bool {
    switch self {
    case .queued, .downloading, .verifying, .installing: true
    case .idle, .paused, .failed: false
    }
  }
}

// MARK: - Layout

/// `Application Support/NavOSSOffline/...` paths. Every path component that comes from the
/// manifest is validated by the manifest parser (region IDs, bundle versions, hashes).
public struct NavOSSOfflineLayout: Equatable, Sendable {
  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  public var activeSnapshot: URL { root.appending(path: "active.json") }
  public var stagingRoot: URL { root.appending(path: "staging", directoryHint: .isDirectory) }
  public var regionsRoot: URL { root.appending(path: "regions", directoryHint: .isDirectory) }
  public var sharedRoot: URL { root.appending(path: "shared", directoryHint: .isDirectory) }
  public var boundStylesRoot: URL {
    root.appending(path: "bound-styles", directoryHint: .isDirectory)
  }

  public func staging(bundleVersion: String, regionId: String) -> URL {
    stagingRoot.appending(path: bundleVersion, directoryHint: .isDirectory)
      .appending(path: regionId, directoryHint: .isDirectory)
  }

  public func stagingResources(sha256: String) -> URL {
    stagingRoot.appending(path: "resources-\(sha256).tar.gz")
  }

  public func region(regionId: String, bundleVersion: String) -> URL {
    regionsRoot.appending(path: regionId, directoryHint: .isDirectory)
      .appending(path: bundleVersion, directoryHint: .isDirectory)
  }

  public func shared(resourcesSha256: String) -> URL {
    sharedRoot.appending(path: resourcesSha256, directoryHint: .isDirectory)
  }
}

public enum NavOSSOfflineFile: String, CaseIterable, Sendable {
  case maps = "maps.pmtiles"
  case routing = "routing.tar"
  case search = "search.sqlite"

  public func artifact(in region: NavOSSOfflineRegion) -> NavOSSOfflineArtifact {
    switch self {
    case .maps: region.maps
    case .routing: region.routing
    case .search: region.search
    }
  }
}

// MARK: - Active snapshot

public struct NavOSSOfflineInstalledRegion: Codable, Equatable, Sendable {
  /// The manifest record the files were installed from, kept so coverage, attribution and
  /// update checks work without a network.
  public let region: NavOSSOfflineRegion
  public let bundleVersion: String
  public let graphId: String
  public let osmTimestamp: String
  public let installedAt: Date

  public init(
    region: NavOSSOfflineRegion,
    bundleVersion: String,
    graphId: String,
    osmTimestamp: String,
    installedAt: Date
  ) {
    self.region = region
    self.bundleVersion = bundleVersion
    self.graphId = graphId
    self.osmTimestamp = osmTimestamp
    self.installedAt = installedAt
  }

  public var installedBytes: Int64 {
    region.regionDownloadBytes
  }
}

/// `active.json`: the set of installed regions phone and CarPlay read from. Replaced atomically.
public struct NavOSSOfflineActiveSnapshot: Codable, Equatable, Sendable {
  public static let currentSchemaVersion = 1

  public var schemaVersion: Int
  public var regions: [NavOSSOfflineInstalledRegion]

  public init(regions: [NavOSSOfflineInstalledRegion] = []) {
    schemaVersion = Self.currentSchemaVersion
    self.regions = regions
  }

  public func installed(regionId: String) -> NavOSSOfflineInstalledRegion? {
    regions.first { $0.region.id == regionId }
  }

  /// Replaces or adds `installed`, keeping regions ordered by ID.
  public func installing(_ installed: NavOSSOfflineInstalledRegion) -> Self {
    var next = self
    next.regions.removeAll { $0.region.id == installed.region.id }
    next.regions.append(installed)
    next.regions.sort { $0.region.id < $1.region.id }
    return next
  }

  public func removing(regionId: String) -> Self {
    var next = self
    next.regions.removeAll { $0.region.id == regionId }
    return next
  }

  /// Resource hashes still referenced by an installed region.
  public var referencedResources: Set<String> {
    Set(regions.map(\.region.resources.artifact.sha256))
  }

  /// Bytes of installed region files plus each referenced resource set once (unpacked).
  public var storageBytes: Int64 {
    var resources: [String: Int64] = [:]
    for installed in regions {
      resources[installed.region.resources.artifact.sha256] =
        installed.region.resources.unpackedByteSize
    }
    return regions.reduce(0) { $0 + $1.installedBytes } + resources.values.reduce(0, +)
  }
}

// MARK: - Budget

/// Bytes a region install needs on disk beyond what is already there: the region's remaining
/// downloads, the shared resources archive and its unpacked files when not yet installed, and
/// a filesystem margin. Staged files are renamed into place on the same volume, so an install
/// never needs a second copy; the previously active version stays until the new one is ready.
public func navOSSOfflineRequiredBytes(
  region: NavOSSOfflineRegion,
  alreadyDownloadedBytes: Int64,
  resourcesInstalled: Bool
) -> Int64 {
  var bytes = max(0, region.regionDownloadBytes - alreadyDownloadedBytes)
  if !resourcesInstalled {
    bytes += region.resources.artifact.byteSize + region.resources.unpackedByteSize
  }
  let margin = max(64 * 1_048_576, bytes / 50)
  return bytes + margin
}

// MARK: - Coverage

/// Ray-casting point-in-polygon over a GeoJSON MultiPolygon in degrees. Holes (inner rings)
/// exclude their area.
public func navOSSOfflinePolygonContains(
  _ polygon: [[[NavOSSCarPlayCoordinate]]],
  _ point: NavOSSCarPlayCoordinate
) -> Bool {
  polygon.contains { rings in
    guard let outer = rings.first, ringContains(outer, point) else { return false }
    return !rings.dropFirst().contains { ringContains($0, point) }
  }
}

private func ringContains(_ ring: [NavOSSCarPlayCoordinate], _ point: NavOSSCarPlayCoordinate)
  -> Bool
{
  var inside = false
  var previous = ring.count - 1
  for index in ring.indices {
    let a = ring[index]
    let b = ring[previous]
    if (a.latitude > point.latitude) != (b.latitude > point.latitude) {
      let crossing =
        (b.longitude - a.longitude) * (point.latitude - a.latitude) / (b.latitude - a.latitude)
        + a.longitude
      if point.longitude < crossing { inside.toggle() }
    }
    previous = index
  }
  return inside
}

extension NavOSSOfflineRegion {
  public func covers(_ point: NavOSSCarPlayCoordinate) -> Bool {
    bounds.contains(point) && navOSSOfflinePolygonContains(polygon, point)
  }
}

/// Whether deleting `region` must wait: an on-device route is being driven over its files.
public func navOSSOfflineDeletionBlocked(
  region: NavOSSOfflineRegion,
  activeTrip: NavOSSCarPlayTrip?
) -> Bool {
  guard let activeTrip, activeTrip.source == navOSSOfflineRouteSource else { return false }
  return activeTrip.geometry.contains(where: region.covers)
}

/// How long a deleted region's files outlive its removal from `active.json`, so phone and
/// CarPlay maps have switched off its offline style before MapLibre could read a deleted file.
public let navOSSOfflineDeletionGraceSeconds = 2.0

/// The single installed region whose coverage contains every point, preferring the widest
/// (a bulk province pack over a city pack). Offline routes and the offline map read exactly one
/// region's files; two packs are never stitched together.
public func navOSSOfflineCoveringRegion(
  _ regions: [NavOSSOfflineInstalledRegion],
  points: [NavOSSCarPlayCoordinate]
) -> NavOSSOfflineInstalledRegion? {
  guard !points.isEmpty else { return nil }
  return regions
    .filter { installed in points.allSatisfy { installed.region.covers($0) } }
    .max { $0.region.bounds.area < $1.region.bounds.area }
}
