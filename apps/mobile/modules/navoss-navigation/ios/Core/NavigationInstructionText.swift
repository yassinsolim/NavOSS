import Foundation

private func replacing(_ text: String, _ pattern: String, _ template: String) -> String {
  text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
}

/// Valhalla writes a road with several names as "1/16 Avenue NW": the bare route number of
/// Highway 1 joined to the street name, which reads as "one sixteenth". A bare number beside such
/// a slash is shown as "Highway 1" and the names are spaced: "Highway 1 / 16 Avenue NW". Spaced
/// text is left alone, so applying it twice is harmless. Mirrors the phone's `readableRoadNames`.
func navOSSReadableRoadNames(_ text: String) -> String {
  var result = replacing(
    text, #"(?<![\w/])(?<!Highway |Hwy |Route )(\d{1,3}[A-Z]?)/(?=\S)"#, "Highway $1 / ")
  result = replacing(result, #"(?<=\S)/(\d{1,3}[A-Z]?)(?![\w/])"#, " / Highway $1")
  return replacing(result, #"(?<=\S)/(?=\S)"#, " / ")
}

private func navOSSSaysArrived(_ instruction: String) -> Bool {
  instruction.trimmingCharacters(in: .whitespacesAndNewlines)
    .range(of: #"^(you have|you've) arrived\b"#, options: [.regularExpression, .caseInsensitive])
    != nil
}

/// What a route step says on screen. Valhalla's arrival step reads "You have arrived at your
/// destination." although it is shown from the previous maneuver on, often kilometres early;
/// while the destination is still ahead it says so. The arrived state has its own text.
func navOSSPresentedInstruction(_ instruction: String, maneuverType: String) -> String {
  if maneuverType.lowercased() == "arrive", navOSSSaysArrived(instruction) {
    return "Your destination is ahead."
  }
  return navOSSReadableRoadNames(instruction)
}

/// What a route step says aloud: one name per road. "Highway 1 / 16 Avenue NW" is spoken as
/// "16 Avenue NW" (the name on the street signs), and of two street names only the first is said.
func navOSSSpokenRoadNames(_ instruction: String) -> String {
  var result = navOSSReadableRoadNames(instruction)
  result = replacing(result, #"\b(?:Highway|Hwy) \d{1,3}[A-Z]? / "#, "")
  result = replacing(result, #" / (?:Highway|Hwy) \d{1,3}[A-Z]?\b"#, "")
  return replacing(result, #" / [^.,/]*?(?= toward | towards | onto | then |[.,]|$)"#, "")
}

/// The spoken form of a step's maneuver text, before signed destinations are added.
func navOSSSpokenStepText(_ text: String, maneuverType: String) -> String {
  if maneuverType.lowercased() == "arrive", navOSSSaysArrived(text) {
    return "Your destination is ahead."
  }
  return navOSSSpokenRoadNames(text)
}
