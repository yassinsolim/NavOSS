import Foundation

struct NavigationSpeechPrompt: Equatable, Sendable {
  let key: String
  let text: String
}

/// Decides which maneuver prompt, if any, to speak for a guidance update.
///
/// Each maneuver gets at most one prompt per level, in increasing urgency: an early heads-up on
/// highways, a prepare prompt, and the execute prompt at the turn. Reaching a level consumes
/// the levels before it, so a driver who first hears about a turn already at the turn hears only
/// "Turn right", never a stale "In 400 metres" afterwards. That is also what keeps a fresh route
/// after a reroute from replaying a burst of prompts.
final class NavigationSpeechPlanner {
  enum Level: Int, Comparable, Sendable {
    case early = 0
    case prepare = 1
    case execute = 2

    static func < (left: Level, right: Level) -> Bool {
      left.rawValue < right.rawValue
    }

    var keySuffix: String {
      switch self {
      case .early: "early"
      case .prepare: "prepare"
      case .execute: "execute"
      }
    }
  }

  /// Ground speed (≈70 km/h) from which highway timing applies.
  static let highwaySpeedMetersPerSecond = 19.5
  /// A physical maneuver announced at some urgency is not announced again at that urgency
  /// within this window, whichever route produced it. A reroute that keeps the turn the driver
  /// was just told about stays quiet.
  static let repeatSuppressionSeconds = 30.0
  /// Lower-urgency prompts wait this long after any prompt so two never run back to back.
  static let minimumGapSeconds = 3.0

  private var announcedLevels: [String: Level] = [:]
  private var arrivedTripIds: Set<String> = []
  private var lastPromptTime: TimeInterval?
  /// Maneuvers announced recently, by place and wording, so the same physical turn on a
  /// replacement route is not announced again.
  private var recentManeuvers: [RecentManeuver] = []

  private struct RecentManeuver {
    let instruction: String
    let level: Level
    let point: NavigationCoordinate
    let time: TimeInterval
  }

  /// Two announcements describe the same physical maneuver when they are this close and use the
  /// same words. Place alone is not enough (a test route may stack maneuvers), and words alone
  /// are not either (two different right turns can read identically).
  static let sameManeuverRadiusMeters = 30.0

  /// Forgets everything; for a new trip.
  func reset() {
    announcedLevels.removeAll()
    arrivedTripIds.removeAll()
    lastPromptTime = nil
    recentManeuvers.removeAll()
  }

  /// For a replacement route on the same trip: maneuver bookkeeping restarts with the new
  /// route, but what was just said is remembered so it is not repeated.
  func resetForReroute() {
    announcedLevels.removeAll()
  }

