import Foundation

/// Returns the destination portion of an on-device voice-search transcript.
///
/// The recognizer may include a direct navigation command before the destination. Strip only those
/// exact leading commands; everything else stays intact so search never invents a destination.
public func navOSSVoiceDestinationQuery(_ transcript: String) -> String? {
  let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else {
    return nil
  }

  for prefix in ["navigate to", "take me to", "directions to"] {
    guard
      let range = trimmed.range(
        of: prefix,
        options: [.anchored, .caseInsensitive]
      )
    else {
      continue
    }

    let remainder = trimmed[range.upperBound...]
    guard !remainder.isEmpty else {
      return nil
    }
    guard remainder.first?.isWhitespace == true else {
      continue
    }

    let destination = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
    return destination.isEmpty ? nil : destination
  }

  return trimmed
}
