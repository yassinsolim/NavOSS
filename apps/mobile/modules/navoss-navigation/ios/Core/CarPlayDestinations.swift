import Foundation

extension Notification.Name {
  public static let navOSSCarPlayDestinationCatalogDidChange = Notification.Name(
    "org.navoss.mobile.carplay-destination-catalog-did-change"
  )
}

public struct NavOSSCarPlayDestination: Codable, Equatable, Sendable {
  public let id: String
  public let label: String
  public let latitude: Double
  public let longitude: Double
  public let name: String

  public init(id: String, label: String, latitude: Double, longitude: Double, name: String) {
    self.id = id
    self.label = label
    self.latitude = latitude
    self.longitude = longitude
    self.name = name
  }

  var isValid: Bool {
    !id.isEmpty && !name.isEmpty && latitude.isFinite && longitude.isFinite
      && (-90...90).contains(latitude) && (-180...180).contains(longitude)
  }
}

public struct NavOSSCarPlayDestinationCatalog: Codable, Equatable, Sendable {
  public var favorites: [NavOSSCarPlayDestination]
  public var home: NavOSSCarPlayDestination?
  public var recents: [NavOSSCarPlayDestination]
  public var work: NavOSSCarPlayDestination?

  public init(
    favorites: [NavOSSCarPlayDestination] = [],
    home: NavOSSCarPlayDestination? = nil,
    recents: [NavOSSCarPlayDestination] = [],
    work: NavOSSCarPlayDestination? = nil
  ) {
    self.favorites = favorites
    self.home = home
    self.recents = recents
    self.work = work
  }

  public var searchableDestinations: [NavOSSCarPlayDestination] {
    var destinations: [NavOSSCarPlayDestination] = []
    if let home {
      destinations.append(home)
    }
    if let work {
      destinations.append(work)
    }
    destinations.append(contentsOf: recents)
    destinations.append(contentsOf: favorites)

    var seenIds = Set<String>()
    return destinations.filter { seenIds.insert($0.id).inserted }
  }
}

public final class NavOSSCarPlayDestinationStore: @unchecked Sendable {
  public static let shared = NavOSSCarPlayDestinationStore()

  private let defaults: UserDefaults
  private let key: String
  private let lock = NSLock()
  private let maximumRecentCount = 12
  private let notificationCenter: NotificationCenter

  public init(
    defaults: UserDefaults = .standard,
    key: String = "org.navoss.mobile.carplay-destinations.v1",
    notificationCenter: NotificationCenter = .default
  ) {
    self.defaults = defaults
    self.key = key
    self.notificationCenter = notificationCenter
  }

  public func recordRecent(_ destination: NavOSSCarPlayDestination) {
    guard destination.isValid else {
      return
    }

    lock.lock()
    var catalog = readCatalog()
    catalog.recents.removeAll { $0.id == destination.id }
    catalog.recents.insert(destination, at: 0)
    catalog.recents = Array(catalog.recents.prefix(maximumRecentCount))
    writeCatalog(catalog)
    lock.unlock()
    notifyCatalogChanged()
  }

  public func clearRecents() {
    updateCatalog { $0.recents = [] }
  }

  public func replaceFavorites(_ favorites: [NavOSSCarPlayDestination]) {
    lock.lock()
    var catalog = readCatalog()
    catalog.favorites = Array(favorites.filter(\.isValid).prefix(20))
    writeCatalog(catalog)
    lock.unlock()
    notifyCatalogChanged()
  }

  public func setHome(_ destination: NavOSSCarPlayDestination?) {
    updateCatalog { $0.home = destination?.isValid == true ? destination : nil }
  }

  public func setWork(_ destination: NavOSSCarPlayDestination?) {
    updateCatalog { $0.work = destination?.isValid == true ? destination : nil }
  }

  public func snapshot() -> NavOSSCarPlayDestinationCatalog {
    lock.lock()
    defer { lock.unlock() }
    return readCatalog()
  }

  private func readCatalog() -> NavOSSCarPlayDestinationCatalog {
    guard let data = defaults.data(forKey: key),
      let catalog = try? JSONDecoder().decode(NavOSSCarPlayDestinationCatalog.self, from: data)
    else {
      return NavOSSCarPlayDestinationCatalog()
    }
    return catalog
  }

  private func updateCatalog(_ update: (inout NavOSSCarPlayDestinationCatalog) -> Void) {
    lock.lock()
    var catalog = readCatalog()
    update(&catalog)
    writeCatalog(catalog)
    lock.unlock()
    notifyCatalogChanged()
  }

  private func notifyCatalogChanged() {
    notificationCenter.post(name: .navOSSCarPlayDestinationCatalogDidChange, object: self)
  }

  private func writeCatalog(_ catalog: NavOSSCarPlayDestinationCatalog) {
    guard let data = try? JSONEncoder().encode(catalog) else {
      return
    }
    defaults.set(data, forKey: key)
  }
}
