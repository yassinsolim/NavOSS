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

public enum NavOSSVoiceRecognitionLocaleSelection: Equatable {
  case available(Locale)
  case unavailable
}

/// Chooses an English locale without coupling the navigation core to Speech framework availability.
public func navOSSOnDeviceVoiceRecognitionLocale(
  deviceLocale: Locale,
  supportedLocales: [Locale],
  isAvailable: (Locale) -> Bool
) -> NavOSSVoiceRecognitionLocaleSelection {
  let fallbackLocales = [
    Locale(identifier: "en-CA"),
    Locale(identifier: "en-US"),
    Locale(identifier: "en-GB"),
    Locale(identifier: "en-AU"),
  ]
  let englishSupportedLocales = supportedLocales
    .filter { $0.languageCode?.lowercased() == "en" }
    .sorted { $0.identifier < $1.identifier }
  var candidates = fallbackLocales
  if deviceLocale.languageCode?.lowercased() == "en" {
    candidates.insert(deviceLocale, at: 0)
  }
  candidates.append(contentsOf: englishSupportedLocales)

  var seenIdentifiers = Set<String>()
  for candidate in candidates where seenIdentifiers.insert(candidate.identifier).inserted {
    if isAvailable(candidate) {
      return .available(candidate)
    }
  }
  return .unavailable
}
