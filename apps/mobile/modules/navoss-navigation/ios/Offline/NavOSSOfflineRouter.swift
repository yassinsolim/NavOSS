import Foundation

/// On-device routing and search over installed offline regions, shared by phone and CarPlay.
///
/// Every request reads exactly one installed region: the widest one covering every stop. The
/// Valhalla actor for that region is created on first use and kept until a different region is
/// needed or the region is deleted; swaps happen between requests on this router's serial queue,
/// never under a running route. Responses are native Valhalla JSON, adapted by
/// `navOSSOfflineTrips`, and must stay inside the region's coverage.
public final class NavOSSOfflineRouter: @unchecked Sendable {
  public static let shared = NavOSSOfflineRouter()

  private let queue = DispatchQueue(label: "org.navoss.offline.router", qos: .userInitiated)
  private let store = NavOSSOfflineStore.shared
  private var engine: (key: String, actor: NavOSSValhallaActor)?
  private var searchDatabases: [String: NavOSSOfflineSearchDatabase] = [:]
  private var recipes: [String: (search: String, category: String, normalizer: NavOSSOfflineSearchNormalizer)] = [:]
  /// Recent offline trips by ID, so a trip that round-trips through JavaScript keeps its lanes,
  /// signs and bearings when navigation starts.
  private var recentTrips: [NavOSSCarPlayTrip] = []
  private var tzdataReady = false

  /// Whether an installed region covers every point, so an offline answer is possible.
  public func covers(_ points: [NavOSSCarPlayCoordinate]) -> Bool {
    navOSSOfflineCoveringRegion(store.installedSnapshot.regions, points: points) != nil
  }

  public var hasInstalledRegions: Bool {
    !store.installedSnapshot.regions.isEmpty
  }

