import Foundation

/// Upload rules from `GET /v2/traffic/status` (`probes.*`).
public struct NavOSSTrafficProbeRules: Equatable, Sendable {
  public let batchTargetMeters: Double
  public let batchTargetSeconds: Double
  public let maxBatchSeconds: Int
  public let maxGapSeconds: Int
  public let maxPoints: Int
  public let minPoints: Int
  public let sampleIntervalSeconds: Double
  public let schemaVersion: Int
  public let tripEndTrimMeters: Double

  public init(
    batchTargetMeters: Double = 600,
    batchTargetSeconds: Double = 60,
    maxBatchSeconds: Int = 300,
    maxGapSeconds: Int = 15,
    maxPoints: Int = 240,
    minPoints: Int = 10,
    sampleIntervalSeconds: Double = 2,
    schemaVersion: Int = 1,
    tripEndTrimMeters: Double = 400
  ) {
    self.batchTargetMeters = batchTargetMeters
    self.batchTargetSeconds = batchTargetSeconds
    self.maxBatchSeconds = maxBatchSeconds
    self.maxGapSeconds = maxGapSeconds
    self.maxPoints = maxPoints
    self.minPoints = minPoints
    self.sampleIntervalSeconds = sampleIntervalSeconds
    self.schemaVersion = schemaVersion
    // The privacy policy promises at least 400 m; a server advertising less is not obeyed.
    self.tripEndTrimMeters = max(400, tripEndTrimMeters)
  }

  /// Fixes less accurate than this are never uploaded.
  public static let maximumHorizontalAccuracyMeters = 25.0
  /// The server refuses a batch whose first point (`capturedAt`, rounded down to the minute) is
  /// more than ten minutes old. A batch is closed or dropped well before that: this limit plus up
  /// to 59 s of minute rounding plus the upload stays under ten minutes.
  public static let maximumFirstPointAgeSeconds = 450.0
}

/// One positioning fix from active navigation.
public struct NavOSSTrafficFix: Equatable, Sendable {
  public let coordinate: NavOSSCarPlayCoordinate
  public let horizontalAccuracyMeters: Double
  public let timestamp: Date

  public init(coordinate: NavOSSCarPlayCoordinate, horizontalAccuracyMeters: Double, timestamp: Date)
  {
    self.coordinate = coordinate
    self.horizontalAccuracyMeters = horizontalAccuracyMeters
    self.timestamp = timestamp
  }
}

public struct NavOSSTrafficProbePoint: Equatable, Sendable {
  /// Rounded to five decimals.
  public let latitude: Double
  public let longitude: Double
  /// Whole seconds since the batch's first point.
  public let offsetSeconds: Int
}

/// One `POST /v2/traffic/probes` body without its credential. Held in memory until sent once.
public struct NavOSSTrafficProbeBatch: Equatable, Sendable {
  /// First point's UTC time rounded down to the minute.
  public let capturedAt: Date
  public let firstPointAt: Date
  public let points: [NavOSSTrafficProbePoint]
  public let schemaVersion: Int

  /// The strict request body: exactly `capturedAt`, `credential`, `points`, `schemaVersion`.
  func requestBody(credential: String) throws -> Data {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(identifier: "UTC")
    let points = points.map {
      "[\(navOSSFiveDecimals($0.longitude)),\(navOSSFiveDecimals($0.latitude)),\($0.offsetSeconds)]"
    }
    guard credential.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
      credential.unicodeScalars.allSatisfy(\.isASCII)
    else {
      throw NavOSSCommunityFailure.invalidRequest
    }
    let json =
      "{\"capturedAt\":\"\(formatter.string(from: capturedAt))\",\"credential\":\"\(credential)\","
      + "\"points\":[\(points.joined(separator: ","))],\"schemaVersion\":\(schemaVersion)}"
    return Data(json.utf8)
  }
}

func navOSSFiveDecimals(_ value: Double) -> String {
  String(format: "%.5f", locale: Locale(identifier: "en_US_POSIX"), value)
}

func navOSSRoundedToFiveDecimals(_ value: Double) -> Double {
  (value * 100_000).rounded() / 100_000
}

