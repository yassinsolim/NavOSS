import Foundation

// MARK: - Optional route annotations
//
// Everything in this section is an optional input. `/v2/routes` carries lanes, maneuver
// modifiers, exits, signposts and (with community traffic) congestion when the map data has them;
// `/v1/routes` and many roads have none, and NavOSS must never invent them, so every consumer
// below treats `nil` (or a malformed value) as "render nothing" rather than guessing.

/// One arrow painted on a lane, in the order drivers read them. Raw values match the OSRM/Valhalla
/// lane `indications` vocabulary with spaces replaced by underscores.
public enum NavOSSCarPlayLaneIndication: String, Codable, CaseIterable, Sendable {
  /// An unmarked lane.
  case none
  case uturn
  case sharpLeft = "sharp_left"
  case left
  case slightLeft = "slight_left"
  case straight
  case slightRight = "slight_right"
  case right
  case sharpRight = "sharp_right"
  case mergeLeft = "merge_left"
  case mergeRight = "merge_right"

  /// Angle relative to straight ahead: 0° is straight, negative is to the left, positive to the
  /// right. U-turns are drawn to the left because Canada drives on the right.
  public var angleDegrees: Double {
    switch self {
    case .uturn: -180
    case .sharpLeft: -135
    case .left: -90
    case .slightLeft, .mergeLeft: -45
    case .none, .straight: 0
    case .slightRight, .mergeRight: 45
    case .right: 90
    case .sharpRight: 135
    }
  }
}

/// A single lane at the approach to a maneuver, ordered left to right. Coding keys match the route
/// contract's step `lanes` (`indications`, `valid`, `active`, `validIndication`).
public struct NavOSSCarPlayLane: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey {
    case indications
    case isValid = "valid"
    case isPreferred = "active"
    case activeIndication = "validIndication"
  }

  /// Every arrow painted on the lane.
  public let indications: [NavOSSCarPlayLaneIndication]
  /// Whether the lane can be used to follow the route.
  public let isValid: Bool
  /// Whether the routing engine prefers this lane among the valid ones.
  public let isPreferred: Bool
  /// The arrow to follow in this lane, when the provider says which one.
  public let activeIndication: NavOSSCarPlayLaneIndication?

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    indications = try container.decode([NavOSSCarPlayLaneIndication].self, forKey: .indications)
    isValid = try container.decode(Bool.self, forKey: .isValid)
    isPreferred = try container.decodeIfPresent(Bool.self, forKey: .isPreferred) ?? false
    activeIndication = try container.decodeIfPresent(
      NavOSSCarPlayLaneIndication.self, forKey: .activeIndication)
  }

  public init(
    indications: [NavOSSCarPlayLaneIndication],
    isValid: Bool,
    isPreferred: Bool = false,
    activeIndication: NavOSSCarPlayLaneIndication? = nil
  ) {
    self.indications = indications
    self.isValid = isValid
    self.isPreferred = isPreferred
    self.activeIndication = activeIndication
  }
}

/// Congestion on one route geometry segment. Only real observations may produce anything other
/// than `.unknown`; the renderer draws nothing for unknown or free-flowing segments.
public enum NavOSSCarPlayCongestionLevel: String, Codable, CaseIterable, Sendable {
  case unknown
  case free
  case slow
  case heavy
  case stopped
}

/// How a lane should be drawn by CarPlay's `CPLane`.
public struct NavOSSCarPlayLaneSpec: Equatable, Sendable {
  public enum Status: Equatable, Sendable {
    case notGood
    case good
    case preferred
  }

  /// Angles other than the highlighted one. CarPlay requires the highlighted angle to be absent
  /// from this list.
  public let angles: [Double]
  public let highlightedAngle: Double?
  public let status: Status
}

/// Converts optional provider lanes into CarPlay lane specs, or `nil` when there is nothing
/// trustworthy to show. A lane list with no usable lane is dropped: highlighting nothing would tell
/// the driver every lane is wrong.
public func navOSSCarPlayLaneSpecs(_ lanes: [NavOSSCarPlayLane]?) -> [NavOSSCarPlayLaneSpec]? {
  guard let lanes, !lanes.isEmpty, lanes.allSatisfy({ !$0.indications.isEmpty }),
    lanes.contains(where: \.isValid)
  else {
    return nil
  }
  return lanes.map { lane in
    var angles: [Double] = []
    for indication in lane.indications where !angles.contains(indication.angleDegrees) {
      angles.append(indication.angleDegrees)
    }
    guard lane.isValid else {
      return NavOSSCarPlayLaneSpec(angles: angles, highlightedAngle: nil, status: .notGood)
    }
    let highlighted =
      (lane.activeIndication.flatMap { lane.indications.contains($0) ? $0 : nil }
      ?? lane.indications[0]).angleDegrees
    return NavOSSCarPlayLaneSpec(
      angles: angles.filter { $0 != highlighted },
      highlightedAngle: highlighted,
      status: lane.isPreferred ? .preferred : .good
    )
  }
}

// MARK: - Maneuvers

