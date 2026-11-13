import CryptoKit
import Foundation
import Network
import UIKit

extension Notification.Name {
  /// Posted on the main queue whenever offline regions, downloads, connectivity or the
  /// prefer-offline setting change. Phone (through the Expo module) and CarPlay both observe it.
  public static let navOSSOfflineStateDidChange = Notification.Name(
    "org.navoss.mobile.offline-state-did-change")
}

/// What the app knows about the offline manifest right now.
public enum NavOSSOfflineCatalogState: Equatable, Sendable {
  case loading
  /// The service publishes no offline bundles (the endpoint answered 404/503 or is not set).
  case notPublished
  /// The service could not be reached and no earlier manifest is cached.
  case unreachable
  /// The published bundles need a newer app.
  case unsupported
  /// The manifest is available (`stale` when it came from the cache after a failed refresh).
  case available(stale: Bool)
}

public struct NavOSSOfflineRegionStatus: Equatable, Sendable {
  public let region: NavOSSOfflineRegion
  public let installed: NavOSSOfflineInstalledRegion?
  public let activity: NavOSSOfflineActivity
  public let updateAvailable: Bool
  /// Bytes this region still needs to download, including shared resources not yet installed.
  public let downloadBytes: Int64
}

public struct NavOSSOfflineStatus: Equatable, Sendable {
  public let catalog: NavOSSOfflineCatalogState
  public let bundleVersion: String?
  public let dataDate: String?
  public let regions: [NavOSSOfflineRegionStatus]
  public let storageBytes: Int64
  public let availableBytes: Int64?
  public let preferOffline: Bool
  public let networkAvailable: Bool
}

/// Downloads, verifies and installs offline regions into the layout documented in
/// `docs/architecture/offline.md`, and answers which installed files phone and CarPlay should use.
///
/// One region downloads at a time. Partial files persist under `staging/` and resume with HTTP
/// byte ranges, including after the app is closed. Nothing is installed until every artifact has
/// its exact manifest byte count and SHA-256; installation renames staged files into place and
/// replaces `active.json` atomically. The whole tree is excluded from iCloud backup.
public final class NavOSSOfflineStore: NSObject, @unchecked Sendable {
  public static let shared = NavOSSOfflineStore()

  public let layout: NavOSSOfflineLayout
  private let queue = DispatchQueue(label: "org.navoss.offline.store")
  /// Hashing and extraction run here so status reads on `queue` never wait for them.
  private let workQueue = DispatchQueue(label: "org.navoss.offline.work", qos: .utility)
  private var lastPublish = Date.distantPast
  private let fileManager = FileManager.default
  private let defaults = UserDefaults.standard
  private let pathMonitor = NWPathMonitor()
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 60
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  // State guarded by `queue`.
  private var manifest: NavOSSOfflineManifest?
  private var catalog: NavOSSOfflineCatalogState = .loading
  private var snapshot = NavOSSOfflineActiveSnapshot()
  private var activities: [String: NavOSSOfflineActivity] = [:]
  private var downloadQueue: [String] = []
  private var transfer: Transfer?
  /// The region whose download/verify/install pipeline is running; one at a time.
  private var activeRegion: String?
  private var networkAvailable = true
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var started = false

  private static let preferOfflineKey = "navoss.offline.prefer-offline"
  private static let manifestCacheName = "manifest.json"

  /// One artifact transfer in flight.
  private final class Transfer {
    let regionId: String
    let file: URL
    let artifact: NavOSSOfflineArtifact
    let baseBytes: Int64
    let totalBytes: Int64
    var task: URLSessionDataTask?
    var handle: FileHandle?
    var written: Int64
    var completion: ((Result<Void, NavOSSOfflineFailure>) -> Void)?

    init(
      regionId: String, file: URL, artifact: NavOSSOfflineArtifact, baseBytes: Int64,
      totalBytes: Int64, written: Int64
    ) {
      self.regionId = regionId
      self.file = file
      self.artifact = artifact
      self.baseBytes = baseBytes
      self.totalBytes = totalBytes
      self.written = written
    }
  }

