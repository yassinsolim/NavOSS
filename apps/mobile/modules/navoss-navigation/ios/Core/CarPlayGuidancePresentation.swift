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
  /// What the guidance card, Dashboard, notification banner and lane guidance show, from most to
  /// least verbose: what to look for (the road or the sign), never the spoken sentence. Never
  /// empty. The spoken prompt and the phone's step list keep the provider's instruction.
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
  let variants = navOSSCarPlayCardInstructionVariants(trip: trip, stepIndex: stepIndex, kind: kind)
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

/// Draw maneuver symbols at the car's trait scale, not the backing screen's scale. CarPlay's
/// layout can move an oversized symbol above the distance, or hide the instruction entirely.
public func navOSSCarPlayManeuverDisplayScale(
  windowTraitScale: CGFloat?, controllerTraitScale: CGFloat?
) -> CGFloat {
  if let windowTraitScale, windowTraitScale.isFinite, windowTraitScale > 0 {
    return windowTraitScale
  }
  if let controllerTraitScale, controllerTraitScale.isFinite, controllerTraitScale > 0 {
    return controllerTraitScale
  }
  return 2
}

// MARK: - Card text
//
// The card answers "what do I look for": the road to turn onto, or the sign over the ramp. It is
// never the spoken sentence (that is what made the build 82 card a wall of text), and no variant
// repeats a name. CarPlay picks the longest variant that fits, so variants run from most to least
// verbose and every one of them is complete on its own.

/// English street types written as Canada Post abbreviates them. Trail, Way, Lane and Gate have
/// no shorter form drivers read reliably, so they stay whole.
private let navOSSCardStreetTypeAbbreviations: [String: String] = [
  "Avenue": "Ave", "Boulevard": "Blvd", "Circle": "Cir", "Court": "Crt", "Crescent": "Cres",
  "Drive": "Dr", "Expressway": "Expy", "Heights": "Hts", "Highway": "Hwy", "Parkway": "Pky",
  "Place": "Pl", "Road": "Rd", "Square": "Sq", "Street": "St", "Terrace": "Terr",
]

/// Street types that keep their full name but still end a street name, so a direction after them
/// ("Deerfoot Trail South") is a quadrant that can be abbreviated.
private let navOSSCardStreetTypes: Set<String> =
  Set(navOSSCardStreetTypeAbbreviations.keys)
  .union(navOSSCardStreetTypeAbbreviations.values)
  .union([
    "Trail", "Way", "Lane", "Gate", "Link", "Close", "Common", "Green", "Bay", "Manor", "Mews",
    "Path", "Walk", "View", "Row", "Rise", "Grove", "Landing", "Point", "Hill", "Freeway",
    "Connector",
  ])

private let navOSSCardDirectionAbbreviations: [String: String] = [
  "Northwest": "NW", "Northeast": "NE", "Southwest": "SW", "Southeast": "SE",
  "North": "N", "South": "S", "East": "E", "West": "W",
]

private let navOSSCardDirections: Set<String> =
  Set(navOSSCardDirectionAbbreviations.keys).union(navOSSCardDirectionAbbreviations.values)

/// The abbreviated form of a road or sign name: an English street type is shortened only where it
/// ends the name (alone or before a quadrant), and a quadrant only right after a street type, so
/// "Avenue Road", "Boulevard René-Lévesque Est" and the route direction in "1A East" are untouched.
func navOSSCarPlayCardAbbreviated(_ name: String) -> String {
  name.components(separatedBy: " / ").map { part in
    var words = part.split(separator: " ").map(String.init)
    for index in words.indices {
      let rest = words[(index + 1)...]
      if index > 0, let short = navOSSCardStreetTypeAbbreviations[words[index]],
        rest.allSatisfy({ navOSSCardDirections.contains($0) })
      {
        words[index] = short
      } else if index > 0, index == words.count - 1,
        let short = navOSSCardDirectionAbbreviations[words[index]],
        navOSSCardStreetTypes.contains(words[index - 1])
      {
        words[index] = short
      }
    }
    return words.joined(separator: " ")
  }.joined(separator: " / ")
}