  public func routes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double? = nil,
    originHorizontalAccuracyMeters: Double? = nil,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int = 2,
    waypoints: [NavOSSCarPlayDestination] = []
  ) async throws -> [NavOSSCarPlayTrip] {
    let target = NavOSSCarPlayCoordinate(latitude: destination.latitude, longitude: destination.longitude)
    let stops = waypoints.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
    guard
      let installed = navOSSOfflineCoveringRegion(
        store.installedSnapshot.regions, points: [origin] + stops + [target])
    else {
      throw NavOSSOfflineRoutingError.outsideInstalledCoverage
    }
    let request = try navOSSOfflineRouteRequest(
      origin: origin, originHeadingDegrees: originHeadingDegrees,
      originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: target,
      waypoints: stops, preferences: preferences, alternatives: alternatives)
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        continuation.resume(
          with: Result {
            let actor = try self.actor(for: installed)
            let response = actor.route(request)
            let data = Data(response.utf8)
            if Self.isWrapperError(data) { throw NavOSSOfflineRoutingError.noRoute }
            let trips = try navOSSOfflineTrips(
              fromValhallaJSON: data, destination: destination, waypoints: waypoints,
              preferences: preferences)
            guard navOSSOfflineTripsStayInside(trips, region: installed.region) else {
              throw NavOSSOfflineRoutingError.routeLeavesCoverage
            }
            self.recentTrips = Array((trips + self.recentTrips).prefix(12))
            return trips
          })
      }
    }
  }

  /// The full offline trip with this ID and geometry, when it was planned recently.
  public func recentTrip(matching trip: NavOSSCarPlayTrip) -> NavOSSCarPlayTrip? {
    queue.sync {
      recentTrips.first {
        $0.id == trip.id && $0.geometry.count == trip.geometry.count
          && $0.steps.count == trip.steps.count
      }
    }
  }

  /// Searches installed regions. Regions covering `proximity` are searched first (widest first);
  /// overlapping regions' duplicates are dropped by OSM identity.
  public func search(
    query: String,
    proximity: NavOSSCarPlayCoordinate?,
    limit: Int,
    category: String? = nil
  ) async throws -> [NavOSSOfflinePlace] {
    let regions = store.installedSnapshot.regions
    guard !regions.isEmpty else { throw NavOSSOfflineSearchError.unavailable }
    let ordered: [NavOSSOfflineInstalledRegion] = {
      guard let proximity else { return regions }
      let covering = regions.filter { $0.region.covers(proximity) }
        .sorted { $0.region.bounds.area > $1.region.bounds.area }
      // The widest covering region already contains every nearer result.
      return covering.isEmpty ? regions : [covering[0]]
    }()
    let origin =
      proximity
      ?? NavOSSCarPlayCoordinate(
        latitude: (ordered[0].region.bounds.south + ordered[0].region.bounds.north) / 2,
        longitude: (ordered[0].region.bounds.west + ordered[0].region.bounds.east) / 2)
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        continuation.resume(
          with: Result {
            let lists = try ordered.map { installed -> [NavOSSOfflinePlace] in
              let (database, recipe) = try self.searchDatabase(for: installed)
              if let category {
                guard
                  let parameters = NavOSSOfflineCategoryParameters(
                    category: category, origin: origin, radiusKm: 25, limit: limit)
                else { return [] }
                return try database.category(sql: recipe.category, parameters: parameters)
              }
              guard
                let parameters = NavOSSOfflineSearchParameters(
                  query: query, origin: origin, limit: limit, normalizer: recipe.normalizer)
              else { return [] }
              return try database.search(sql: recipe.search, parameters: parameters)
            }
            return navOSSOfflineMergeSearchResults(lists, limit: limit)
          })
      }
    }
  }

  /// Closes the engine and search connection for a region about to be deleted or replaced.
  public func release(regionId: String) {
    queue.async {
      if self.engine?.key.hasPrefix("\(regionId)/") == true {
        self.engine?.actor.close()
        self.engine = nil
      }
      for key in self.searchDatabases.keys where key.hasPrefix("\(regionId)/") {
        self.searchDatabases[key] = nil
      }
    }
  }

  // MARK: - Engine

  private func actor(for installed: NavOSSOfflineInstalledRegion) throws -> NavOSSValhallaActor {
    let key = "\(installed.region.id)/\(installed.bundleVersion)"
    if let engine, engine.key == key { return engine.actor }
    engine?.actor.close()
    engine = nil
    try prepareTzdata()
    let layout = store.layout
    let tar = layout.region(regionId: installed.region.id, bundleVersion: installed.bundleVersion)
      .appending(path: NavOSSOfflineFile.routing.rawValue)
    let packaged = layout.shared(resourcesSha256: installed.region.resources.artifact.sha256)
      .appending(path: "routing-config.json")
    guard var config = try JSONSerialization.jsonObject(with: Data(contentsOf: packaged)) as? [String: Any],
      var mjolnir = config["mjolnir"] as? [String: Any]
    else {
      throw NavOSSOfflineRoutingError.engineUnavailable
    }
    // Bind only the tile extract, as the bundle contract requires; traffic and elevation stay
    // empty and engine logging stays off.
    mjolnir["tile_extract"] = tar.path
    config["mjolnir"] = mjolnir
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appending(path: "NavOSSOffline", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: caches, withIntermediateDirectories: true)
    let configURL = caches.appending(path: "valhalla-\(installed.region.id).json")
    try JSONSerialization.data(withJSONObject: config).write(to: configURL, options: .atomic)
    do {
      let actor = try NavOSSValhallaActor(configPath: configURL.path)
      engine = (key, actor)
      return actor
    } catch {
      throw NavOSSOfflineRoutingError.engineUnavailable
    }
  }

  /// Valhalla's date library reads the IANA database from `Library/tzdata`. The pinned archive
  /// ships in the module's resource bundle and is unpacked once.
  private func prepareTzdata() throws {
    guard !tzdataReady else { return }
    let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
    let target = library.appending(path: "tzdata", directoryHint: .isDirectory)
    let marker = target.appending(path: ".navoss-tzdata")
    if !FileManager.default.fileExists(atPath: marker.path) {
      guard
        let bundleURL = Bundle(for: NavOSSOfflineRouter.self).url(
          forResource: "NavOSSValhalla", withExtension: "bundle"),
        let archive = Bundle(url: bundleURL)?.url(forResource: "tzdata", withExtension: "tar")
      else {
        throw NavOSSOfflineRoutingError.engineUnavailable
      }
      try? FileManager.default.removeItem(at: target)
      try navOSSExtractTar(archive: archive, destination: target, maximumBytes: 4_000_000)
      FileManager.default.createFile(atPath: marker.path, contents: Data())
    }
    tzdataReady = true
  }

  // MARK: - Search

  private func searchDatabase(for installed: NavOSSOfflineInstalledRegion) throws
    -> (NavOSSOfflineSearchDatabase, (search: String, category: String, normalizer: NavOSSOfflineSearchNormalizer))
  {
    let key = "\(installed.region.id)/\(installed.bundleVersion)"
    let sha = installed.region.resources.artifact.sha256
    let resources = store.layout.shared(resourcesSha256: sha)
    let recipe =
      try recipes[sha]
      ?? (
        search: String(contentsOf: resources.appending(path: "search-query.sql"), encoding: .utf8),
        category: String(contentsOf: resources.appending(path: "category-query.sql"), encoding: .utf8),
        normalizer: NavOSSOfflineSearchNormalizer(
          normalizationJSON: Data(contentsOf: resources.appending(path: "search-normalization.json")))
      )
    recipes[sha] = recipe
    if let database = searchDatabases[key] { return (database, recipe) }
    let database = try NavOSSOfflineSearchDatabase(
      url: store.layout.region(regionId: installed.region.id, bundleVersion: installed.bundleVersion)
        .appending(path: NavOSSOfflineFile.search.rawValue))
    searchDatabases[key] = database
    return (database, recipe)
  }

  /// The wrapper's error envelope: exactly `code` and `message`.
  private static func isWrapperError(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return true
    }
    return object.count == 2 && object["code"] is Int && object["message"] is String
  }
}

// MARK: - API client fallback

extension NavOSSOfflineRouter: NavOSSOfflineNavigationFallback {
  public var isNetworkAvailable: Bool { store.isNetworkAvailable }

  public func offlineSearch(
    query: String, proximity: NavOSSCarPlayCoordinate?, limit: Int, category: String?
  ) async throws -> [NavOSSCarPlayDestination] {
    try await search(query: query, proximity: proximity, limit: limit, category: category)
      .map(\.destination)
  }

  public func offlineRoutes(
    origin: NavOSSCarPlayCoordinate, originHeadingDegrees: Double?,
    originHorizontalAccuracyMeters: Double?, destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences, alternatives: Int, waypoints: [NavOSSCarPlayDestination]
  ) async throws -> [NavOSSCarPlayTrip] {
    try await routes(
      origin: origin, originHeadingDegrees: originHeadingDegrees,
      originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: destination,
      preferences: preferences, alternatives: alternatives, waypoints: waypoints)
  }
}