  func prompt(
    trip: NavOSSCarPlayTrip,
    guidance: NavOSSCarPlayGuidance,
    hasCurrentLocation: Bool,
    speedMetersPerSecond: Double? = nil,
    isOffRoute: Bool = false,
    now: TimeInterval = Date().timeIntervalSinceReferenceDate
  ) -> NavigationSpeechPrompt? {
    guard hasCurrentLocation, !trip.steps.isEmpty else {
      return nil
    }
    recentManeuvers.removeAll { now - $0.time > Self.repeatSuppressionSeconds }

    if guidance.phase == .arrived {
      guard arrivedTripIds.insert(trip.id).inserted else {
        return nil
      }
      return emit(
        NavigationSpeechPrompt(
          key: "\(trip.id):arrived",
          text: "You've arrived at \(trip.destination.name)."
        ),
        now: now
      )
    }
    // Off route, the selected route's next maneuver is no longer where the driver is heading.
    guard !isOffRoute else {
      return nil
    }

    let currentStepIndex = min(guidance.stepIndex, trip.steps.count - 1)
    let maneuverIndex = min(guidance.stepIndex + 1, trip.steps.count - 1)
    let speed = Self.effectiveSpeed(speedMetersPerSecond, guidance: guidance)
    let isHighway = speed >= Self.highwaySpeedMetersPerSecond
    guard let level = Self.level(guidance: guidance, speed: speed, isHighway: isHighway) else {
      return nil
    }
    let maneuverKey = "\(trip.id):\(maneuverIndex)"
    if let announced = announcedLevels[maneuverKey], announced >= level {
      return nil
    }
    if level < .execute, let lastPromptTime, now - lastPromptTime < Self.minimumGapSeconds {
      return nil
    }

    let instruction = Self.maneuverPrompt(trip.steps[maneuverIndex])
    let maneuverPoint = Self.maneuverPoint(trip, maneuverIndex)
    // The same turn was just announced at this urgency (typically on the route a reroute
    // replaced): it counts as announced for this route too.
    if recentManeuvers.contains(where: {
      $0.level >= level && $0.instruction == instruction
        && navigationDistanceMeters(from: $0.point, to: maneuverPoint) <= Self.sameManeuverRadiusMeters
    }) {
      announcedLevels[maneuverKey] = level
      return nil
    }

    var text = instruction
    // Two maneuvers close together: say both now, because there is no time between them for
    // a second prepare prompt.
    let followingIndex = maneuverIndex + 1
    if followingIndex < trip.steps.count, maneuverIndex > currentStepIndex,
      trip.steps[maneuverIndex].distanceMeters <= (isHighway ? 400 : 150),
      !Self.containsThen(text)
    {
      let following = Self.maneuverPrompt(trip.steps[followingIndex])
      text = "\(Self.trimmingSentenceEnd(text)), then \(Self.lowercasingFirst(following))"
      let followingKey = "\(trip.id):\(followingIndex)"
      if (announcedLevels[followingKey] ?? .early) < .prepare {
        announcedLevels[followingKey] = .prepare
      }
      recentManeuvers.append(
        RecentManeuver(
          instruction: following,
          level: .prepare,
          point: Self.maneuverPoint(trip, followingIndex),
          time: now
        )
      )
    }
    if level < .execute {
      text = "In \(Self.spokenDistance(guidance.distanceToManeuverMeters)), "
        + Self.lowercasingFirst(text)
    }
    announcedLevels[maneuverKey] = level
    recentManeuvers.append(
      RecentManeuver(instruction: instruction, level: level, point: maneuverPoint, time: now)
    )
    return emit(
      NavigationSpeechPrompt(key: "\(maneuverKey):\(level.keySuffix)", text: text),
      now: now
    )
  }

  private func emit(_ prompt: NavigationSpeechPrompt, now: TimeInterval) -> NavigationSpeechPrompt {
    lastPromptTime = now
    return prompt
  }

  private static func maneuverPoint(_ trip: NavOSSCarPlayTrip, _ index: Int) -> NavigationCoordinate {
    let point = trip.steps[index].geometry.first ?? trip.geometry[trip.geometry.count - 1]
    return NavigationCoordinate(latitude: point.latitude, longitude: point.longitude)
  }

  static func effectiveSpeed(_ reported: Double?, guidance: NavOSSCarPlayGuidance) -> Double {
    if let reported, reported.isFinite, reported >= 0 {
      return reported
    }
    guard guidance.durationToManeuverSeconds > 0 else {
      return 0
    }
    return guidance.distanceToManeuverMeters / guidance.durationToManeuverSeconds
  }

  /// The most urgent prompt level the driver has reached for the next maneuver.
  ///
  /// City: prepare within 500 m or 45 s, execute within 75 m or 10 s. Highway speeds move both
  /// out (execute about 7 s ahead, prepare within 1 km) and add an early prompt within 2 km,
  /// which is when a driver needs to start working toward an exit lane.
  static func level(
    guidance: NavOSSCarPlayGuidance,
    speed: Double,
    isHighway: Bool
  ) -> Level? {
    let distance = guidance.distanceToManeuverMeters
    let duration = guidance.durationToManeuverSeconds
    let executeDistance = isHighway ? max(150, speed * 7) : 75
    if distance <= executeDistance || duration <= 10 {
      return .execute
    }
    if distance <= (isHighway ? 1_000 : 500) || duration <= 45 {
      return .prepare
    }
    if isHighway, distance <= 2_000 {
      return .early
    }
    return nil
  }