/// The longest card variant that stays on two lines of the guidance card. On the owner's Toyota
/// head unit (build 82 photo, bar shown) a card line held 18–22 characters ("Take the 1A East /",
/// "Crowchild Trail", "ramp on the left."), so anything past about 40 characters becomes a third
/// line; with the bar hidden CarPlay lets the card grow to fit it (the second build 82 photo).
let navOSSCarPlayCardMaximumCharacters = 40

private let navOSSCardKeyLocale = Locale(identifier: "en_CA")
private let navOSSCardKeyIgnoredWords: Set<String> = ["highway", "hwy", "route"]

private let navOSSCardTravelDirections: Set<String> = [
  "north", "south", "east", "west", "n", "s", "e", "w", "nord", "sud", "est", "ouest",
]
private let navOSSCardQuadrants: Set<String> = ["ne", "nw", "se", "sw"]

/// A name's words, case and accents folded and punctuation dropped, split into the name itself and
/// its trailing direction or quadrant suffix ("Crowchild Trail SW" → "crowchild trail" + "sw").
/// Only trailing tokens are a suffix: in "North Shore Road" the direction is part of the name.
private func navOSSCardNameParts(_ name: String) -> (core: [String], suffix: [String]) {
  var words = name.folding(
    options: [.caseInsensitive, .diacriticInsensitive], locale: navOSSCardKeyLocale
  )
  .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
  .map(String.init)
  var suffix: [String] = []
  while words.count > 1, let last = words.last,
    navOSSCardTravelDirections.contains(last) || navOSSCardQuadrants.contains(last)
  {
    suffix.insert(words.removeLast(), at: 0)
  }
  return (words, suffix)
}

/// What identifies the road: the name without its trailing direction or quadrant and without the
/// word "Highway", so "Glenmore Trail West" matches "Glenmore Trail SE" and "Highway 403" matches
/// "403 East", but "North Shore Road" does not match "South Shore Road East".
private func navOSSCardCoreKey(_ name: String) -> String {
  navOSSCardNameParts(name).core.filter { !navOSSCardKeyIgnoredWords.contains($0) }
    .joined(separator: " ")
}

