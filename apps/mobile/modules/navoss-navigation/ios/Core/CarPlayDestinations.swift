import Foundation

private let destinationOmittedContext: Set<String> = [
  "canada", "ca", "alberta", "ab", "british columbia", "bc"
]
private let destinationOmittedCategories: Set<String> = [
  "poi", "yes", "no", "unknown", "other", "point of interest", "point_of_interest",
  "building", "shop", "amenity", "house"
]
private let destinationPostalCode = try! NSRegularExpression(
  pattern: #"^[A-Z]\d[A-Z]\s?\d[A-Z]\d$"#, options: .caseInsensitive
)
private let destinationAdministrativeBreadcrumb = try! NSRegularExpression(
  pattern: #"^(?:Regional District of|Town of|City of|Westbank First Nation|Improvement District|Area [A-Z]\b)|\belectoral area$"#,
  options: .caseInsensitive
)
private let destinationHouseNumber = try! NSRegularExpression(pattern: #"^\d+[\p{L}\d/-]*$"#)

private func destinationIdentityKey(_ id: String) -> String {
  if id.hasPrefix("map-poi:") {
    let osmId = id.dropFirst("map-poi:".count)
    if !osmId.isEmpty && osmId.allSatisfy(\.isNumber) {
      return "osm:\(osmId)"
    }
  }

  let components = id.split(separator: ":", omittingEmptySubsequences: false)
  if components.count == 3, components[0] == "nominatim" {
    let osmId = components[2]
    if !osmId.isEmpty && osmId.allSatisfy(\.isNumber) {
      return "osm:\(osmId)"
    }
  }

  return "id:\(id)"
}

extension Notification.Name {
  public static let navOSSCarPlayDestinationCatalogDidChange = Notification.Name(
    "org.navoss.mobile.carplay-destination-catalog-did-change"
  )
}

public struct NavOSSCarPlayDestination: Codable, Equatable, Sendable {
  public let category: String?
  public let id: String
  public let label: String
  public let latitude: Double
  public let longitude: Double
  public let name: String
  public let placeCategory: String?
  // Query relevance is transient: never persist it with a saved place or an active trip.
  public private(set) var searchConfidence: Double? = nil

  private enum CodingKeys: String, CodingKey {
    case category, id, label, latitude, longitude, name, placeCategory
  }

  public init(
    category: String? = nil,
    placeCategory: String? = nil,
    searchConfidence: Double? = nil,
    id: String,
    label: String,
    latitude: Double,
    longitude: Double,
    name: String
  ) {
    self.category = category
    self.id = id
    self.label = label
    self.latitude = latitude
    self.longitude = longitude
    self.name = name
    self.placeCategory = placeCategory
    self.searchConfidence = searchConfidence
  }

  public static func == (left: Self, right: Self) -> Bool {
    left.category == right.category && left.id == right.id && left.label == right.label
      && left.latitude == right.latitude && left.longitude == right.longitude
      && left.name == right.name && left.placeCategory == right.placeCategory
  }

  var isValid: Bool {
    !id.isEmpty && !name.isEmpty && latitude.isFinite && longitude.isFinite
      && (-90...90).contains(latitude) && (-180...180).contains(longitude)
  }

  public var searchSubtitle: String {
    let parts = label.split(separator: ",").map {
      String($0).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let start = parts.first?.caseInsensitiveCompare(name) == .orderedSame ? 1 : 0
    let context = parts.dropFirst(start).filter { part in
      let range = NSRange(part.startIndex..<part.endIndex, in: part)
      return !part.isEmpty
        && !destinationOmittedContext.contains(part.lowercased())
        && destinationPostalCode.firstMatch(in: part, range: range) == nil
        && destinationAdministrativeBreadcrumb.firstMatch(in: part, range: range) == nil
    }
    guard let leading = context.first else { return "" }
    let range = NSRange(leading.startIndex..<leading.endIndex, in: leading)
    let address =
      destinationHouseNumber.firstMatch(in: leading, range: range) != nil && context.count > 1
      ? "\(leading) \(context[1])" : leading
    guard let city = context.last,
      city != address,
      !(address != leading && city == context[1])
    else { return address }
    return "\(address), \(city)"
  }

  public var searchCategoryLabel: String? {
    let detail = placeCategory?.trimmingCharacters(in: .whitespacesAndNewlines)
    let raw: String
    if let detail, !detail.isEmpty, !destinationOmittedCategories.contains(detail.lowercased()) {
      raw = detail
    } else {
      raw = (category ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard !raw.isEmpty, !destinationOmittedCategories.contains(raw.lowercased()) else { return nil }
    let description =
      raw == "fuel" ? "gas station"
      : raw == "train_station" || raw == "station" ? "train station"
      : raw == "wholesale" ? "warehouse store"
      : raw.replacingOccurrences(of: "_", with: " ")
    let words = description.split(separator: " ").prefix(3).joined(separator: " ")
    if words.lowercased().hasPrefix("lrt ") { return "LRT \(words.dropFirst(4))" }
    if words.caseInsensitiveCompare("atm") == .orderedSame { return "ATM" }
    return words.prefix(1).uppercased() + words.dropFirst()
  }
}

public func navOSSCarPlayDestinationDetail(
  _ destination: NavOSSCarPlayDestination,
  distanceLabel: String? = nil
) -> String {
  var detail = distanceLabel ?? ""
  if let category = destination.searchCategoryLabel {
    if !detail.isEmpty { detail += " · " }
    detail += category
  }
  let subtitle = destination.searchSubtitle
  if !subtitle.isEmpty {
    if !detail.isEmpty { detail += " · " }
    detail += subtitle
  }
  return detail
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
    return destinations.filter { seenIds.insert(destinationIdentityKey($0.id)).inserted }
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
    let identityKey = destinationIdentityKey(destination.id)
    catalog.recents.removeAll { destinationIdentityKey($0.id) == identityKey }
    catalog.recents.insert(destination, at: 0)
    catalog.recents = Array(catalog.recents.prefix(maximumRecentCount))
    writeCatalog(catalog)
    lock.unlock()
    notifyCatalogChanged()
  }

  public func clearRecents() {
    updateCatalog { $0.recents = [] }
  }

  public func clearDestinations() {
    lock.lock()
    defaults.removeObject(forKey: key)
    lock.unlock()
    notifyCatalogChanged()
  }

  public func replaceFavorites(_ favorites: [NavOSSCarPlayDestination]) {
    lock.lock()
    var catalog = readCatalog()
    var seenIds = Set<String>()
    catalog.favorites = Array(
      favorites.filter {
        $0.isValid && seenIds.insert(destinationIdentityKey($0.id)).inserted
      }.prefix(20)
    )
    writeCatalog(catalog)
    lock.unlock()
    notifyCatalogChanged()
  }

  public func isFavorite(id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let identityKey = destinationIdentityKey(id)
    return readCatalog().favorites.contains { destinationIdentityKey($0.id) == identityKey }
  }

  @discardableResult
  public func toggleFavorite(_ destination: NavOSSCarPlayDestination) -> Bool {
    guard destination.isValid else {
      return false
    }

    lock.lock()
    var catalog = readCatalog()
    let identityKey = destinationIdentityKey(destination.id)
    if let index = catalog.favorites.firstIndex(where: {
      destinationIdentityKey($0.id) == identityKey
    }) {
      catalog.favorites.remove(at: index)
      writeCatalog(catalog)
      lock.unlock()
      notifyCatalogChanged()
      return false
    }
    catalog.favorites.insert(destination, at: 0)
    catalog.favorites = Array(catalog.favorites.prefix(20))
    writeCatalog(catalog)
    lock.unlock()
    notifyCatalogChanged()
    return true
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

public struct NavOSSCarPlaySearchPresentation: Sendable {
  public let destinations: [NavOSSCarPlayDestination]
  public let savedPrefixes: [String: String]
}

private let destinationSearchSeparators = try! NSRegularExpression(pattern: #"[^\p{L}\p{N}]+"#)
private let destinationStoreNumber = try! NSRegularExpression(pattern: #"\s+#\d{2,}\s*$"#)
private let destinationLegalSuffix = try! NSRegularExpression(
  pattern: #"(?: (?:inc|incorporated|ltd|limited|llc|corp|corporation))+$"#
)
private let destinationCivicAddress = try! NSRegularExpression(
  pattern: #"^(?:#([\p{L}\d/-]+)\s+)?(\d+[\p{L}\d/-]*)\s+(.+)$"#
)
private let destinationStationSuffix = try! NSRegularExpression(
  pattern: #" (?:lrt |train |railway )?station$"#
)
private let destinationStreetWord = try! NSRegularExpression(
  pattern: #"\b(?:street|st|avenue|ave?|drive|dr|trail|tr|road|rd|boulevard|blvd|bv|gate|ga|common|circle|cir|way|highway|hwy|crescent|cres|place|pl|lane|ln|court|ct|terrace|terr|tc|link|li)\b"#,
  options: .caseInsensitive
)
private let destinationSearchLocale = Locale(identifier: "en_CA")
// The same civic abbreviations as the API's Calgary street-type registry.
private let destinationStreetAliases: [String: String] = [
  "alley": "al", "ave": "av", "avenue": "av", "bay": "ba", "blvd": "bv",
  "boulevard": "bv", "cape": "ca", "center": "ce", "centre": "ce",
  "cir": "ci", "circle": "ci", "close": "cl", "common": "cm", "court": "co", "ct": "co",
  "cres": "cr", "crescent": "cr", "cove": "cv", "drive": "dr", "gate": "ga",
  "garden": "gd", "gardens": "gd", "green": "gr", "grove": "gv", "heath": "he",
  "highway": "hi", "hwy": "hi", "hill": "hl", "height": "ht", "heights": "ht", "hts": "ht",
  "island": "is", "landing": "ld", "link": "li", "lane": "ln", "mews": "me",
  "manor": "mr", "mount": "mt", "park": "pa", "path": "ph", "place": "pl",
  "parade": "pr", "passage": "ps", "point": "pt", "parkway": "py", "pkwy": "py",
  "plaza": "pz", "road": "rd", "rise": "ri", "row": "ro", "square": "sq",
  "street": "st", "terr": "tc", "terrace": "tc", "trail": "tr", "villa": "vi",
  "villas": "vi", "view": "vw", "walk": "wk", "way": "wy",
  "east": "e", "northeast": "ne", "northwest": "nw", "southeast": "se",
  "southwest": "sw", "west": "w"
]

private func destinationSearchText(_ value: String) -> String {
  let folded = value.folding(
    options: [.caseInsensitive, .diacriticInsensitive], locale: destinationSearchLocale
  ).replacingOccurrences(of: "&", with: " and ")
  let separated = destinationSearchSeparators.stringByReplacingMatches(
    in: folded, range: NSRange(folded.startIndex..<folded.endIndex, in: folded), withTemplate: " "
  )
  return separated.split(whereSeparator: \.isWhitespace).map {
    destinationStreetAliases[String($0)] ?? String($0)
  }.joined(separator: " ")
}

private func destinationSearchName(_ value: String) -> String {
  let withoutStoreNumber = destinationStoreNumber.stringByReplacingMatches(
    in: value, range: NSRange(value.startIndex..<value.endIndex, in: value), withTemplate: ""
  )
  let name = destinationSearchText(withoutStoreNumber)
  let withoutLegalSuffix = destinationLegalSuffix.stringByReplacingMatches(
    in: name, range: NSRange(name.startIndex..<name.endIndex, in: name), withTemplate: ""
  )
  return withoutLegalSuffix.hasSuffix(" wholesale")
    ? String(withoutLegalSuffix.dropLast(10)) : withoutLegalSuffix
}

private struct DestinationSearchCandidate {
  let destination: NavOSSCarPlayDestination
  let name: String
  let kind: String?
  let houseNumber: String?
  let unit: String?
  let street: String?
  let distance: Double
  let order: Int
  var confidence: Double

  init(
    _ destination: NavOSSCarPlayDestination,
    wanted: String,
    origin: NavOSSCarPlayCoordinate?,
    remote: Bool,
    order: Int
  ) {
    self.destination = destination
    self.name = destinationSearchName(destination.name)
    self.order = order
    self.distance = origin.flatMap { $0.isValid ? $0 : nil }.map {
      navOSSCarPlayDistanceMeters(from: $0, to: destination)
    } ?? .infinity
    let description = (destination.placeCategory ?? destination.category ?? "")
      .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: destinationSearchLocale)
      .replacingOccurrences(of: "_", with: " ")
    if ["station", "train station", "lrt station", "platform", "transit platform", "transit stop"].contains(description) {
      self.kind = "rail-station"
    } else if description == "warehouse store" || description == "wholesale" {
      self.kind = "wholesale"
    } else if description.hasSuffix("cafe") {
      self.kind = "cafe"
    } else if description.hasSuffix("restaurant") || description == "fast food" {
      self.kind = "restaurant"
    } else if description.isEmpty || destinationOmittedCategories.contains(description)
      || ["address", "street", "neighborhood", "landmark"].contains(description) {
      self.kind = nil
    } else {
      self.kind = description
    }
    let subtitle = destination.searchSubtitle
    var location = String(subtitle.split(separator: ",", maxSplits: 1).first ?? "")
    var address = destinationCivicAddress.firstMatch(
      in: location, range: NSRange(location.startIndex..<location.endIndex, in: location)
    )
    if address == nil && destinationStreetWord.firstMatch(
      in: destination.name, range: NSRange(destination.name.startIndex..<destination.name.endIndex, in: destination.name)
    ) != nil {
      location = destination.name
      address = destinationCivicAddress.firstMatch(
        in: location, range: NSRange(location.startIndex..<location.endIndex, in: location)
      )
    }
    func capture(_ index: Int) -> String? {
      guard let address, let range = Range(address.range(at: index), in: location) else { return nil }
      return destinationSearchText(String(location[range]))
    }
    self.unit = capture(1)
    self.houseNumber = capture(2)
    self.street = capture(3)
    if remote, let confidence = destination.searchConfidence {
      self.confidence = confidence
    } else if name == wanted {
      self.confidence = 0.98
    } else if name.hasPrefix(wanted) {
      self.confidence = 0.94
    } else {
      let labelWords = destinationSearchText(destination.label).split(separator: " ")
      let wantedWords = wanted.split(separator: " ")
      let nameWords = name.split(separator: " ")
      if wanted.hasPrefix("\(name) ") && wantedWords.allSatisfy({ labelWords.contains($0) }) {
        self.confidence = 0.98
      } else if wantedWords.allSatisfy({ word in nameWords.contains { $0.hasPrefix(word) } }) {
        self.confidence = 0.88
      } else if name.contains(wanted) {
        self.confidence = 0.84
      } else if wantedWords.allSatisfy({ labelWords.contains($0) }) {
        self.confidence = 0.72
      } else {
        self.confidence = 0.6
      }
    }
  }

  func isSamePlace(as other: DestinationSearchCandidate) -> Bool {
    if destination.id == other.destination.id { return true }
    let stationVariant = kind == "rail-station" && other.kind == "rail-station"
      && destinationStationSuffix.stringByReplacingMatches(
        in: name, range: NSRange(name.startIndex..<name.endIndex, in: name), withTemplate: ""
      ) == destinationStationSuffix.stringByReplacingMatches(
        in: other.name, range: NSRange(other.name.startIndex..<other.name.endIndex, in: other.name), withTemplate: ""
      )
    guard name == other.name || stationVariant else { return false }
    if let houseNumber, let otherNumber = other.houseNumber, houseNumber != otherNumber { return false }
    if let unit, let otherUnit = other.unit, unit != otherUnit { return false }
    if let kind, let otherKind = other.kind, kind != otherKind { return false }
    let sameAddress = houseNumber != nil && houseNumber == other.houseNumber && street != nil && street == other.street
    let leftId = destination.id.split(separator: ":")
    let rightId = other.destination.id.split(separator: ":")
    if kind != "rail-station" && other.kind != "rail-station"
      && kind != "university" && other.kind != "university"
      && leftId.count == 3 && rightId.count == 3
      && leftId[0] == rightId[0] && leftId[1] == rightId[1] {
      return false
    }
    let radius: Double = kind == "university" || other.kind == "university"
      ? 1_000 : sameAddress ? 250 : 150
    return navOSSCarPlayDistanceMeters(
      from: NavOSSCarPlayCoordinate(latitude: destination.latitude, longitude: destination.longitude),
      to: other.destination
    ) <= radius
  }
}

private struct DestinationSearchCluster {
  var representative: DestinationSearchCandidate
  var members: [DestinationSearchCandidate]
}

/// Fresh provider rows win duplicate identity; at most two explicit saved places are pinned.
/// Recents remain ordinary ranked candidates, never a second priority section.
public func navOSSCarPlaySearchPresentation(
  remoteDestinations: [NavOSSCarPlayDestination],
  catalog: NavOSSCarPlayDestinationCatalog,
  query: String,
  origin: NavOSSCarPlayCoordinate?,
  limit: Int = 8
) -> NavOSSCarPlaySearchPresentation {
  let wanted = destinationSearchName(query)
  var clusters: [DestinationSearchCluster] = []
  clusters.reserveCapacity(remoteDestinations.count + catalog.recents.count + catalog.favorites.count + 2)
  for (index, destination) in remoteDestinations.enumerated() {
    let candidate = DestinationSearchCandidate(destination, wanted: wanted, origin: origin, remote: true, order: index)
    if let duplicate = clusters.firstIndex(where: { $0.members.allSatisfy { $0.isSamePlace(as: candidate) } }) {
      if clusters[duplicate].representative.destination.placeCategory == nil && destination.placeCategory != nil {
        var enriched = candidate
        enriched.confidence = max(candidate.confidence, clusters[duplicate].representative.confidence)
        clusters[duplicate].representative = enriched
      }
      clusters[duplicate].members.append(candidate)
    } else {
      clusters.append(DestinationSearchCluster(representative: candidate, members: [candidate]))
    }
  }
  let local = catalog.searchableDestinations
  for (index, destination) in local.enumerated() {
    let candidate = DestinationSearchCandidate(
      destination, wanted: wanted, origin: origin, remote: false, order: remoteDestinations.count + index
    )
    let duplicate = clusters.firstIndex(where: {
      $0.members.contains { $0.destination.id == destination.id }
    }) ?? clusters.firstIndex(where: { $0.members.allSatisfy { $0.isSamePlace(as: candidate) } })
    guard duplicate != nil || candidate.confidence >= 0.72 else { continue }
    if let duplicate {
      clusters[duplicate].members.append(candidate)
    } else {
      clusters.append(DestinationSearchCluster(representative: candidate, members: [candidate]))
    }
  }
  var counts: [String: Int] = [:]
  for cluster in clusters { counts[cluster.representative.name, default: 0] += 1 }
  if (counts[wanted, default: 0] > 1) {
    for index in clusters.indices {
      if clusters[index].representative.name.hasPrefix(wanted)
        && clusters[index].representative.confidence != 1 {
        clusters[index].representative.confidence = 0.94
      }
    }
  }
  let ranked = clusters.indices.sorted {
    let left = clusters[$0].representative
    let right = clusters[$1].representative
    if left.confidence != right.confidence { return left.confidence > right.confidence }
    if left.distance != right.distance { return left.distance < right.distance }
    return left.order < right.order
  }
  var saved: [(NavOSSCarPlayDestination, String)] = []
  if let home = catalog.home { saved.append((home, "Saved Home")) }
  if let work = catalog.work { saved.append((work, "Saved Work")) }
  for favorite in catalog.favorites { saved.append((favorite, "Saved")) }
  var pinned: [Int] = []
  var prefixes: [String: String] = [:]
  for (destination, prefix) in saved {
    let candidate = DestinationSearchCandidate(destination, wanted: wanted, origin: origin, remote: false, order: 0)
    let exact = ranked.first(where: {
      clusters[$0].members.contains { $0.destination.id == destination.id }
    })
    guard let match = exact ?? ranked.first(where: {
      clusters[$0].members.contains { $0.isSamePlace(as: candidate) }
    }) else { continue }
    let id = clusters[match].representative.destination.id
    if pinned.contains(match) {
      if (prefixes[id] == "Saved Home" && prefix == "Saved Work")
        || (prefixes[id] == "Saved Work" && prefix == "Saved Home") {
        prefixes[id] = "Saved Home & Work"
      }
    } else if pinned.count < 2 {
      pinned.append(match)
      prefixes[id] = prefix
    }
  }
  let order = pinned + ranked.filter { !pinned.contains($0) }
  return NavOSSCarPlaySearchPresentation(
    destinations: order.prefix(limit).map { clusters[$0].representative.destination },
    savedPrefixes: prefixes
  )
}