/// The client half of the community-traffic privacy contract, as pure logic:
///
/// - only fixes at most 25 m accurate, about one per `sampleIntervalSeconds`, rounded to five
///   decimals;
/// - nothing within `tripEndTrimMeters` (straight line) of the trip's first fix, the route
///   origin, the destination, or any stop, and nothing in the first `tripEndTrimMeters` of path;
/// - the latest `tripEndTrimMeters` of path are held back, and whatever is held back when the
///   trip ends is discarded, so the real end of a trip is never sent even when it is not the
///   planned destination;
/// - batches close at the target time and distance, the point cap or the duration cap, and
///   never span a gap longer than `maxGapSeconds` or a trimmed stretch;
/// - a batch that would be stale on arrival is dropped, never sent late.
///
/// Everything lives in memory; nothing is persisted.
public struct NavOSSTrafficProbeCollector: Sendable {
  private struct PathFix {
    let coordinate: NavOSSCarPlayCoordinate
    let pathMeters: Double
    let timestamp: Date
  }

  private struct Open {
    var points: [NavOSSTrafficProbePoint]
    let first: PathFix
    var last: PathFix
  }

  public let rules: NavOSSTrafficProbeRules
  private var protectedPoints: [NavOSSCarPlayCoordinate]
  private var lastAccepted: PathFix?
  private var movementAnchor: NavOSSCarPlayCoordinate?
  /// Displacement from the movement anchor below which a fix counts as standing still.
  static let minimumCredibleMovementMeters = 20.0
  static let maximumPlausibleSpeedMetersPerSecond = 70.0
  private var pending: [PathFix] = []
  private var open: Open?

  public init(rules: NavOSSTrafficProbeRules, protectedPoints: [NavOSSCarPlayCoordinate]) {
    self.rules = rules
    self.protectedPoints = protectedPoints.filter(\.isValid)
  }

  /// A stop added or a destination changed mid-trip: its surroundings are protected from now on,
  /// including fixes still held back.
  public mutating func protect(_ coordinates: [NavOSSCarPlayCoordinate]) {
    for coordinate in coordinates where coordinate.isValid && !protectedPoints.contains(coordinate) {
      protectedPoints.append(coordinate)
    }
  }

  /// Adds a fix and returns the batches it completes.
  public mutating func ingest(_ fix: NavOSSTrafficFix) -> [NavOSSTrafficProbeBatch] {
    var ready = expire(now: fix.timestamp)
    guard fix.coordinate.isValid,
      fix.horizontalAccuracyMeters >= 0,
      fix.horizontalAccuracyMeters <= NavOSSTrafficProbeRules.maximumHorizontalAccuracyMeters
    else {
      return ready
    }
    let pathMeters: Double
    if let lastAccepted {
      let elapsed = fix.timestamp.timeIntervalSince(lastAccepted.timestamp)
      guard elapsed >= rules.sampleIntervalSeconds - 0.25 else { return ready }
      // A jump no road vehicle could make is discarded: it neither moves the trims nor is sent.
      let step = Self.distance(lastAccepted.coordinate, fix.coordinate)
      guard step <= Self.maximumPlausibleSpeedMetersPerSecond * elapsed else { return ready }
      // The trims are measured on credible movement only: path advances when the fix leaves the
      // anchor by more than its accuracy allows, so GPS jitter while parked never adds up to
      // the 400 m that would release a trip's protected end. Stationary fixes still queue, so
      // a stopped car reports low speed once it has really moved on.
      let anchor = movementAnchor ?? lastAccepted.coordinate
      let fromAnchor = Self.distance(anchor, fix.coordinate)
      if fromAnchor > max(Self.minimumCredibleMovementMeters, 2 * fix.horizontalAccuracyMeters) {
        pathMeters = lastAccepted.pathMeters + fromAnchor
        movementAnchor = fix.coordinate
      } else {
        pathMeters = lastAccepted.pathMeters
      }
    } else {
      // The first fix of the trip is protected wherever the route said the trip began.
      protect([fix.coordinate])
      movementAnchor = fix.coordinate
      pathMeters = 0
    }
    let accepted = PathFix(coordinate: fix.coordinate, pathMeters: pathMeters, timestamp: fix.timestamp)
    lastAccepted = accepted
    pending.append(accepted)
    // Release only what the path has left at least `tripEndTrimMeters` behind.
    while let first = pending.first, pathMeters - first.pathMeters >= rules.tripEndTrimMeters {
      pending.removeFirst()
      ready += release(first)
    }
    return ready
  }