/// A road name as the card writes it: the first of a legacy ";"-joined list, a bare route number
/// as "Highway 17", and Valhalla's "2/Deerfoot Trail SE" spaced as "Highway 2 / Deerfoot Trail SE".
private func navOSSCardRoadName(_ raw: String) -> String {
  let first = raw.split(separator: ";").first.map(String.init) ?? ""
  return navOSSReadableRoadName(navOSSReadableRoadNames(first))
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 2 when a name ends in a direction of travel ("North", "W"), 1 in an address quadrant only
/// ("SW"), 0 for neither. A sign's direction of travel is what the driver chooses between.
private func navOSSCardTravelDirectionRank(_ name: String) -> Int {
  let suffix = navOSSCardNameParts(name).suffix
  if suffix.contains(where: navOSSCardTravelDirections.contains) { return 2 }
  return suffix.isEmpty ? 0 : 1
}

/// `name`, or a sign naming the same road with a direction of travel when `name` has none
/// ("Crowchild Trail North" for "Crowchild Trail SW"): the direction is the driver's decision, the
/// address quadrant is not.
private func navOSSCardSignedName(_ name: String, signs: [String]) -> String {
  guard !name.isEmpty, navOSSCardTravelDirectionRank(name) < 2 else { return name }
  let key = navOSSCardCoreKey(name)
  return signs.first { navOSSCardCoreKey($0) == key && navOSSCardTravelDirectionRank($0) == 2 }
    ?? name
}

/// Sign or road names with blanks and repeats (by core key) removed. Of two names for one road the
/// one that carries a direction wins ("403 East" over "Highway 403"): it is what the sign adds.
private func navOSSCardDistinctNames(_ names: [String], roadName: String = "") -> [String] {
  var result: [String] = []
  for raw in names {
    let name = navOSSReadableRoadName(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    let key = navOSSCardCoreKey(name)
    guard !name.isEmpty, !key.isEmpty else { continue }
    if let existing = result.firstIndex(where: { navOSSCardCoreKey($0) == key }) {
      if navOSSCardTravelDirectionRank(name) > navOSSCardTravelDirectionRank(result[existing]) {
        result[existing] = name
      }
    } else {
      result.append(name)
    }
  }
  // Only remove an exact uppercase initialism when this same step supplies the full mapped
  // road name alongside it on the sign ("Queen Elizabeth Way", "QEW"). A lone ref, a partial
  // match or a numeric route designation says something different and stays.
  if result.count > 1 {
    let words = navOSSCardNameParts(roadName).core
    if words.count >= 3, result.contains(where: { navOSSCardCoreKey($0) == navOSSCardCoreKey(roadName) }) {
      let initials = words.reduce(into: "") { text, word in
        if let first = word.first { text.append(contentsOf: String(first).uppercased()) }
      }
      result.removeAll { $0 == initials }
    }
  }
  return result
}

/// Two or three words for a maneuver with nothing to name.
private func navOSSCarPlayCardAction(_ kind: NavOSSCarPlayManeuverKind) -> String {
  switch kind {
  case .depart: "Start"
  case .straight, .followRoad: "Continue"
  case .slightLeft: "Bear left"
  case .left, .leftAtEnd: "Turn left"
  case .sharpLeft: "Sharp left"
  case .slightRight: "Bear right"
  case .right, .rightAtEnd: "Turn right"
  case .sharpRight: "Sharp right"
  case .uTurn: "Make a U-turn"
  case .keepLeft: "Keep left"
  case .keepRight: "Keep right"
  case .mergeLeft: "Merge left"
  case .mergeRight: "Merge right"
  case .onRamp: "Take the ramp"
  case .offRampLeft: "Exit left"
  case .offRampRight: "Exit right"
  case let .roundabout(exit): exit.map { "Exit \($0)" } ?? "Enter the roundabout"
  case .exitRoundabout: "Exit the roundabout"
  case .ferry: "Take the ferry"
  case .arrive, .arriveLeft, .arriveRight: "Destination"
  }
}

/// The names joined as the sign shows them, then progressively fewer of them, each followed by its
/// abbreviated form when that is shorter.
private func navOSSCardNameVariants(_ names: [String], prefix: String) -> [String] {
  guard !names.isEmpty else { return [] }
  var groups = [names]
  if names.count > 2 { groups.append(Array(names.prefix(2))) }
  if names.count > 1 { groups.append([names[0]]) }
  return groups.flatMap { group -> [String] in
    let text = group.joined(separator: " / ")
    return [prefix + text, prefix + navOSSCarPlayCardAbbreviated(text)]
  }
}

/// Sign-led variants: `Exit N · names toward places`, then fewer names, then the exit alone.
/// "toward" appears only in the longest variant and only for places the names do not already say.
private func navOSSCardSignVariants(
  exitNumber: String?,
  targets: [String],
  toward: [String],
  towardIsTheSign: Bool
) -> [String] {
  let targetKeys = targets.map(navOSSCardCoreKey)
  let joinedKey = targetKeys.joined(separator: " ")
  let newToward =
    towardIsTheSign
    ? []
    : toward.filter {
      let key = navOSSCardCoreKey($0)
      return !targetKeys.contains(key) && !joinedKey.contains(key)
    }
  let prefix = exitNumber.map { "Exit \($0) · " } ?? ""
  var variants: [String] = []
  if !newToward.isEmpty, !targets.isEmpty {
    variants.append(
      prefix + targets.joined(separator: " / ") + " toward "
        + newToward.prefix(2).joined(separator: " / "))
  }
  variants += navOSSCardNameVariants(targets, prefix: prefix)
  if let exitNumber { variants.append("Exit \(exitNumber)") }
  return variants
}

private let navOSSCardInstructionExit = try! NSRegularExpression(
  pattern: #"\bexit ([0-9]{1,4}[A-Za-z]?)\b"#, options: .caseInsensitive)
private let navOSSCardInstructionToward = try! NSRegularExpression(
  pattern: #"^(.*?) toward (.+)$"#, options: .caseInsensitive)
private let navOSSCardInstructionTargets = [
  #"\bonto (.+)$"#,
  #"\bto (?:take|stay on) (.+)$"#,
  #"^take the (.+) (?:exit|ramp)(?: on the (?:left|right))?$"#,
].map { try! NSRegularExpression(pattern: $0, options: .caseInsensitive) }

/// Words that end in a period inside a name ("No. 3 Rd", "St. Albert"), so the period is not the
/// end of a sentence. Single letters (initials) count too.
private let navOSSCardAbbreviationWords: Set<String> = [
  "no", "st", "ste", "dr", "mt", "ft", "rd", "ave", "blvd", "hwy",
]
/// Words that open a provider cue ("…Main Rd. Then turn left…"), so the period before them ends
/// a sentence even after an abbreviation.
private let navOSSCardClauseStarters: Set<String> = [
  "Then", "Turn", "Keep", "Take", "Continue", "Bear", "Merge", "Make", "Enter", "Exit", "Stay",
  "Drive", "Head", "Your", "You",
]
private let navOSSCardSentenceBoundary = try! NSRegularExpression(
  pattern: #"(\S+)\. +(\p{Lu}\p{L}*)"#)

/// Whether `text` holds more than one sentence: a period, a space and a capitalised word, where
/// the word before the period is not an abbreviation or the word after it opens a cue.
private func navOSSCardHasSentenceBoundary(_ text: String) -> Bool {
  navOSSCardSentenceBoundary.matches(
    in: text, range: NSRange(text.startIndex..<text.endIndex, in: text)
  ).contains { match in
    guard let range = Range(match.range(at: 1), in: text),
      let nextRange = Range(match.range(at: 2), in: text)
    else { return true }
    if navOSSCardClauseStarters.contains(String(text[nextRange])) { return true }
    let word = text[range].lowercased()
    let isInitial = word.count == 1 && word.first?.isLetter == true
    return !isInitial && !navOSSCardAbbreviationWords.contains(word)
  }
}

/// What a provider sentence without structured sign fields states: an exit number ("exit 248B"),
/// the road or sign after "onto", "to take" or "take the … exit", and the place after "toward".
/// `nil` when the sentence states none of them, or is more than one sentence, so nothing is
/// guessed.
private func navOSSCardInstructionParts(
  _ instruction: String
) -> (exit: String?, target: String?, toward: String?)? {
  var text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
  while text.hasSuffix(".") { text.removeLast() }
  guard !text.isEmpty, !navOSSCardHasSentenceBoundary(text) else { return nil }
  func group(_ expression: NSRegularExpression, in value: String, _ index: Int) -> String? {
    guard
      let match = expression.firstMatch(
        in: value, range: NSRange(value.startIndex..<value.endIndex, in: value)),
      let range = Range(match.range(at: index), in: value)
    else { return nil }
    return String(value[range]).trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  }
  let exit = group(navOSSCardInstructionExit, in: text, 1)
  let head = group(navOSSCardInstructionToward, in: text, 1) ?? text
  let toward = group(navOSSCardInstructionToward, in: text, 2)
  let target = navOSSCardInstructionTargets.lazy.compactMap { group($0, in: head, 1) }.first
    .flatMap { candidate -> String? in
      // "to take exit 248B" names the exit, not a road.
      candidate.range(of: #"^exit \S+$"#, options: [.regularExpression, .caseInsensitive]) == nil
        ? candidate : nil
    }
  guard exit != nil || target != nil || toward != nil else { return nil }
  return (exit, target, toward)
}

private let navOSSCardCarriagewayWords: Set<String> = ["express", "collector", "collectors", "local"]

/// A trailing carriageway qualifier, not "Expressway" or "Local Road". These are the words
/// present in the recorded Ontario steps; no road aliases or inferred carriageways are added.
private func navOSSCardHasCarriageway(_ name: String) -> Bool {
  guard let space = name.lastIndex(of: " ") else { return false }
  return navOSSCardCarriagewayWords.contains(name[name.index(after: space)...].lowercased())
}

/// Only the provider's own maneuver target identifies which carriageway to take. `roadName`
/// can be the highway being left, and a branch sign can list both Express and Collector.
private func navOSSCardCarriagewayName(_ instructionTarget: String?) -> String? {
  instructionTarget?.components(separatedBy: " / ").first(where: navOSSCardHasCarriageway)
}

/// Card variants for the maneuver that begins `steps[stepIndex]`, most to least verbose, with no
/// trailing period and no name said twice:
/// - variants longer than `navOSSCarPlayCardMaximumCharacters` (a third card line) are dropped
///   whenever a shorter one exists;
/// - a ramp, exit or fork with a sign shows the sign ("1A East / Crowchild Trail", then "1A East"),
///   led by the exit number when the provider gave one ("Exit 248 · Glenmore Trail"), with
///   "toward" only in the longest variant and only for places the sign's names do not already say;
/// - a turn onto a named road shows the road, then its abbreviated form;
/// - a roundabout shows "Exit 2 · Main Street"; arrival shows the destination name;
/// - anything else is a two- or three-word action ("Turn right", "Keep left").
public func navOSSCarPlayCardInstructionVariants(
  trip: NavOSSCarPlayTrip,
  stepIndex: Int,
  kind: NavOSSCarPlayManeuverKind
) -> [String] {
  guard trip.steps.indices.contains(stepIndex) else { return [navOSSCarPlayCardAction(kind)] }
  let step = trip.steps[stepIndex]
  let mappedRoad = navOSSCardRoadName(step.roadName)
  let exitNumber = step.exitNumber?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  let branch = navOSSCardDistinctNames(step.signpostBranch ?? [], roadName: mappedRoad)
  var toward = navOSSCardDistinctNames(step.signpostToward ?? [], roadName: mappedRoad)
  if toward.isEmpty, branch.isEmpty, let signpost = step.signpost {
    // An older server sends only the joined signpost text, "branch: toward".
    toward = navOSSCardDistinctNames(signpost.components(separatedBy: CharacterSet(charactersIn: ":,")))
  }
  let road = navOSSCardSignedName(mappedRoad, signs: branch + toward)
  let action = navOSSCarPlayCardAction(kind)

  var variants: [String]
  switch kind {
  case .arrive, .arriveLeft, .arriveRight:
    let isArrival = { (step: NavOSSCarPlayRouteStep) in step.maneuverType.lowercased() == "arrive" }
    let laterArrival = trip.steps[(stepIndex + 1)...].contains(where: isArrival)
    let name: String
    if laterArrival {
      // A stop on the way: its own name, or "Stop" ("Stop 2" among several). Never the final
      // destination's name, which is still ahead.
      let ordinal = trip.steps[..<stepIndex].filter(isArrival).count
      let stops = trip.waypoints ?? []
      let stopCount = max(stops.count, trip.steps.dropLast().filter(isArrival).count)
      let stop = stops.indices.contains(ordinal) ? stops[ordinal] : nil
      name =
        [stop?.name, stop?.label].compactMap {
          $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }.first ?? (stopCount > 1 ? "Stop \(ordinal + 1)" : "Stop")
    } else {
      name = trip.destination.name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    variants = name.isEmpty ? [action] : [name, navOSSCarPlayCardAbbreviated(name)]
  case let .roundabout(exit):
    // The roundabout step names the ring ("Rond-point Dorval"); the road taken out of it is the
    // following exit step's.
    let next = trip.steps.indices.contains(stepIndex + 1) ? trip.steps[stepIndex + 1] : nil
    let exitRoad =
      next.flatMap {
        $0.maneuverType.lowercased().hasPrefix("exit") ? navOSSCardRoadName($0.roadName).nilIfEmpty : nil
      } ?? road.nilIfEmpty
    let label = exit.map { "Exit \($0)" }
    if let exitRoad {
      variants = navOSSCardNameVariants(
        exitRoad.components(separatedBy: " / "), prefix: label.map { "\($0) · " } ?? "")
      if let label { variants.append(label) }
    } else {
      variants = [action]
    }
  default:
    let type = step.maneuverType.lowercased()
    let isRamp =
      ["fork", "merge", "on ramp", "off ramp"].contains(type)
      || [.keepLeft, .keepRight, .mergeLeft, .mergeRight, .onRamp, .offRampLeft, .offRampRight]
        .contains(kind)
    let hasSignFields = exitNumber != nil || !branch.isEmpty || !toward.isEmpty
    let parts =
      isRamp || (!hasSignFields && road.isEmpty)
      ? navOSSCardInstructionParts(step.instruction) : nil
    if isRamp,
      let carriageway = navOSSCardCarriagewayName(parts?.target)
    {
      // The carriageway is the decision at this fork. Destinations or an unqualified route
      // number must not displace it, even in the shortest variant.
      let exit = hasSignFields ? exitNumber : parts?.exit
      let places = hasSignFields ? toward : navOSSCardDistinctNames(
        parts?.toward?.components(separatedBy: " / ") ?? [])
      variants = navOSSCardSignVariants(
        exitNumber: exit, targets: [carriageway], toward: places, towardIsTheSign: false)
      if let exit { variants.removeAll { $0 == "Exit \(exit)" } }
      // If the exit prefix makes every qualified name too long, keep the road rather than
      // losing the carriageway to an exit-number-only fallback.
      if !variants.contains(where: { $0.count <= navOSSCarPlayCardMaximumCharacters }) {
        variants += navOSSCardNameVariants([carriageway], prefix: "")
      }
    } else if isRamp || exitNumber != nil, hasSignFields {
      // At a numbered highway exit, a supplied destination sign is what the driver looks for,
      // not an unrelated street reached afterward. Keep today's road/direction choice when
      // the sign names that same road, or no destination sign was supplied.
      let destinationIsTheSign =
        type == "off ramp" && exitNumber != nil && branch.isEmpty && !toward.isEmpty
        && !toward.contains { navOSSCardCoreKey($0) == navOSSCardCoreKey(road) }
      let targets =
        !branch.isEmpty ? branch
        : destinationIsTheSign ? toward
        : !road.isEmpty ? road.components(separatedBy: " / ") : toward
      variants = navOSSCardSignVariants(
        exitNumber: exitNumber, targets: targets, toward: toward,
        towardIsTheSign: destinationIsTheSign || (branch.isEmpty && road.isEmpty))
      if destinationIsTheSign,
        !variants.contains(where: { $0.count <= navOSSCarPlayCardMaximumCharacters && $0 != "Exit \(exitNumber!)" })
      {
        // The sign plus "Exit N" can exceed two lines. Use the supplied sign alone ahead of
        // the exit-only variant; never abbreviate an airport/place name by guessing.
        variants = navOSSCardNameVariants(targets, prefix: "") + variants
      }
    } else if !hasSignFields, isRamp || road.isEmpty,
      let parts
    {
      // No structured sign fields (the `/v1/routes` fallback, some on-device steps): the exit
      // number and names the provider's own sentence states. The step's road name, when it has
      // one, stays the name; the sentence's "toward" can only add its direction of travel.
      let towardNames = navOSSCardDistinctNames(parts.toward?.components(separatedBy: " / ") ?? [])
      let named = road.isEmpty ? parts.target ?? "" : road
      let targets = navOSSCardDistinctNames(named.components(separatedBy: " / "))
        .map { navOSSCardSignedName($0, signs: towardNames) }
      variants = navOSSCardSignVariants(
        exitNumber: parts.exit, targets: targets.isEmpty ? towardNames : targets,
        toward: towardNames, towardIsTheSign: targets.isEmpty)
    } else if !road.isEmpty {
      variants = navOSSCardNameVariants(road.components(separatedBy: " / "), prefix: "")
    } else if !toward.isEmpty {
      variants = ["\(action) toward \(toward.prefix(2).joined(separator: " / "))", action]
    } else {
      // Nothing that parses cleanly: the sentence itself when it says more than the action.
      variants = [step.instruction, action]
    }
  }
  var seen = Set<String>()
  let cleaned = variants.compactMap { variant -> String? in
    var text = variant.trimmingCharacters(in: .whitespacesAndNewlines)
    while text.hasSuffix(".") { text.removeLast() }
    guard !text.isEmpty, seen.insert(text).inserted else { return nil }
    return text
  }
  guard !cleaned.isEmpty else { return [action] }
  // Two card lines at most: longer variants go whenever a shorter one exists; if none does, the
  // shortest is kept alone.
  let fitting = cleaned.filter { $0.count <= navOSSCarPlayCardMaximumCharacters }
  return fitting.isEmpty ? [cleaned.min { $0.count < $1.count }!] : fitting
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
/// when it was updated (its oldest publication boundary, not a driving time) when the server said.
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
    return "Traffic: NavOSS drivers · updated \(formatter.string(from: observedAt))"
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

/// Where the follow camera should be for the current driving situation. The vehicle's place on
/// screen is fixed by the map (lower third of the visible map), so this is only how much ground the
/// view spans and how far it tilts.
public struct NavOSSCarPlayCameraTarget: Equatable, Sendable {
  /// Ground distance across the view, in metres.
  public let viewingDistanceMeters: Double
  public let pitchDegrees: Double
}

/// Closest and widest guidance views, in metres across.
public let navOSSCarPlayCameraClosestMeters = 240.0
public let navOSSCarPlayCameraWidestMeters = 800.0

/// Guidance stays close and tilted. Speed widens the view modestly and quadratically, so city
/// driving stays near street level while a motorway shows more road ahead; an approaching maneuver
/// pulls in so the junction is readable; a maneuver kilometres away never widens it.
public func navOSSCarPlayCameraTarget(
  speedMetersPerSecond: Double?,
  distanceToManeuverMeters: Double?
) -> NavOSSCarPlayCameraTarget {
  let speed = min(40, max(0, speedMetersPerSecond.flatMap { $0.isFinite ? $0 : nil } ?? 0))
  // 0 → 280 m, 50 km/h → 390 m, 60 km/h → 430 m, 100 km/h → 710 m, then capped at 800 m.
  var distance = min(navOSSCarPlayCameraWidestMeters, 280 + 0.55 * speed * speed)
  if let distanceToManeuverMeters, distanceToManeuverMeters.isFinite,
    distanceToManeuverMeters >= 0
  {
    // 100 m out → 260 m across, 300 m → 380 m; beyond about 1 km this no longer binds.
    distance = min(distance, 200 + distanceToManeuverMeters * 0.6)
  }
  distance = max(navOSSCarPlayCameraClosestMeters, distance)
  // 55° when close, easing to 50° at the widest view so distant labels stay legible. Steeper
  // pitches put most of a small car display into the distance, where labels are unreadable.
  let spread = navOSSCarPlayCameraWidestMeters - navOSSCarPlayCameraClosestMeters
  let pitch = 55 - (distance - navOSSCarPlayCameraClosestMeters) / spread * 5
  return NavOSSCarPlayCameraTarget(viewingDistanceMeters: distance, pitchDegrees: pitch)
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

private let navOSSWholeKilometres: NumberFormatter = {
  let formatter = NumberFormatter()
  formatter.locale = Locale(identifier: "en_CA")
  formatter.numberStyle = .decimal
  formatter.maximumFractionDigits = 0
  return formatter
}()

/// Short distance label: "350 m", "1.2 km", then whole kilometres from 10 km: "12 km",
/// "4,392 km". Canadian English like the rest of the copy, whatever the device locale.
public func navOSSCarPlayDistanceLabel(_ meters: Double) -> String {
  guard meters.isFinite, meters >= 0 else { return "" }
  if meters < 1_000 {
    return "\(max(10, Int((meters / 10).rounded()) * 10)) m"
  }
  let tenths = (meters / 100).rounded() / 10
  if tenths < 10 {
    return String(format: "%.1f km", tenths)
  }
  let kilometres = Int((meters / 1_000).rounded())
  let grouped = navOSSWholeKilometres.string(from: NSNumber(value: kilometres))
  return "\(grouped ?? String(kilometres)) km"
}

/// Trip duration: "20 min", "2 hr 5 min", then whole days and hours beyond a day: "1 day 22 hr".
public func navOSSCarPlayDurationLabel(_ seconds: Double) -> String {
  let minutes = max(1, Int((max(0, seconds.isFinite ? seconds : 0) / 60).rounded()))
  if minutes < 60 { return "\(minutes) min" }
  let hours = minutes / 60
  if hours >= 24 {
    let totalHours = Int((Double(minutes) / 60).rounded())
    let days = totalHours / 24
    let remainingHours = totalHours % 24
    let dayText = "\(days) \(days == 1 ? "day" : "days")"
    return remainingHours == 0 ? dayText : "\(dayText) \(remainingHours) hr"
  }
  let remainingMinutes = minutes % 60
  return remainingMinutes == 0 ? "\(hours) hr" : "\(hours) hr \(remainingMinutes) min"
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

// MARK: - Route fit

/// The flat camera that shows every coordinate inside a padded part of the map view.
public struct NavOSSCarPlayFitCamera: Equatable, Sendable {
  public let center: NavOSSCarPlayCoordinate
  public let zoomLevel: Double
}

/// Fits `coordinates` into the view minus its padding, with the map rotated to `headingDegrees`,
/// using Web Mercator at MapLibre's 512-point world size. Computed here rather than with MapLibre's
/// `setVisibleCoordinates`, which on CarPlay-sized views with a large side padding zoomed in by
/// several levels and left the route and the vehicle off screen.
public func navOSSCarPlayFitCamera(
  coordinates: [NavOSSCarPlayCoordinate],
  viewWidth: Double,
  viewHeight: Double,
  padding: (top: Double, left: Double, bottom: Double, right: Double),
  headingDegrees: Double,
  maximumZoomLevel: Double = 20
) -> NavOSSCarPlayFitCamera? {
  let points = coordinates.filter(\.isValid)
  let width = viewWidth - padding.left - padding.right
  let height = viewHeight - padding.top - padding.bottom
  guard let first = points.first, width > 0, height > 0 else { return nil }
  func project(_ coordinate: NavOSSCarPlayCoordinate) -> (x: Double, y: Double) {
    let latitude = min(85, max(-85, coordinate.latitude)) * .pi / 180
    return (
      (coordinate.longitude + 180) / 360,
      (1 - log(tan(latitude) + 1 / cos(latitude)) / .pi) / 2
    )
  }
  let heading = (headingDegrees.isFinite ? headingDegrees : 0) * .pi / 180
  let origin = project(first)
  // World offsets (x east, y south) rotated into screen axes for a map turned to `heading`.
  func rotate(_ x: Double, _ y: Double) -> (x: Double, y: Double) {
    (x * cos(heading) + y * sin(heading), -x * sin(heading) + y * cos(heading))
  }
  let rotated = points.map { point -> (x: Double, y: Double) in
    let world = project(point)
    return rotate(world.x - origin.x, world.y - origin.y)
  }
  let minX = rotated.map(\.x).min()!, maxX = rotated.map(\.x).max()!
  let minY = rotated.map(\.y).min()!, maxY = rotated.map(\.y).max()!
  let spanX = max(maxX - minX, 1e-12)
  let spanY = max(maxY - minY, 1e-12)
  let zoom = min(maximumZoomLevel, max(0, log2(min(width / spanX, height / spanY) / 512)))
  let scale = 512 * pow(2, zoom)
  // The padded area's centre sits this far from the view's centre, in screen points.
  let offsetX = (padding.left - padding.right) / 2
  let offsetY = (padding.top - padding.bottom) / 2
  let centerX = (minX + maxX) / 2 - offsetX / scale
  let centerY = (minY + maxY) / 2 - offsetY / scale
  // Back to world axes, then to latitude and longitude.
  let worldX = origin.x + centerX * cos(heading) - centerY * sin(heading)
  let worldY = origin.y + centerX * sin(heading) + centerY * cos(heading)
  let longitude = worldX * 360 - 180
  let latitude = atan(sinh(.pi * (1 - 2 * worldY))) * 180 / .pi
  return NavOSSCarPlayFitCamera(
    center: NavOSSCarPlayCoordinate(latitude: latitude, longitude: longitude), zoomLevel: zoom)
}