  /// Distance as a Canadian English speaker would say it: round metres, then half kilometres.
  static func spokenDistance(_ meters: Double) -> String {
    let value = max(0, meters)
    if value < 975 {
      let rounded = value < 100
        ? max(10, Int((value / 10).rounded()) * 10)
        : Int((value / 50).rounded()) * 50
      return "\(rounded) metres"
    }
    let kilometres = value / 1_000
    if kilometres >= 10 {
      return "\(Int(kilometres.rounded())) kilometres"
    }
    let halves = (kilometres * 2).rounded() / 2
    if halves == 1 {
      return "1 kilometre"
    }
    return halves == halves.rounded()
      ? "\(Int(halves)) kilometres"
      : String(format: "%.1f kilometres", halves)
  }

  static func spokenInstruction(_ instruction: String) -> String {
    [
      ("\\bNE\\b", "northeast"),
      ("\\bNW\\b", "northwest"),
      ("\\bSE\\b", "southeast"),
      ("\\bSW\\b", "southwest"),
    ].reduce(instruction) { result, replacement in
      result.replacingOccurrences(
        of: replacement.0,
        with: replacement.1,
        options: [.caseInsensitive, .regularExpression]
      )
    }
  }

  /// What to say for the maneuver that begins `step`. The provider's spoken text is used as it
  /// is when it already names the exit number and the first signed destination. When it leaves
  /// out signed data the route carries (a generic "Take the ramp on the right"), the prompt is
  /// composed from the exit number, branch and "toward" destinations instead, so the driver hears
  /// what the signs say: "Take exit 248 toward Banff". Absent data is never spoken.
  static func maneuverPrompt(_ step: NavOSSCarPlayRouteStep) -> String {
    let base = step.spokenInstruction ?? step.instruction
    let exit = step.exitNumber
    let toward = step.signpostToward.map { Array($0.prefix(2)).joined(separator: " and ") }
    let branch = step.signpostBranch?.first
    let lowerBase = base.lowercased()
    let exitMissing = exit.map { !lowerBase.contains("exit \($0.lowercased())") } ?? false
    let towardMissing =
      step.signpostToward?.first.map { !lowerBase.contains($0.lowercased()) } ?? false
    guard exitMissing || towardMissing else {
      return spokenInstruction(base)
    }
    let modifier = (step.maneuverModifier ?? "").lowercased()
    let side = modifier.contains("left") ? "left" : modifier.contains("right") ? "right" : nil
    var phrase: String
    switch step.maneuverType.lowercased() {
    case "off ramp":
      phrase = exit.map { "Take exit \($0)" } ?? "Take the exit" + (branch.map { " for \($0)" } ?? "")
    case "fork":
      phrase = "Keep \(side ?? "straight")"
      if let target = exit.map({ "exit \($0)" }) ?? branch {
        phrase += " for \(target)"
      }
    case "on ramp":
      phrase = "Take the ramp" + (side.map { " on the \($0)" } ?? "")
        + (branch.map { " onto \($0)" } ?? "")
    default:
      // Other maneuvers keep the provider's wording; only signed destinations are added.
      guard towardMissing, let toward else { return spokenInstruction(base) }
      return spokenInstruction("\(trimmingSentenceEnd(base)) toward \(toward).")
    }
    if let toward {
      phrase += " toward \(toward)"
    }
    return spokenInstruction(phrase + ".")
  }

  private static func containsThen(_ text: String) -> Bool {
    text.range(of: "\\bthen\\b", options: [.caseInsensitive, .regularExpression]) != nil
  }

  private static func trimmingSentenceEnd(_ text: String) -> String {
    var result = text.trimmingCharacters(in: .whitespacesAndNewlines)
    while result.last == "." {
      result.removeLast()
    }
    return result
  }

  /// Lowercases a leading capitalised word ("Turn" → "turn") so the instruction reads naturally
  /// mid-sentence. Words that are not plain capitalised words (road numbers, acronyms) are kept.
  private static func lowercasingFirst(_ text: String) -> String {
    let firstWord = text.prefix { !$0.isWhitespace }
    guard let first = firstWord.first, first.isUppercase,
      firstWord.dropFirst().allSatisfy({ $0.isLowercase })
    else {
      return text
    }
    return first.lowercased() + text.dropFirst()
  }
}