/// A maneuver classified for display. Mirrors the CarPlay maneuver vocabulary without importing
/// CarPlay into the testable core.
public enum NavOSSCarPlayManeuverKind: Equatable, Sendable {
  case depart
  case straight
  case followRoad
  case slightLeft
  case left
  case sharpLeft
  case slightRight
  case right
  case sharpRight
  case uTurn
  case keepLeft
  case keepRight
  case mergeLeft
  case mergeRight
  case onRamp
  case offRampLeft
  case offRampRight
  case leftAtEnd
  case rightAtEnd
  /// Enter a roundabout; `exit` is the 1-based exit count when the provider states it.
  case roundabout(exit: Int?)
  case exitRoundabout
  case ferry
  case arrive
  case arriveLeft
  case arriveRight

  /// Turn angle used when the route geometry cannot describe the junction.
  public var nominalAngleDegrees: Double {
    switch self {
    case .depart, .straight, .followRoad, .onRamp, .exitRoundabout, .ferry, .arrive: 0
    case .slightLeft, .keepLeft, .mergeLeft, .offRampLeft: -40
    case .left, .leftAtEnd, .arriveLeft: -90
    case .sharpLeft: -135
    case .slightRight, .keepRight, .mergeRight, .offRampRight: 40
    case .right, .rightAtEnd, .arriveRight: 90
    case .sharpRight: 135
    case .uTurn: -180
    case .roundabout: 0
    }
  }

  public var isArrival: Bool {
    switch self {
    case .arrive, .arriveLeft, .arriveRight: true
    default: false
    }
  }
}

private enum ManeuverModifier: String {
  case uturn
  case sharpLeft = "sharp left"
  case left
  case slightLeft = "slight left"
  case straight
  case slightRight = "slight right"
  case right
  case sharpRight = "sharp right"
}

/// Finds the direction a free-text instruction describes. The earliest mention wins, so "Turn right
/// onto Left Bank Road" is a right turn; at the same position the longer phrase wins.
private func navOSSInstructionModifier(_ instruction: String) -> ManeuverModifier? {
  let text = instruction.lowercased()
  let phrases: [(String, ManeuverModifier)] = [
    ("u-turn", .uturn), ("uturn", .uturn), ("u turn", .uturn),
    ("sharp left", .sharpLeft), ("sharp right", .sharpRight),
    ("slight left", .slightLeft), ("slight right", .slightRight),
    ("bear left", .slightLeft), ("bear right", .slightRight),
    ("keep left", .slightLeft), ("keep right", .slightRight),
    ("left", .left), ("right", .right),
    ("straight", .straight), ("continue", .straight),
  ]
  var best: (position: String.Index, length: Int, modifier: ManeuverModifier)?
  for (phrase, modifier) in phrases {
    var searchStart = text.startIndex
    while let range = text.range(of: phrase, range: searchStart..<text.endIndex) {
      let beforeIsBoundary =
        range.lowerBound == text.startIndex
        || !text[text.index(before: range.lowerBound)].isLetter
      let afterIsBoundary =
        range.upperBound == text.endIndex || !text[range.upperBound].isLetter
      if beforeIsBoundary && afterIsBoundary {
        if best == nil || range.lowerBound < best!.position
          || (range.lowerBound == best!.position && phrase.count > best!.length)
        {
          best = (range.lowerBound, phrase.count, modifier)
        }
        break
      }
      searchStart = range.upperBound
    }
  }
  return best?.modifier
}

private let navOSSOrdinalWords: [String: Int] = [
  "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
  "eighth": 8, "ninth": 9, "tenth": 10,
]

/// Reads "take the 2nd exit" / "take the second exit" from an instruction. Returns `nil` rather
/// than guessing when the text does not state an exit.
public func navOSSRoundaboutExitNumber(fromInstruction instruction: String) -> Int? {
  let words = instruction.lowercased()
    .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
    .map(String.init)
  for (index, word) in words.enumerated() where word == "exit" && index > 0 {
    let previous = words[index - 1]
    if let ordinal = navOSSOrdinalWords[previous] { return ordinal }
    let digits = previous.prefix { $0.isNumber }
    if !digits.isEmpty, let number = Int(digits), (1...19).contains(number),
      ["st", "nd", "rd", "th"].contains(String(previous.dropFirst(digits.count)))
    {
      return number
    }
  }
  return nil
}

/// Classifies an OSRM-style maneuver. `modifier` and `roundaboutExit` are optional structured
/// fields; when they are missing the instruction text the provider wrote is used instead.
public func navOSSCarPlayManeuverKind(
  type: String,
  modifier: String? = nil,
  instruction: String,
  roundaboutExit: Int? = nil
) -> NavOSSCarPlayManeuverKind {
  let normalizedType = type.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  let resolvedModifier =
    modifier.flatMap { ManeuverModifier(rawValue: $0.lowercased()) }
    ?? navOSSInstructionModifier(instruction)
  let lowerInstruction = instruction.lowercased()
  let isLeft = resolvedModifier == .left || resolvedModifier == .slightLeft
    || resolvedModifier == .sharpLeft
  let isRight = resolvedModifier == .right || resolvedModifier == .slightRight
    || resolvedModifier == .sharpRight

  switch normalizedType {
  case "depart":
    return .depart
  case "arrive":
    return isLeft ? .arriveLeft : isRight ? .arriveRight : .arrive
  case "roundabout", "rotary", "roundabout turn":
    let exit =
      roundaboutExit.flatMap { (1...19).contains($0) ? $0 : nil }
      ?? navOSSRoundaboutExitNumber(fromInstruction: instruction)
    return .roundabout(exit: exit)
  case "exit roundabout", "exit rotary":
    return .exitRoundabout
  case "on ramp":
    return .onRamp
  case "off ramp":
    return isLeft ? .offRampLeft : .offRampRight
  case "fork":
    return isLeft ? .keepLeft : isRight ? .keepRight : .straight
  case "merge":
    return isLeft ? .mergeLeft : isRight ? .mergeRight : .straight
  case "end of road":
    return isLeft ? .leftAtEnd : .rightAtEnd
  default:
    break
  }
  if lowerInstruction.contains("ferry") {
    return .ferry
  }
  switch resolvedModifier {
  case .uturn: return .uTurn
  case .sharpLeft: return .sharpLeft
  case .left: return .left
  case .slightLeft: return lowerInstruction.contains("keep left") ? .keepLeft : .slightLeft
  case .slightRight: return lowerInstruction.contains("keep right") ? .keepRight : .slightRight
  case .right: return .right
  case .sharpRight: return .sharpRight
  case .straight, nil:
    return normalizedType == "new name" || normalizedType == "continue" ? .followRoad : .straight
  }
}