  override init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    layout = NavOSSOfflineLayout(
      root: support.appending(path: "NavOSSOffline", directoryHint: .isDirectory))
    super.init()
  }

  // MARK: - Lifecycle

  /// Loads the installed snapshot, cleans up superseded files and starts watching connectivity.
  /// Safe to call repeatedly.
  public func start() {
    queue.sync {
      guard !started else { return }
      started = true
      prepareRoot()
      snapshot = loadSnapshot()
      if let cached = try? Data(contentsOf: layout.root.appending(path: Self.manifestCacheName)),
        let parsed = try? NavOSSOfflineManifest.parse(cached)
      {
        manifest = parsed
        catalog = .available(stale: true)
      }
      collectGarbage()
      restorePartialDownloads()
    }
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      self.queue.async {
        let available = path.status == .satisfied
        guard available != self.networkAvailable else { return }
        self.networkAvailable = available
        self.publish()
      }
    }
    pathMonitor.start(queue: DispatchQueue(label: "org.navoss.offline.path"))
  }

  public var installedSnapshot: NavOSSOfflineActiveSnapshot {
    queue.sync { snapshot }
  }

  public var isNetworkAvailable: Bool {
    queue.sync { networkAvailable }
  }

  public var preferOffline: Bool {
    get { defaults.bool(forKey: Self.preferOfflineKey) }
    set {
      defaults.set(newValue, forKey: Self.preferOfflineKey)
      queue.async { self.publish() }
    }
  }

  public func status() -> NavOSSOfflineStatus {
    queue.sync { makeStatus() }
  }

  // MARK: - Manifest

  /// Fetches `/v1/offline/manifest` from the configured API. A missing or unpublished manifest
  /// leaves already-installed regions working and reports `notPublished`.
  public func refreshManifest(apiBaseURL: URL? = nil) async {
    guard
      let base = apiBaseURL
        ?? (Bundle.main.object(forInfoDictionaryKey: "NavOSSAPIURL") as? String).flatMap(URL.init)
    else {
      queue.async {
        self.catalog = .notPublished
        self.publish()
      }
      return
    }
    queue.async {
      if self.manifest == nil {
        self.catalog = .loading
        self.publish()
      }
    }
    var request = URLRequest(url: base.appending(path: "v1/offline/manifest"))
    request.timeoutInterval = 20
    request.cachePolicy = .reloadIgnoringLocalCacheData
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(status) else {
        queue.async {
          if status == 404 || status == 503 {
            // 503 (unconfigured) and 404 (older API) both mean nothing is published. Installed
            // regions keep working; there is just nothing new to download.
            self.catalog = .notPublished
            self.manifest = nil
          } else {
            self.catalog = self.manifest == nil ? .unreachable : .available(stale: true)
          }
          self.publish()
        }
        return
      }
      do {
        let parsed = try NavOSSOfflineManifest.parse(data)
        queue.async {
          self.manifest = parsed
          self.catalog = .available(stale: false)
          try? self.writeAtomically(data, to: self.layout.root.appending(path: Self.manifestCacheName))
          self.publish()
        }
      } catch NavOSSOfflineManifestError.unsupported {
        queue.async {
          self.manifest = nil
          self.catalog = .unsupported
          self.publish()
        }
      } catch {
        queue.async {
          self.catalog = self.manifest == nil ? .notPublished : .available(stale: true)
          self.publish()
        }
      }
    } catch {
      queue.async {
        self.catalog = self.manifest == nil ? .unreachable : .available(stale: true)
        self.publish()
      }
    }
  }

  // MARK: - Commands

  /// Queues a download (new install, resume or update) of `regionId` from the current manifest.
  public func download(regionId: String) {
    queue.async {
      guard let region = self.manifest?.region(id: regionId) else { return }
      let current = self.activities[regionId] ?? .idle
      guard let next = navOSSOfflineTransition(current, .request) else { return }
      let available = self.availableBytes() ?? .max
      let required = navOSSOfflineRequiredBytes(
        region: region,
        alreadyDownloadedBytes: self.stagedBytes(region: region),
        resourcesInstalled: self.resourcesInstalled(region.resources.artifact.sha256))
      guard required <= available else {
        self.activities[regionId] = .failed(
          .insufficientStorage(requiredBytes: required, availableBytes: available),
          receivedBytes: 0, totalBytes: 0)
        self.publish()
        return
      }
      self.activities[regionId] = next
      self.downloadQueue.append(regionId)
      self.publish()
      self.pumpQueue()
    }
  }

  public func pause(regionId: String) {
    queue.async {
      let current = self.activities[regionId] ?? .idle
      guard let next = navOSSOfflineTransition(current, .pause) else { return }
      self.downloadQueue.removeAll { $0 == regionId }
      if self.activeRegion == regionId {
        self.cancelTransfer()
        self.activeRegion = nil
      }
      self.activities[regionId] = next
      self.publish()
      self.pumpQueue()
    }
  }

  public enum DeleteResult: String, Sendable {
    case deleted
    /// An offline route over this region is being driven; end it first.
    case blockedByActiveRoute = "blocked-by-active-route"
  }

  /// Cancels any download and removes the region's staged and installed files. The region leaves
  /// `active.json` first, so phone and CarPlay switch off its offline style; the files go after a
  /// short grace period. Refused while an offline route over the region is active.
  @discardableResult
  public func delete(regionId: String) -> DeleteResult {
    let activeTrip = NavOSSNavigationService.shared.currentState().trip
    let blocked = queue.sync {
      snapshot.installed(regionId: regionId).map {
        navOSSOfflineDeletionBlocked(region: $0.region, activeTrip: activeTrip)
      } ?? false
    }
    if blocked { return .blockedByActiveRoute }
    queue.async {
      self.downloadQueue.removeAll { $0 == regionId }
      switch self.activities[regionId] {
      case .verifying, .installing:
        return  // Let the install finish; the driver can delete it afterwards.
      default:
        break
      }
      if self.activeRegion == regionId {
        self.cancelTransfer()
        self.activeRegion = nil
      }
      self.activities[regionId] = .idle
      if self.snapshot.installed(regionId: regionId) != nil {
        self.snapshot = self.snapshot.removing(regionId: regionId)
        try? self.saveSnapshot()
      }
      NavOSSOfflineRouter.shared.release(regionId: regionId)
      // Surfaces reload their style on this notification before any file disappears.
      self.publish()
      self.queue.asyncAfter(deadline: .now() + navOSSOfflineDeletionGraceSeconds) {
        // Downloaded again in the meantime: keep it.
        guard self.snapshot.installed(regionId: regionId) == nil,
          self.activeRegion != regionId
        else { return }
        try? self.fileManager.removeItem(
          at: self.layout.regionsRoot.appending(path: regionId, directoryHint: .isDirectory))
        for bundle in (try? self.fileManager.contentsOfDirectory(
          at: self.layout.stagingRoot, includingPropertiesForKeys: nil)) ?? []
        {
          try? self.fileManager.removeItem(at: bundle.appending(path: regionId))
        }
        self.collectGarbage()
        self.publish()
      }
      self.pumpQueue()
    }
    return .deleted
  }

  // MARK: - Map styles

  /// A bound offline style file for `slug`, rendering the installed region that covers `near`
  /// (or the widest installed region). `nil` when no region is installed or the style is unknown.
  public func offlineStyleFile(slug: String, near: NavOSSCarPlayCoordinate?) -> URL? {
    queue.sync {
      guard let slug = navOSSOfflineStyleSlug(slug), let installed = mapRegion(near: near) else {
        return nil
      }
      let regionDirectory = layout.region(
        regionId: installed.region.id, bundleVersion: installed.bundleVersion)
      let resources = layout.shared(resourcesSha256: installed.region.resources.artifact.sha256)
      let bound = layout.boundStylesRoot.appending(
        path: "\(installed.region.id)-\(installed.bundleVersion)-\(slug).json")
      if fileManager.fileExists(atPath: bound.path) { return bound }
      do {
        let source = try Data(contentsOf: resources.appending(path: "styles/\(slug).json"))
        let data = try navOSSBindOfflineStyle(
          source, mapsFile: regionDirectory.appending(path: NavOSSOfflineFile.maps.rawValue),
          resourcesRoot: resources)
        try fileManager.createDirectory(at: layout.boundStylesRoot, withIntermediateDirectories: true)
        try writeAtomically(data, to: bound)
        return bound
      } catch {
        return nil
      }
    }
  }

  /// Whether a surface showing `near` should draw the offline map instead of the hosted one.
  /// Hosted-style load failures are handled by each surface as a fallback on top of this.
  public func shouldUseOfflineMap(near: NavOSSCarPlayCoordinate?) -> Bool {
    let prefer = preferOffline
    return queue.sync {
      guard let installed = mapRegion(near: near) else { return false }
      if !networkAvailable { return true }
      guard prefer else { return false }
      // Preferring offline maps only applies inside downloaded coverage.
      return near.map { installed.region.covers($0) } ?? true
    }
  }

  private func mapRegion(near: NavOSSCarPlayCoordinate?) -> NavOSSOfflineInstalledRegion? {
    if let near, let covering = navOSSOfflineCoveringRegion(snapshot.regions, points: [near]) {
      return covering
    }
    return snapshot.regions.max { $0.region.bounds.area < $1.region.bounds.area }
  }

  // MARK: - Status

  private func makeStatus() -> NavOSSOfflineStatus {
    var regions: [NavOSSOfflineRegionStatus] = []
    var seen = Set<String>()
    for region in manifest?.regions ?? [] {
      seen.insert(region.id)
      let installed = snapshot.installed(regionId: region.id)
      regions.append(
        NavOSSOfflineRegionStatus(
          region: region,
          installed: installed,
          activity: activities[region.id] ?? .idle,
          updateAvailable: installed.map { $0.bundleVersion != manifest?.bundleVersion } ?? false,
          downloadBytes: region.regionDownloadBytes
            + (resourcesInstalled(region.resources.artifact.sha256)
              ? 0 : region.resources.artifact.byteSize)))
    }
    // Installed regions the current manifest no longer lists still work and can be deleted.
    for installed in snapshot.regions where !seen.contains(installed.region.id) {
      regions.append(
        NavOSSOfflineRegionStatus(
          region: installed.region, installed: installed,
          activity: activities[installed.region.id] ?? .idle, updateAvailable: false,
          downloadBytes: 0))
    }
    return NavOSSOfflineStatus(
      catalog: catalog,
      bundleVersion: manifest?.bundleVersion,
      dataDate: manifest?.dataDate,
      regions: regions,
      storageBytes: snapshot.storageBytes,
      availableBytes: availableBytes(),
      preferOffline: defaults.bool(forKey: Self.preferOfflineKey),
      networkAvailable: networkAvailable
    )
  }

  private func publish() {
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: .navOSSOfflineStateDidChange, object: self)
    }
  }

  // MARK: - Download pipeline

  private func pumpQueue() {
    guard activeRegion == nil, let regionId = downloadQueue.first,
      let manifest, let region = manifest.region(id: regionId)
    else {
      endBackgroundTaskIfIdle()
      return
    }
    beginBackgroundTask()
    let staging = layout.staging(bundleVersion: manifest.bundleVersion, regionId: regionId)
    do {
      try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
    } catch {
      fail(regionId, .installation)
      return
    }
    var pending: [(URL, NavOSSOfflineArtifact)] = NavOSSOfflineFile.allCases.map {
      (staging.appending(path: $0.rawValue), $0.artifact(in: region))
    }
    if !resourcesInstalled(region.resources.artifact.sha256) {
      pending.insert(
        (layout.stagingResources(sha256: region.resources.artifact.sha256), region.resources.artifact),
        at: 0)
    }
    let total = pending.reduce(Int64(0)) { $0 + $1.1.byteSize }
    let done = pending.filter { fileManager.fileExists(atPath: $0.0.path) }
    let received = done.reduce(Int64(0)) { $0 + $1.1.byteSize }
      + pending.filter { !fileManager.fileExists(atPath: $0.0.path) }
      .reduce(Int64(0)) { $0 + partialSize($1.0) }
    guard let started = navOSSOfflineTransition(
      activities[regionId] ?? .idle, .start(totalBytes: total, receivedBytes: min(received, total)))
    else {
      downloadQueue.removeFirst()
      pumpQueue()
      return
    }
    activities[regionId] = started
    activeRegion = regionId
    publish()
    downloadNext(
      regionId: regionId, region: region, manifest: manifest,
      pending: pending.filter { !fileManager.fileExists(atPath: $0.0.path) },
      completedBytes: done.reduce(Int64(0)) { $0 + $1.1.byteSize }, totalBytes: total)
  }

  private func downloadNext(
    regionId: String, region: NavOSSOfflineRegion, manifest: NavOSSOfflineManifest,
    pending: [(URL, NavOSSOfflineArtifact)], completedBytes: Int64, totalBytes: Int64
  ) {
    guard let (file, artifact) = pending.first else {
      downloadQueue.removeAll { $0 == regionId }
      if let next = navOSSOfflineTransition(activities[regionId] ?? .idle, .downloaded) {
        activities[regionId] = next
        publish()
        install(region: region, manifest: manifest)
      }
      return
    }
    let partial = URL(fileURLWithPath: file.path + ".partial")
    let existing = partialSize(file)
    if existing > artifact.byteSize { try? fileManager.removeItem(at: partial) }
    let transfer = Transfer(
      regionId: regionId, file: partial, artifact: artifact, baseBytes: completedBytes,
      totalBytes: totalBytes, written: min(existing, artifact.byteSize))
    transfer.completion = { [weak self] result in
      guard let self else { return }
      // Runs on `queue`.
      self.transfer = nil
      switch result {
      case .failure(let failure):
        self.fail(regionId, failure)
      case .success:
        self.workQueue.async {
          let verified = self.verify(partial, artifact)
          self.queue.async {
            // Paused or deleted while hashing: leave the bytes for a later resume.
            guard case .downloading = self.activities[regionId] else { return }
            guard verified else {
              try? self.fileManager.removeItem(at: partial)
              self.fail(regionId, .integrity)
              return
            }
            try? self.fileManager.moveItem(at: partial, to: file)
            self.downloadNext(
              regionId: regionId, region: region, manifest: manifest,
              pending: Array(pending.dropFirst()), completedBytes: completedBytes + artifact.byteSize,
              totalBytes: totalBytes)
          }
        }
      }
    }
    self.transfer = transfer
    if transfer.written == artifact.byteSize {
      transfer.completion?(.success(()))
      return
    }
    if !fileManager.fileExists(atPath: partial.path) {
      fileManager.createFile(atPath: partial.path, contents: nil)
    }
    guard let handle = try? FileHandle(forWritingTo: partial) else {
      fail(regionId, .installation)
      return
    }
    _ = try? handle.seekToEnd()
    transfer.handle = handle
    var request = URLRequest(url: artifact.url)
    if transfer.written > 0 {
      request.setValue("bytes=\(transfer.written)-", forHTTPHeaderField: "Range")
    }
    let task = session.dataTask(with: request)
    transfer.task = task
    task.resume()
  }

  private func cancelTransfer() {
    guard let transfer else { return }
    transfer.completion = nil
    transfer.task?.cancel()
    try? transfer.handle?.close()
    self.transfer = nil
  }

  private func fail(_ regionId: String, _ failure: NavOSSOfflineFailure) {
    downloadQueue.removeAll { $0 == regionId }
    if activeRegion == regionId { activeRegion = nil }
    if let next = navOSSOfflineTransition(activities[regionId] ?? .idle, .fail(failure)) {
      activities[regionId] = next
    }
    publish()
    pumpQueue()
  }

  private func verify(_ file: URL, _ artifact: NavOSSOfflineArtifact) -> Bool {
    guard partialSizeOf(file) == artifact.byteSize, let handle = try? FileHandle(forReadingFrom: file)
    else {
      return false
    }
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try? handle.read(upToCount: 4 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return digest == artifact.sha256
  }

  // MARK: - Install

  private func install(region: NavOSSOfflineRegion, manifest: NavOSSOfflineManifest) {
    let regionId = region.id
    guard let verified = navOSSOfflineTransition(activities[regionId] ?? .idle, .verified) else {
      return
    }
    activities[regionId] = verified
    publish()
    let sha = region.resources.artifact.sha256
    let needsResources = !resourcesInstalled(sha)
    workQueue.async {
      let staging = self.layout.staging(bundleVersion: manifest.bundleVersion, regionId: regionId)
      let destination = self.layout.region(regionId: regionId, bundleVersion: manifest.bundleVersion)
      do {
        if needsResources {
          let archive = self.layout.stagingResources(sha256: sha)
          let temporary = self.layout.sharedRoot.appending(
            path: ".tmp-\(sha)-\(UUID().uuidString)", directoryHint: .isDirectory)
          try self.fileManager.createDirectory(
            at: self.layout.sharedRoot, withIntermediateDirectories: true)
          do {
            try navOSSExtractTarGzip(
              archive: archive, destination: temporary,
              maximumBytes: region.resources.unpackedByteSize)
            try self.validateResources(temporary)
          } catch {
            try? self.fileManager.removeItem(at: temporary)
            try? self.fileManager.removeItem(at: archive)
            throw error
          }
          try self.fileManager.moveItem(at: temporary, to: self.layout.shared(resourcesSha256: sha))
          try? self.fileManager.removeItem(at: archive)
        }
        try self.validateRegionFiles(staging)
        try self.fileManager.createDirectory(
          at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if self.fileManager.fileExists(atPath: destination.path) {
          try self.fileManager.removeItem(at: destination)
        }
        try self.fileManager.moveItem(at: staging, to: destination)
      } catch {
        self.queue.async { self.fail(regionId, .installation) }
        return
      }
      self.queue.async {
        self.snapshot = self.snapshot.installing(
          NavOSSOfflineInstalledRegion(
            region: region, bundleVersion: manifest.bundleVersion, graphId: manifest.graph.id,
            osmTimestamp: manifest.osmTimestamp, installedAt: Date()))
        do {
          try self.saveSnapshot()
        } catch {
          self.fail(regionId, .installation)
          return
        }
        if let installed = navOSSOfflineTransition(self.activities[regionId] ?? .idle, .installed) {
          self.activities[regionId] = installed
        }
        self.activeRegion = nil
        // Superseded versions stay until the next launch, so a map or route already using them
        // keeps its files for the rest of this session.
        self.publish()
        self.pumpQueue()
      }
    }
  }

  private func validateResources(_ root: URL) throws {
    var required = navOSSOfflineStyleSlugs.map { "styles/\($0).json" }
    required += [
      "sprites/ofm.json", "sprites/ofm.png", "sprites/ofm@2x.json", "sprites/ofm@2x.png",
      "routing-config.json", "search-normalization.json", "search-query.sql", "category-query.sql",
      "glyphs/Noto Sans Regular/0-255.pbf",
    ]
    for path in required where !fileManager.fileExists(atPath: root.appending(path: path).path) {
      throw NavOSSOfflineSearchError.incompatibleDatabase
    }
  }

  /// Cheap format checks before a region is activated: PMTiles v3 magic, a routing tar whose
  /// first member is `index.bin`, and a schema-1 search database.
  private func validateRegionFiles(_ directory: URL) throws {
    let maps = try FileHandle(forReadingFrom: directory.appending(path: NavOSSOfflineFile.maps.rawValue))
    let header = try maps.read(upToCount: 8) ?? Data()
    try maps.close()
    guard header.count == 8, header.prefix(7) == Data("PMTiles".utf8), header[7] == 3 else {
      throw NavOSSOfflineSearchError.incompatibleDatabase
    }
    let routing = try FileHandle(
      forReadingFrom: directory.appending(path: NavOSSOfflineFile.routing.rawValue))
    let first = try routing.read(upToCount: 100) ?? Data()
    try routing.close()
    guard String(decoding: first.prefix { $0 != 0 }, as: UTF8.self) == "index.bin" else {
      throw NavOSSOfflineSearchError.incompatibleDatabase
    }
    _ = try NavOSSOfflineSearchDatabase(
      url: directory.appending(path: NavOSSOfflineFile.search.rawValue))
  }

  // MARK: - Files

  private func prepareRoot() {
    try? fileManager.createDirectory(at: layout.root, withIntermediateDirectories: true)
    var root = layout.root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? root.setResourceValues(values)
  }

  private func loadSnapshot() -> NavOSSOfflineActiveSnapshot {
    guard let data = try? Data(contentsOf: layout.activeSnapshot),
      let decoded = try? JSONDecoder().decode(NavOSSOfflineActiveSnapshot.self, from: data),
      decoded.schemaVersion == NavOSSOfflineActiveSnapshot.currentSchemaVersion
    else {
      return NavOSSOfflineActiveSnapshot()
    }
    // Keep only regions whose files are all present.
    let present = decoded.regions.filter { installed in
      let directory = layout.region(regionId: installed.region.id, bundleVersion: installed.bundleVersion)
      return NavOSSOfflineFile.allCases.allSatisfy {
        fileManager.fileExists(atPath: directory.appending(path: $0.rawValue).path)
      } && resourcesInstalled(installed.region.resources.artifact.sha256)
    }
    return NavOSSOfflineActiveSnapshot(regions: present)
  }

  private func saveSnapshot() throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try writeAtomically(try encoder.encode(snapshot), to: layout.activeSnapshot)
  }

  private func writeAtomically(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: [.atomic])
  }

  /// Removes region versions, shared resources and bound styles the active snapshot no longer
  /// references, and staging for other bundle versions. Runs at launch and after deletes.
  private func collectGarbage() {
    let keepVersions = Dictionary(
      uniqueKeysWithValues: snapshot.regions.map { ($0.region.id, $0.bundleVersion) })
    for regionDirectory in (try? fileManager.contentsOfDirectory(
      at: layout.regionsRoot, includingPropertiesForKeys: nil)) ?? []
    {
      let regionId = regionDirectory.lastPathComponent
      for version in (try? fileManager.contentsOfDirectory(
        at: regionDirectory, includingPropertiesForKeys: nil)) ?? []
      where version.lastPathComponent != keepVersions[regionId] {
        try? fileManager.removeItem(at: version)
      }
    }
    let referenced = snapshot.referencedResources
    let wanted = Set(manifest?.regions.map(\.resources.artifact.sha256) ?? [])
    for shared in (try? fileManager.contentsOfDirectory(
      at: layout.sharedRoot, includingPropertiesForKeys: nil)) ?? []
    where !referenced.contains(shared.lastPathComponent) {
      try? fileManager.removeItem(at: shared)
    }
    for staged in (try? fileManager.contentsOfDirectory(
      at: layout.stagingRoot, includingPropertiesForKeys: nil)) ?? []
    {
      let name = staged.lastPathComponent
      let isCurrentBundle = name == manifest?.bundleVersion
      let isWantedResource = wanted.contains { name.hasPrefix("resources-\($0)") }
      if !isCurrentBundle && !isWantedResource && manifest != nil {
        try? fileManager.removeItem(at: staged)
      }
    }
    try? fileManager.removeItem(at: layout.boundStylesRoot)
  }

  /// After a relaunch, regions with staged bytes show as paused so the driver can resume them.
  private func restorePartialDownloads() {
    guard let manifest else { return }
    for region in manifest.regions {
      // Only the region's own files mark it as started; the shared resources archive may have
      // been staged by another region.
      let ownStaged = NavOSSOfflineFile.allCases.contains { file in
        let url = layout.staging(bundleVersion: manifest.bundleVersion, regionId: region.id)
          .appending(path: file.rawValue)
        return fileManager.fileExists(atPath: url.path) || partialSize(url) > 0
      }
      let staged = stagedBytes(region: region)
      guard ownStaged, staged > 0 else { continue }
      let total = region.regionDownloadBytes
        + (resourcesInstalled(region.resources.artifact.sha256) ? 0 : region.resources.artifact.byteSize)
      activities[region.id] = .paused(receivedBytes: min(staged, total), totalBytes: total)
    }
  }

  private func stagedBytes(region: NavOSSOfflineRegion) -> Int64 {
    guard let manifest else { return 0 }
    let staging = layout.staging(bundleVersion: manifest.bundleVersion, regionId: region.id)
    var bytes = NavOSSOfflineFile.allCases.reduce(Int64(0)) { total, file in
      let url = staging.appending(path: file.rawValue)
      return total + (fileManager.fileExists(atPath: url.path)
        ? file.artifact(in: region).byteSize : partialSize(url))
    }
    if !resourcesInstalled(region.resources.artifact.sha256) {
      let archive = layout.stagingResources(sha256: region.resources.artifact.sha256)
      bytes += fileManager.fileExists(atPath: archive.path)
        ? region.resources.artifact.byteSize : partialSize(archive)
    }
    return bytes
  }

  private func resourcesInstalled(_ sha256: String) -> Bool {
    fileManager.fileExists(atPath: layout.shared(resourcesSha256: sha256).path)
  }

  private func partialSize(_ file: URL) -> Int64 {
    partialSizeOf(URL(fileURLWithPath: file.path + ".partial"))
  }

  private func partialSizeOf(_ file: URL) -> Int64 {
    ((try? fileManager.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.int64Value ?? 0
  }

  private func availableBytes() -> Int64? {
    let values = try? layout.root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values?.volumeAvailableCapacityForImportantUsage
  }

  // MARK: - Background execution

  private func beginBackgroundTask() {
    DispatchQueue.main.async {
      guard self.backgroundTask == .invalid else { return }
      self.backgroundTask = UIApplication.shared.beginBackgroundTask(
        withName: "NavOSS offline download"
      ) { [weak self] in
        // Out of background time: pause cleanly so the partial file resumes later.
        guard let self else { return }
        self.queue.sync {
          if let regionId = self.transfer?.regionId {
            self.cancelTransfer()
            self.activeRegion = nil
            if let next = navOSSOfflineTransition(self.activities[regionId] ?? .idle, .pause) {
              self.activities[regionId] = next
            }
            self.downloadQueue.removeAll()
            self.publish()
          }
        }
        UIApplication.shared.endBackgroundTask(self.backgroundTask)
        self.backgroundTask = .invalid
      }
    }
  }

  private func endBackgroundTaskIfIdle() {
    DispatchQueue.main.async {
      guard self.backgroundTask != .invalid else { return }
      UIApplication.shared.endBackgroundTask(self.backgroundTask)
      self.backgroundTask = .invalid
    }
  }
}

// MARK: - URLSession

extension NavOSSOfflineStore: URLSessionDataDelegate {
  public func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    queue.async {
      guard let transfer = self.transfer, transfer.task === dataTask,
        let http = response as? HTTPURLResponse
      else {
        completionHandler(.cancel)
        return
      }
      switch http.statusCode {
      case 206 where transfer.written > 0:
        let range = http.value(forHTTPHeaderField: "Content-Range") ?? ""
        guard range.hasPrefix("bytes \(transfer.written)-") else {
          self.finish(transfer, .failure(.server(statusCode: 206)))
          completionHandler(.cancel)
          return
        }
        completionHandler(.allow)
      case 200:
        // The server ignored the range: start this file over.
        try? transfer.handle?.truncate(atOffset: 0)
        transfer.written = 0
        completionHandler(.allow)
      default:
        self.finish(transfer, .failure(.server(statusCode: http.statusCode)))
        completionHandler(.cancel)
      }
    }
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    queue.async {
      guard let transfer = self.transfer, transfer.task === dataTask else { return }
      guard transfer.written + Int64(data.count) <= transfer.artifact.byteSize else {
        dataTask.cancel()
        self.finish(transfer, .failure(.integrity))
        return
      }
      do {
        try transfer.handle?.write(contentsOf: data)
      } catch {
        dataTask.cancel()
        self.finish(transfer, .failure(.installation))
        return
      }
      transfer.written += Int64(data.count)
      let received = transfer.baseBytes + transfer.written
      if let next = navOSSOfflineTransition(
        self.activities[transfer.regionId] ?? .idle, .progress(receivedBytes: min(received, transfer.totalBytes))),
        next != self.activities[transfer.regionId]
      {
        self.activities[transfer.regionId] = next
        self.throttledPublish()
      }
    }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    queue.async {
      guard let transfer = self.transfer, transfer.task === task else { return }
      if error != nil {
        self.finish(transfer, .failure(.network))
      } else if transfer.written == transfer.artifact.byteSize {
        self.finish(transfer, .success(()))
      } else {
        self.finish(transfer, .failure(.integrity))
      }
    }
  }

  private func finish(_ transfer: Transfer, _ result: Result<Void, NavOSSOfflineFailure>) {
    try? transfer.handle?.close()
    transfer.handle = nil
    let completion = transfer.completion
    transfer.completion = nil
    completion?(result)
  }

  private func throttledPublish() {
    let now = Date()
    guard now.timeIntervalSince(lastPublish) >= 0.25 else { return }
    lastPublish = now
    publish()
  }
}