  /// Called on a clock while no fix arrives (stopped in traffic, tunnel): closes or drops a batch
  /// before it can go stale and forgets held-back fixes that could no longer be sent in time.
  public mutating func tick(now: Date) -> [NavOSSTrafficProbeBatch] {
    expire(now: now)
  }

  /// The trip ended (arrival, cancellation, sharing switched off): everything held back and the
  /// open batch are discarded, never sent.
  public mutating func finish() {
    pending.removeAll()
    open = nil
    lastAccepted = nil
    movementAnchor = nil
  }

  private mutating func expire(now: Date) -> [NavOSSTrafficProbeBatch] {
    let limit = NavOSSTrafficProbeRules.maximumFirstPointAgeSeconds
    var ready: [NavOSSTrafficProbeBatch] = []
    if let open, now.timeIntervalSince(open.first.timestamp) >= limit {
      ready += close()
    }
    let before = pending.count
    pending.removeAll { now.timeIntervalSince($0.timestamp) >= limit }
    if pending.count != before {
      // A hole in the released sequence: the next batch must not bridge it.
      ready += close()
    }
    return ready
  }

  private func isProtected(_ coordinate: NavOSSCarPlayCoordinate) -> Bool {
    let point = Self.navigationCoordinate(coordinate)
    return protectedPoints.contains {
      navigationDistanceMeters(from: point, to: Self.navigationCoordinate($0))
        < rules.tripEndTrimMeters
    }
  }

  private mutating func release(_ fix: PathFix) -> [NavOSSTrafficProbeBatch] {
    let rounded = NavOSSCarPlayCoordinate(
      latitude: navOSSRoundedToFiveDecimals(fix.coordinate.latitude),
      longitude: navOSSRoundedToFiveDecimals(fix.coordinate.longitude)
    )
    guard fix.pathMeters >= rules.tripEndTrimMeters, !isProtected(fix.coordinate),
      !isProtected(rounded)
    else {
      return close()
    }
    var ready: [NavOSSTrafficProbeBatch] = []
    if let current = open {
      let offset = Int(fix.timestamp.timeIntervalSince(current.first.timestamp).rounded(.down))
      let lastOffset = current.points.last?.offsetSeconds ?? 0
      if offset - lastOffset > rules.maxGapSeconds || offset > rules.maxBatchSeconds {
        ready += close()
      } else if offset <= lastOffset {
        // Two fixes in one whole second: offsets must strictly increase.
        return ready
      }
    }
    if var current = open {
      let offset = Int(fix.timestamp.timeIntervalSince(current.first.timestamp).rounded(.down))
      current.points.append(
        NavOSSTrafficProbePoint(latitude: rounded.latitude, longitude: rounded.longitude, offsetSeconds: offset)
      )
      current.last = fix
      open = current
    } else {
      open = Open(
        points: [
          NavOSSTrafficProbePoint(latitude: rounded.latitude, longitude: rounded.longitude, offsetSeconds: 0)
        ],
        first: fix,
        last: fix
      )
    }
    if let current = open {
      let seconds = Double(current.points.last?.offsetSeconds ?? 0)
      let meters = current.last.pathMeters - current.first.pathMeters
      if (seconds >= rules.batchTargetSeconds && meters >= rules.batchTargetMeters)
        || current.points.count >= rules.maxPoints
        || seconds >= Double(rules.maxBatchSeconds) - rules.sampleIntervalSeconds
      {
        ready += close()
      }
    }
    return ready
  }

  private mutating func close() -> [NavOSSTrafficProbeBatch] {
    guard let current = open else { return [] }
    open = nil
    guard current.points.count >= rules.minPoints else { return [] }
    let minute = (current.first.timestamp.timeIntervalSince1970 / 60).rounded(.down) * 60
    return [
      NavOSSTrafficProbeBatch(
        capturedAt: Date(timeIntervalSince1970: minute),
        firstPointAt: current.first.timestamp,
        points: current.points,
        schemaVersion: rules.schemaVersion
      )
    ]
  }

  private static func distance(_ a: NavOSSCarPlayCoordinate, _ b: NavOSSCarPlayCoordinate) -> Double {
    navigationDistanceMeters(from: navigationCoordinate(a), to: navigationCoordinate(b))
  }

  private static func navigationCoordinate(_ coordinate: NavOSSCarPlayCoordinate)
    -> NavigationCoordinate
  {
    NavigationCoordinate(latitude: coordinate.latitude, longitude: coordinate.longitude)
  }
}