/// Bearing change through the maneuver at the start of `steps[stepIndex]`, measured from the route
/// geometry: negative turns left, positive right, in (-180, 180]. Roundabouts measure to the end of
/// the roundabout step, so the angle points at the exit actually taken. `nil` when the geometry is
/// too short to describe the junction.
public func navOSSCarPlayManeuverTurnAngle(
  steps: [NavOSSCarPlayRouteStep],
  stepIndex: Int,
  measuresThroughStep: Bool = false
) -> Double? {
  guard stepIndex > 0, stepIndex < steps.count else { return nil }
  let approach = steps[stepIndex - 1].geometry
  // A roundabout step's geometry is the circulation itself, whose last segment runs around the
  // ring rather than along the exit road. Measure the exit road (the next step) when there is one.
  if measuresThroughStep, stepIndex + 1 < steps.count,
    let entryBearing = navOSSCarPlayBearing(alongReversed: approach, meters: 25),
    let exitBearing = navOSSCarPlayBearing(along: steps[stepIndex + 1].geometry, meters: 30)
  {
    var delta = exitBearing - entryBearing
    while delta <= -180 { delta += 360 }
    while delta > 180 { delta -= 360 }
    return delta
  }
  let exit = steps[stepIndex].geometry
  guard
    let entryBearing = navOSSCarPlayBearing(
      alongReversed: approach,
      meters: 25
    ),
    let exitBearing =
      measuresThroughStep
      ? navOSSCarPlayBearing(alongReversed: exit, meters: 20)
      : navOSSCarPlayBearing(along: exit, meters: 30)
  else {
    return nil
  }
  var delta = exitBearing - entryBearing
  while delta <= -180 { delta += 360 }
  while delta > 180 { delta -= 360 }
  return delta
}

/// Bearing of the first `meters` of `geometry`.
private func navOSSCarPlayBearing(
  along geometry: [NavOSSCarPlayCoordinate],
  meters: Double
) -> Double? {
  guard let start = geometry.first,
    let end = navOSSCarPlayPoint(along: geometry, meters: meters),
    end != start
  else { return nil }
  return navOSSCarPlayBearingDegrees(from: start, to: end)
}

/// Bearing of the last `meters` of `geometry`, in the direction of travel.
private func navOSSCarPlayBearing(
  alongReversed geometry: [NavOSSCarPlayCoordinate],
  meters: Double
) -> Double? {
  guard let end = geometry.last,
    let start = navOSSCarPlayPoint(along: Array(geometry.reversed()), meters: meters),
    start != end
  else { return nil }
  return navOSSCarPlayBearingDegrees(from: start, to: end)
}

/// The point `meters` along `geometry`, clamped to its end.
private func navOSSCarPlayPoint(
  along geometry: [NavOSSCarPlayCoordinate],
  meters: Double
) -> NavOSSCarPlayCoordinate? {
  guard geometry.count >= 2 else { return geometry.first }
  var remaining = meters
  for index in 1..<geometry.count {
    let start = geometry[index - 1]
    let end = geometry[index]
    let length = navOSSCarPlayMetersBetween(start, end)
    if length >= remaining, length > 0 {
      let fraction = remaining / length
      return NavOSSCarPlayCoordinate(
        latitude: start.latitude + (end.latitude - start.latitude) * fraction,
        longitude: start.longitude + (end.longitude - start.longitude) * fraction
      )
    }
    remaining -= length
  }
  return geometry.last
}

/// Up to `meters` of `geometry`, starting at its beginning.
private func navOSSCarPlayPrefix(
  _ geometry: [NavOSSCarPlayCoordinate],
  meters: Double
) -> [NavOSSCarPlayCoordinate] {
  guard let first = geometry.first else { return [] }
  var result = [first]
  var remaining = meters
  for index in 1..<max(1, geometry.count) {
    let start = geometry[index - 1]
    let end = geometry[index]
    let length = navOSSCarPlayMetersBetween(start, end)
    if length >= remaining {
      if length > 0 {
        let fraction = remaining / length
        result.append(
          NavOSSCarPlayCoordinate(
            latitude: start.latitude + (end.latitude - start.latitude) * fraction,
            longitude: start.longitude + (end.longitude - start.longitude) * fraction
          )
        )
      }
      return result
    }
    result.append(end)
    remaining -= length
  }
  return result
}

