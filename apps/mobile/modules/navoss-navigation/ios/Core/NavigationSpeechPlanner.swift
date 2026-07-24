import Foundation

struct NavigationSpeechPrompt: Equatable, Sendable {
  let key: String
  let text: String
}

final class NavigationSpeechPlanner {
  private var announcedKeys: Set<String> = []

  func reset() {
    announcedKeys.removeAll()
  }

  func prompt(
    trip: NavOSSCarPlayTrip,
    guidance: NavOSSCarPlayGuidance,
    hasCurrentLocation: Bool
  ) -> NavigationSpeechPrompt? {
    guard hasCurrentLocation else {
      return nil
    }

    let prompt: NavigationSpeechPrompt
    if guidance.phase == .arrived {
      prompt = NavigationSpeechPrompt(
        key: "\(trip.id):arrived",
        text: "You've arrived at \(trip.destination.name)."
      )
    } else {
      let currentStepIndex = min(guidance.stepIndex, trip.steps.count - 1)
      let guidanceIndex = min(guidance.stepIndex + 1, trip.steps.count - 1)
      let step = trip.steps[guidanceIndex]
      let instruction = spokenInstruction(
        trip.steps[currentStepIndex].spokenInstruction ?? step.instruction
      )
      if guidance.distanceToManeuverMeters <= 75
        || guidance.durationToManeuverSeconds <= 10
      {
        prompt = NavigationSpeechPrompt(
          key: "\(trip.id):\(guidanceIndex):execute",
          text: instruction
        )
      } else if guidance.distanceToManeuverMeters <= 500
        || guidance.durationToManeuverSeconds <= 45
      {
        prompt = NavigationSpeechPrompt(
          key: "\(trip.id):\(guidanceIndex):prepare",
          text: "In \(spokenDistance(guidance.distanceToManeuverMeters)), \(instruction)"
        )
      } else {
        return nil
      }
    }

    guard announcedKeys.insert(prompt.key).inserted else {
      return nil
    }
    return prompt
  }

  private func spokenInstruction(_ instruction: String) -> String {
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

  private func spokenDistance(_ meters: Double) -> String {
    if meters >= 1_000 {
      let kilometers = (meters / 100).rounded() / 10
      return String(format: "%.1f kilometers", kilometers)
    }
    let roundedMeters = max(100, Int((meters / 50).rounded()) * 50)
    return "\(roundedMeters) meters"
  }
}
