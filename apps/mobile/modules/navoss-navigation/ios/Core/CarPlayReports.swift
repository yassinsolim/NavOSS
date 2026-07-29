import Foundation

public enum NavOSSCarPlayReportType: String, CaseIterable, Codable, Sendable {
  case collision
  case construction
  case objectOnRoad = "object-on-road"
  case pothole
  case roadClosure = "road-closure"
  case roadHazard = "road-hazard"
  case slowTraffic = "slow-traffic"
  case stalledVehicle = "stalled-vehicle"

  public var label: String {
    switch self {
    case .collision: "Crash"
    case .construction: "Construction"
    case .objectOnRoad: "Object on road"
    case .pothole: "Pothole"
    case .roadClosure: "Road closed"
    case .roadHazard: "Other hazard"
    case .slowTraffic: "Slow traffic"
    case .stalledVehicle: "Stopped vehicle"
    }
  }
}

public struct NavOSSCarPlayReportDraft: Codable, Equatable, Sendable {
  public let coordinate: NavOSSCarPlayCoordinate
  public let createdAt: Date
  public let expiresAt: Date
  public let id: UUID
  public let type: NavOSSCarPlayReportType
}

public final class NavOSSCarPlayReportStore: @unchecked Sendable {
  public static let shared = NavOSSCarPlayReportStore()

  private let defaults: UserDefaults
  private let expirationInterval: TimeInterval
  private let key: String
  private let lock = NSLock()
  private let maximumDrafts: Int

  public init(
    defaults: UserDefaults = .standard,
    key: String = "org.navoss.mobile.carplay.private-report-drafts",
    expirationInterval: TimeInterval = 2 * 60 * 60,
    maximumDrafts: Int = 25
  ) {
    self.defaults = defaults
    self.expirationInterval = expirationInterval
    self.key = key
    self.maximumDrafts = maximumDrafts
  }

  @discardableResult
  public func record(
    _ type: NavOSSCarPlayReportType,
    coordinate: NavOSSCarPlayCoordinate,
    now: Date = Date()
  ) -> NavOSSCarPlayReportDraft? {
    guard coordinate.isValid else {
      return nil
    }
    let draft = NavOSSCarPlayReportDraft(
      coordinate: coordinate,
      createdAt: now,
      expiresAt: now.addingTimeInterval(expirationInterval),
      id: UUID(),
      type: type
    )
    lock.lock()
    let drafts = [draft] + decodedDrafts().filter { $0.expiresAt > now }
    if let data = try? JSONEncoder().encode(Array(drafts.prefix(maximumDrafts))) {
      defaults.set(data, forKey: key)
    }
    lock.unlock()
    return draft
  }

  public func load(now: Date = Date()) -> [NavOSSCarPlayReportDraft] {
    lock.lock()
    defer { lock.unlock() }
    return decodedDrafts().filter { $0.expiresAt > now }.prefix(maximumDrafts).map { $0 }
  }

  private func decodedDrafts() -> [NavOSSCarPlayReportDraft] {
    guard let data = defaults.data(forKey: key),
      let drafts = try? JSONDecoder().decode([NavOSSCarPlayReportDraft].self, from: data)
    else {
      return []
    }
    return drafts
  }
}