func navOSSCarPlayMetersBetween(
  _ start: NavOSSCarPlayCoordinate,
  _ end: NavOSSCarPlayCoordinate
) -> Double {
  let latitudeScale = 111_320.0
  let longitudeScale = latitudeScale * cos((start.latitude + end.latitude) / 2 * .pi / 180)
  return hypot(
    (end.latitude - start.latitude) * latitudeScale,
    (end.longitude - start.longitude) * longitudeScale
  )
}

/// Everything CarPlay shows for one maneuver.
public struct NavOSSCarPlayManeuverInfo: Equatable, Sendable {
  /// Index of the route step that begins with this maneuver.
  public let stepIndex: Int
  public let kind: NavOSSCarPlayManeuverKind
  /// Instruction variants from most to least verbose. Never empty.
  public let instructionVariants: [String]
  /// Road the driver joins at this maneuver, when known.
  public let roadName: String?
  /// Junction exit angle measured from route geometry, or the nominal angle for the kind.
  public let turnAngleDegrees: Double
  /// "Exit 12" style label, only when the provider supplied an exit number.
  public let highwayExitLabel: String?
  /// Lanes at the approach, only when the provider supplied them.
  public let lanes: [NavOSSCarPlayLaneSpec]?
  /// Distance and time from the preceding maneuver to this one.
  public let legDistanceMeters: Double
  public let legDurationSeconds: Double
}

/// Builds display information for the maneuver that begins step `stepIndex`.
public func navOSSCarPlayManeuverInfo(
  trip: NavOSSCarPlayTrip,
  stepIndex: Int
) -> NavOSSCarPlayManeuverInfo? {
  guard trip.steps.indices.contains(stepIndex) else { return nil }
  let step = trip.steps[stepIndex]
  let kind = navOSSCarPlayManeuverKind(
    type: step.maneuverType,
    modifier: step.maneuverModifier,
    instruction: step.instruction,
    roundaboutExit: step.roundaboutExit
  )
  let isRoundabout: Bool
  if case .roundabout = kind { isRoundabout = true } else { isRoundabout = false }
  let providerAngle: Double? = {
    guard !isRoundabout, let before = step.bearingBeforeDegrees, let after = step.bearingAfterDegrees,
      before.isFinite, after.isFinite
    else { return nil }
    var delta = after - before
    while delta <= -180 { delta += 360 }
    while delta > 180 { delta -= 360 }
    return delta
  }()
  let measuredAngle =
    kind.isArrival
    ? nil
    : providerAngle ?? navOSSCarPlayManeuverTurnAngle(
      steps: trip.steps,
      stepIndex: stepIndex,
      measuresThroughStep: isRoundabout
    )
  let roadName = step.roadName.trimmingCharacters(in: .whitespacesAndNewlines)
  let instruction = step.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
  var variants = [instruction]
  let clean: ([String]?) -> [String] = { values in
    (values ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  }
  let branch = clean(step.signpostBranch).joined(separator: " / ")
  let toward =
    clean(step.signpostToward).joined(separator: " / ").nilIfEmpty
    ?? step.signpost?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  let sign = [branch.nilIfEmpty, toward.map { "toward \($0)" }].compactMap { $0 }
    .joined(separator: " ")
  if !sign.isEmpty, !instruction.localizedCaseInsensitiveContains(toward ?? branch) {
    variants.insert("\(instruction.trimmingCharacters(in: CharacterSet(charactersIn: "."))) \(sign)", at: 0)
  }
  if let junction = step.junctionName?.trimmingCharacters(in: .whitespacesAndNewlines),
    !junction.isEmpty, !variants[0].localizedCaseInsensitiveContains(junction)
  {
    variants.insert("\(variants[0].trimmingCharacters(in: CharacterSet(charactersIn: "."))) at \(junction)", at: 0)
  }
  if !roadName.isEmpty, !variants.contains(roadName) {
    variants.append(roadName)
  }
  let exitNumber = step.exitNumber?.trimmingCharacters(in: .whitespacesAndNewlines)
  let leg = stepIndex > 0 ? trip.steps[stepIndex - 1] : step
  return NavOSSCarPlayManeuverInfo(
    stepIndex: stepIndex,
    kind: kind,
    instructionVariants: variants,
    roadName: roadName.isEmpty ? nil : roadName,
    // Valhalla's bearings at a ramp or fork barely differ (205° → 206° at Deerfoot exit 248), so a
    // measured angle that is near zero or points the other way would draw a straight arrow for a
    // right exit; the kind's own direction wins then.
    turnAngleDegrees: measuredAngle.map { angle in
      let nominal = kind.nominalAngleDegrees
      return nominal != 0 && (abs(angle) < 15 || angle.sign != nominal.sign) ? nominal : angle
    } ?? kind.nominalAngleDegrees,
    highwayExitLabel: exitNumber.flatMap { $0.isEmpty ? nil : "Exit \($0)" },
    lanes: navOSSCarPlayLaneSpecs(step.lanes),
    legDistanceMeters: stepIndex > 0 ? leg.distanceMeters : 0,
    legDurationSeconds: stepIndex > 0 ? leg.durationSeconds : 0
  )
}

/// Distance between two maneuvers under which the second is shown as "Then".
public let navOSSCarPlayThenManeuverMaximumGapMeters = 250.0

/// What the guidance card shows for the current guidance snapshot.
public struct NavOSSCarPlayGuidancePresentation: Equatable, Sendable {
  public let primary: NavOSSCarPlayManeuverInfo
  /// The following maneuver, only when it comes soon enough after `primary` to matter now.
  public let then: NavOSSCarPlayManeuverInfo?
  /// Road currently being driven, when the route names it.
  public let currentRoadName: String?
}

/// `guidance.stepIndex` is the step being driven; its maneuver has already happened. The next
/// maneuver begins step `stepIndex + 1`.
public func navOSSCarPlayGuidancePresentation(
  trip: NavOSSCarPlayTrip,
  guidance: NavOSSCarPlayGuidance
) -> NavOSSCarPlayGuidancePresentation? {
  guard guidance.phase == .navigating, trip.steps.indices.contains(guidance.stepIndex) else {
    return nil
  }
  let primaryIndex = min(guidance.stepIndex + 1, trip.steps.count - 1)
  guard let primary = navOSSCarPlayManeuverInfo(trip: trip, stepIndex: primaryIndex) else {
    return nil
  }
  let thenIndex = primaryIndex + 1
  let then: NavOSSCarPlayManeuverInfo? =
    primaryIndex > guidance.stepIndex && trip.steps.indices.contains(thenIndex)
      && trip.steps[primaryIndex].distanceMeters <= navOSSCarPlayThenManeuverMaximumGapMeters
    ? navOSSCarPlayManeuverInfo(trip: trip, stepIndex: thenIndex)
    : nil
  let drivenStep = trip.steps[guidance.stepIndex]
  let currentRoad = (drivenStep.currentRoadName ?? drivenStep.roadName)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return NavOSSCarPlayGuidancePresentation(
    primary: primary,
    then: then,
    currentRoadName: currentRoad.isEmpty ? nil : currentRoad
  )
}

/// The CarPlay maneuver state for a distance to the maneuver, with speed-aware thresholds so a
/// motorway exit is prepared earlier than a city turn.
public enum NavOSSCarPlayManeuverPhase: Equatable, Sendable {
  case continuing
  case initial
  case prepare
  case execute
}

public func navOSSCarPlayManeuverPhase(
  distanceToManeuverMeters: Double,
  speedMetersPerSecond: Double?
) -> NavOSSCarPlayManeuverPhase {
  let speed = max(0, speedMetersPerSecond ?? 0)
  let executeMeters = max(60, speed * 6)
  let prepareMeters = max(400, speed * 25)
  if distanceToManeuverMeters <= executeMeters { return .execute }
  if distanceToManeuverMeters <= prepareMeters { return .prepare }
  if distanceToManeuverMeters <= 2_000 { return .initial }
  return .continuing
}

/// The arrow drawn on the map at the next turn: a short run of road before the maneuver and the
/// first part of the road after it, so the driver sees which way the route bends. Empty when the
/// maneuver is the arrival or the geometry is too short to draw.
public func navOSSCarPlayManeuverArrow(
  trip: NavOSSCarPlayTrip,
  maneuverStepIndex: Int,
  approachMeters: Double = 30,
  exitMeters: Double = 22
) -> [NavOSSCarPlayCoordinate] {
  guard maneuverStepIndex > 0, trip.steps.indices.contains(maneuverStepIndex) else { return [] }
  let step = trip.steps[maneuverStepIndex]
  if navOSSCarPlayManeuverKind(
    type: step.maneuverType,
    modifier: step.maneuverModifier,
    instruction: step.instruction
  ).isArrival {
    return []
  }
  let approach = Array(
    navOSSCarPlayPrefix(trip.steps[maneuverStepIndex - 1].geometry.reversed(), meters: approachMeters)
      .reversed()
  )
  let isRoundabout: Bool
  switch navOSSCarPlayManeuverKind(
    type: step.maneuverType, modifier: step.maneuverModifier, instruction: step.instruction)
  {
  case .roundabout: isRoundabout = true
  default: isRoundabout = false
  }
  // A roundabout arrow follows the circulation to the exit, like the turn card does.
  let exitLength =
    isRoundabout
    ? max(exitMeters, step.geometry.indices.dropFirst().reduce(0) {
      $0 + navOSSCarPlayMetersBetween(step.geometry[$1 - 1], step.geometry[$1])
    } + exitMeters)
    : exitMeters
  var exitPath = navOSSCarPlayPrefix(step.geometry, meters: exitLength)
  if isRoundabout, maneuverStepIndex + 1 < trip.steps.count {
    exitPath += navOSSCarPlayPrefix(trip.steps[maneuverStepIndex + 1].geometry, meters: exitMeters)
      .dropFirst()
  }
  var arrow = approach
  for coordinate in exitPath where arrow.last != coordinate {
    arrow.append(coordinate)
  }
  guard arrow.count >= 2 else { return [] }
  return arrow
}

// MARK: - Congestion

/// The short traffic credit CarPlay shows for a route, or `nil` when the route has no live
/// traffic. Community traffic is credited only on a route it actually observed, with how fresh
/// it is ("as of" its oldest publication boundary) when the server said.
public func navOSSCarPlayTrafficAttribution(
  _ trip: NavOSSCarPlayTrip,
  locale: Locale = .current,
  timeZone: TimeZone = .current
) -> String? {
  if trip.source == "mapbox-traffic" { return "Traffic: Mapbox" }
  if trip.trafficSource == "navoss-community", trip.traffic != nil || trip.congestion != nil {
    guard let observedAt = trip.traffic?.oldestObservedAt else { return "Traffic: NavOSS drivers" }
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = timeZone
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    return "Traffic: NavOSS drivers · as of \(formatter.string(from: observedAt))"
  }
  return nil
}

/// A run of consecutive route segments that share a congestion level worth drawing.
public struct NavOSSCarPlayCongestionRun: Equatable, Sendable {
  public let level: NavOSSCarPlayCongestionLevel
  public let coordinates: [NavOSSCarPlayCoordinate]
}

/// Groups per-segment congestion into drawable runs. Unknown and free-flowing segments produce no
/// run, so the plain route line shows through; a level array that does not align with the geometry
/// produces nothing at all rather than colouring the wrong road. Road already travelled (before
/// `startingAtProgress`, a 0–1 fraction of route length) is dropped so it never recolours the
/// travelled line.
public func navOSSCarPlayCongestionRuns(
  geometry: [NavOSSCarPlayCoordinate],
  levels: [NavOSSCarPlayCongestionLevel]?,
  startingAtProgress progress: Double = 0
) -> [NavOSSCarPlayCongestionRun] {
  guard let levels, geometry.count >= 2, levels.count == geometry.count - 1 else { return [] }
  var cumulative = [0.0]
  cumulative.reserveCapacity(geometry.count)
  for index in 1..<geometry.count {
    cumulative.append(cumulative[index - 1] + navOSSCarPlayMetersBetween(geometry[index - 1], geometry[index]))
  }
  let clampedProgress = progress.isFinite ? min(1, max(0, progress)) : 0
  let travelled = clampedProgress * cumulative[cumulative.count - 1]
  var runs: [NavOSSCarPlayCongestionRun] = []
  var currentLevel: NavOSSCarPlayCongestionLevel?
  var currentCoordinates: [NavOSSCarPlayCoordinate] = []
  func flush() {
    if let currentLevel, currentCoordinates.count >= 2 {
      runs.append(NavOSSCarPlayCongestionRun(level: currentLevel, coordinates: currentCoordinates))
    }
    currentLevel = nil
    currentCoordinates = []
  }
  for (index, level) in levels.enumerated() {
    guard level != .unknown, level != .free, cumulative[index + 1] > travelled else {
      flush()
      continue
    }
    if level != currentLevel || currentCoordinates.isEmpty {
      flush()
      currentLevel = level
      let start = geometry[index]
      let end = geometry[index + 1]
      let length = cumulative[index + 1] - cumulative[index]
      if cumulative[index] < travelled, length > 0 {
        let fraction = (travelled - cumulative[index]) / length
        currentCoordinates = [
          NavOSSCarPlayCoordinate(
            latitude: start.latitude + (end.latitude - start.latitude) * fraction,
            longitude: start.longitude + (end.longitude - start.longitude) * fraction
          )
        ]
      } else {
        currentCoordinates = [start]
      }
    }
    currentCoordinates.append(geometry[index + 1])
  }
  flush()
  return runs
}

// MARK: - Map alerts (cameras and community reports)

extension Notification.Name {
  public static let navOSSCarPlayMapAlertsDidChange = Notification.Name(
    "org.navoss.mobile.carplay-map-alerts-did-change"
  )
}

/// A point drawn on the CarPlay map. Producers must only publish real, sourced data.
public struct NavOSSCarPlayMapAlert: Codable, Equatable, Sendable {
  public enum Kind: Codable, Equatable, Sendable {
    case redLightCamera
    case speedCamera
    case redLightAndSpeedCamera
    case report(NavOSSCarPlayReportType)
  }

  public let id: String
  public let kind: Kind
  public let coordinate: NavOSSCarPlayCoordinate

  public init(id: String, kind: Kind, coordinate: NavOSSCarPlayCoordinate) {
    self.id = id
    self.kind = kind
    self.coordinate = coordinate
  }

  public var isCamera: Bool {
    if case .report = kind { return false }
    return true
  }
}

/// Shared input for map alerts. Each source (the camera monitor, community reports) replaces
/// only its own alerts; the CarPlay map renders the union and draws nothing while it is empty.
public final class NavOSSCarPlayMapAlertStore: @unchecked Sendable {
  public enum Source: Sendable {
    case cameras
    case communityReports
  }

  public static let shared = NavOSSCarPlayMapAlertStore()

  private let lock = NSLock()
  private let notificationCenter: NotificationCenter
  private var alertsBySource: [Source: [NavOSSCarPlayMapAlert]] = [:]

  public init(notificationCenter: NotificationCenter = .default) {
    self.notificationCenter = notificationCenter
  }

  public func publish(_ alerts: [NavOSSCarPlayMapAlert], source: Source) {
    var seen = Set<String>()
    let valid = alerts.filter { $0.coordinate.isValid && seen.insert($0.id).inserted }
    lock.lock()
    let changed = valid != alertsBySource[source, default: []]
    alertsBySource[source] = valid
    lock.unlock()
    if changed {
      notificationCenter.post(name: .navOSSCarPlayMapAlertsDidChange, object: self)
    }
  }

  /// Cameras first, then reports; an id published by both appears once.
  public func snapshot() -> [NavOSSCarPlayMapAlert] {
    lock.lock()
    defer { lock.unlock() }
    var seen = Set<String>()
    return [Source.cameras, .communityReports].flatMap { alertsBySource[$0, default: []] }
      .filter { seen.insert($0.id).inserted }
  }
}

// MARK: - Camera

/// Where the follow camera should be for the current driving situation.
public struct NavOSSCarPlayCameraTarget: Equatable, Sendable {
  /// Ground distance across the view, in metres.
  public let viewingDistanceMeters: Double
  public let pitchDegrees: Double
  /// Fraction of `viewingDistanceMeters` the camera centre sits ahead of the vehicle, which puts
  /// the puck in the lower part of the view, above the current-road pill, with more road ahead.
  public let lookAheadFraction: Double
}

/// Speed sets the baseline zoom (more road ahead at motorway speed); an approaching maneuver pulls
/// the camera in so the junction is readable. Pitch flattens as the view widens so distant labels
/// stay legible.
public func navOSSCarPlayCameraTarget(
  speedMetersPerSecond: Double?,
  distanceToManeuverMeters: Double?
) -> NavOSSCarPlayCameraTarget {
  let speed = min(40, max(0, speedMetersPerSecond.flatMap { $0.isFinite ? $0 : nil } ?? 0))
  // 0 m/s → 550 m, 14 m/s (50 km/h) → ~830 m, 28 m/s (100 km/h) → ~1,110 m, capped at 1,350 m.
  var distance = min(1_350, 550 + speed * 20)
  if let distanceToManeuverMeters, distanceToManeuverMeters.isFinite {
    distance = min(distance, navOSSCarPlayViewingDistance(distanceToManeuverMeters) + speed * 6)
  }
  distance = max(420, distance)
  let pitch = 50 - (distance - 420) / (1_350 - 420) * 14
  return NavOSSCarPlayCameraTarget(
    viewingDistanceMeters: distance,
    pitchDegrees: min(50, max(36, pitch)),
    lookAheadFraction: 0.16
  )
}

/// Exponential smoothing toward `target` that behaves the same at any frame rate.
public func navOSSCarPlaySmoothed(
  _ current: Double,
  toward target: Double,
  elapsedSeconds: Double,
  timeConstantSeconds: Double
) -> Double {
  guard current.isFinite else { return target }
  guard elapsedSeconds > 0, timeConstantSeconds > 0 else { return elapsedSeconds > 0 ? target : current }
  let alpha = 1 - exp(-elapsedSeconds / timeConstantSeconds)
  return current + (target - current) * alpha
}

/// Like `navOSSCarPlaySmoothed` for compass bearings, taking the short way round.
public func navOSSCarPlaySmoothedBearing(
  _ current: Double,
  toward target: Double,
  elapsedSeconds: Double,
  timeConstantSeconds: Double
) -> Double {
  guard current.isFinite else { return target }
  let delta = (target - current + 540).truncatingRemainder(dividingBy: 360) - 180
  let next = navOSSCarPlaySmoothed(
    0, toward: delta, elapsedSeconds: elapsedSeconds, timeConstantSeconds: timeConstantSeconds)
  return (current + next + 360).truncatingRemainder(dividingBy: 360)
}

// MARK: - Live navigation state

/// What CarPlay needs from the navigation service beyond the trip store: the core's own road
/// context, speeding verdict, ask-first reroute proposal, and active safety-camera alert. The
/// service builds it (`NavOSSNavigationService.carPlayLiveGuidance()`); CarPlay never recomputes
/// any of it.
public struct NavOSSCarPlayLiveGuidance: Equatable, Sendable {
  public struct RerouteProposal: Equatable, Sendable {
    public let id: String
    /// Replacement minus the selected route's remaining duration. Positive is slower.
    public let durationDeltaSeconds: Double
    /// Replacement minus the selected route's remaining distance. Positive is longer.
    public let distanceDeltaMeters: Double

    public init(id: String, durationDeltaSeconds: Double, distanceDeltaMeters: Double) {
      self.id = id
      self.durationDeltaSeconds = durationDeltaSeconds
      self.distanceDeltaMeters = distanceDeltaMeters
    }
  }

  public struct SafetyCameraAlert: Equatable, Sendable {
    public let cameraId: String
    public let distanceAheadMeters: Double
    public let location: String
    /// Increases for every new alert, so a presenter can tell a new alert from an update.
    public let sequence: Int
    public let coordinate: NavOSSCarPlayCoordinate?

    public init(
      cameraId: String,
      distanceAheadMeters: Double,
      location: String,
      sequence: Int,
      coordinate: NavOSSCarPlayCoordinate?
    ) {
      self.cameraId = cameraId
      self.distanceAheadMeters = distanceAheadMeters
      self.location = location
      self.sequence = sequence
      self.coordinate = coordinate
    }
  }

  public let currentRoadName: String?
  public let speedLimitKph: Int?
  public let speedingState: NavOSSSpeedingState
  public let rerouteProposal: RerouteProposal?
  public let safetyCameraAlert: SafetyCameraAlert?

  public init(
    currentRoadName: String? = nil,
    speedLimitKph: Int? = nil,
    speedingState: NavOSSSpeedingState = .unknown,
    rerouteProposal: RerouteProposal? = nil,
    safetyCameraAlert: SafetyCameraAlert? = nil
  ) {
    self.currentRoadName = currentRoadName
    self.speedLimitKph = speedLimitKph
    self.speedingState = speedingState
    self.rerouteProposal = rerouteProposal
    self.safetyCameraAlert = safetyCameraAlert
  }
}

/// Banner text for an ask-first reroute proposal, stating the real time and distance change.
public func navOSSCarPlayRerouteProposalText(
  _ proposal: NavOSSCarPlayLiveGuidance.RerouteProposal
) -> (title: String, subtitle: String) {
  let minutes = Int((proposal.durationDeltaSeconds / 60).rounded())
  let time: String =
    minutes == 0
    ? "About the same time"
    : minutes > 0 ? "\(minutes) min slower" : "\(-minutes) min faster"
  let meters = proposal.distanceDeltaMeters
  let distance: String =
    abs(meters) < 50
    ? "similar distance"
    : "\(navOSSCarPlayDistanceLabel(abs(meters))) \(meters > 0 ? "longer" : "shorter")"
  return ("New route from here", "\(time), \(distance).")
}

// MARK: - Search results

/// Short distance label for a list row: "350 m", "1.2 km", "12 km".
public func navOSSCarPlayDistanceLabel(_ meters: Double) -> String {
  guard meters.isFinite, meters >= 0 else { return "" }
  if meters < 1_000 {
    return "\(max(10, Int((meters / 10).rounded()) * 10)) m"
  }
  if meters < 10_000 {
    return String(format: "%.1f km", meters / 1_000)
  }
  return "\(Int((meters / 1_000).rounded())) km"
}

/// Straight-line distance from `origin` to a destination, in metres.
public func navOSSCarPlayDistanceMeters(
  from origin: NavOSSCarPlayCoordinate,
  to destination: NavOSSCarPlayDestination
) -> Double {
  let latitudeDelta = (destination.latitude - origin.latitude) * .pi / 180
  let longitudeDelta = (destination.longitude - origin.longitude) * .pi / 180
  let haversine =
    sin(latitudeDelta / 2) * sin(latitudeDelta / 2)
    + cos(origin.latitude * .pi / 180) * cos(destination.latitude * .pi / 180)
    * sin(longitudeDelta / 2) * sin(longitudeDelta / 2)
  return 2 * 6_371_000 * asin(min(1, sqrt(haversine)))
}

/// Nearby-category results ordered nearest first, keeping the provider's order for ties so
/// relevance still breaks them. Without an origin the provider order is kept.
public func navOSSCarPlayDestinationsOrderedByDistance(
  _ destinations: [NavOSSCarPlayDestination],
  from origin: NavOSSCarPlayCoordinate?
) -> [NavOSSCarPlayDestination] {
  guard let origin, origin.isValid else { return destinations }
  let distances: [Double] = destinations.map { navOSSCarPlayDistanceMeters(from: origin, to: $0) }
  let order: [Int] = destinations.indices.sorted { left, right in
    if distances[left] != distances[right] { return distances[left] < distances[right] }
    return left < right
  }
  return order.map { destinations[$0] }
}

// MARK: - Stops

/// Removes the stop at `index` from the remaining waypoints. `nil` when the index is out of range.
public func navOSSCarPlayWaypoints(
  _ waypoints: [NavOSSCarPlayDestination],
  removingAt index: Int
) -> [NavOSSCarPlayDestination]? {
  guard waypoints.indices.contains(index) else { return nil }
  var updated = waypoints
  updated.remove(at: index)
  return updated
}

/// Moves the stop at `index` one place earlier. `nil` when it is already first or out of range.
public func navOSSCarPlayWaypoints(
  _ waypoints: [NavOSSCarPlayDestination],
  movingEarlierAt index: Int
) -> [NavOSSCarPlayDestination]? {
  guard index > 0, waypoints.indices.contains(index) else { return nil }
  var updated = waypoints
  updated.swapAt(index, index - 1)
  return updated
}

// MARK: - Voice input route

/// Ranks the audio inputs available for voice search, best first: the car's own microphone, then a
/// hands-free Bluetooth microphone, then a wired headset, then the iPhone. Port types are
/// `AVAudioSession.Port` raw values so the core does not import AVFoundation.
public func navOSSCarPlayPreferredVoiceInputPort(_ availablePortTypes: [String]) -> String? {
  let ranking = ["CarAudio", "BluetoothHFP", "HeadsetMicrophone", "MicrophoneWired", "MicrophoneBuiltIn"]
  return ranking.first { availablePortTypes.contains($0) }
}

// MARK: - Scene resume

/// What the main CarPlay scene should do with a route preview when it becomes active again.
public enum NavOSSCarPlayPreviewResumeAction: Equatable, Sendable {
  /// No preview was showing.
  case none
  /// The preview is still valid; keep it and its route choices.
  case keep
  /// A trip started elsewhere (typically on the phone) while away, so the preview is stale.
  case discard
}

public func navOSSCarPlayPreviewResumeAction(
  isPreviewing: Bool,
  previewReplacesActiveTrip: Bool,
  guidancePhase: NavOSSCarPlayGuidancePhase?
) -> NavOSSCarPlayPreviewResumeAction {
  guard isPreviewing else { return .none }
  if guidancePhase == .navigating, !previewReplacesActiveTrip { return .discard }
  if guidancePhase != .navigating, previewReplacesActiveTrip { return .discard }
  return .keep
}

extension String {
  fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
