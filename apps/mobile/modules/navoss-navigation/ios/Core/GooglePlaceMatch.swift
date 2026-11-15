import Foundation

/// Decides whether the place Google's Place Details component found at a coordinate is the place
/// the driver selected. Google's component is shown only when this returns true, so a different
/// business in the same building is never presented as the selected one.
///
/// Only the two names and coordinates are compared; nothing from Google is kept.
public enum NavOSSGooglePlaceMatch {
  /// Farther than this, a same-named Google place is treated as a different branch.
  public static let maximumDistanceMeters: Double = 200

  public static func matches(
    selectedName: String,
    selectedLatitude: Double,
    selectedLongitude: Double,
    candidateName: String,
    candidateLatitude: Double,
    candidateLongitude: Double
  ) -> Bool {
    let distance = distanceMeters(
      fromLatitude: selectedLatitude,
      fromLongitude: selectedLongitude,
      toLatitude: candidateLatitude,
      toLongitude: candidateLongitude
    )
    return distance.isFinite && distance <= maximumDistanceMeters
      && namesMatch(selectedName, candidateName)
  }

  /// True when the names identify the same business. Names are split into a core and an optional
  /// branch qualifier ("Tim Hortons - Kensington", "Safeway (Signal Hill)"). Two different
  /// qualifiers are two branches; a qualifier on one side only is ignored. A qualifier that names a
  /// department ("Safeway (Pharmacy)") is part of the identity, never branch metadata. Cores match
  /// when equal after normalisation, or when the longer adds only a legal form or the CF mall
  /// prefix ("CF Chinook Centre"). Anything else is rejected: a false reject only hides Google's panel.
  public static func namesMatch(_ left: String, _ right: String) -> Bool {
    let leftName = parsedName(left)
    let rightName = parsedName(right)
    if let leftQualifier = leftName.qualifier, let rightQualifier = rightName.qualifier,
      leftQualifier != rightQualifier {
      return false
    }
    return tokensMatch(leftName.core, rightName.core)
  }

  // MARK: - Normalisation

  /// Words that name a separately listed department or service inside a larger business.
  private static let departmentWords: Set<String> = [
    "atm", "auto", "automotive", "bakery", "carwash", "deli", "fuel", "garden", "gas", "liquor",
    "optical", "parking", "pharmacy", "spirits", "tire", "tires", "wash", "wine",
  ]

  /// Category words that cannot identify one business on their own.
  private static let genericWords: Set<String> = [
    "bank", "bar", "cafe", "centre", "clinic", "coffee", "dental", "gas", "grill", "gym", "hotel",
    "inn", "library", "market", "mall", "park", "parking", "pharmacy", "pizza", "pub", "restaurant",
    "salon", "school", "shop", "spa", "store", "sushi",
  ]

  /// The only words a longer name may add and still be the same business: legal forms and the
  /// Cadillac Fairview mall prefix. Location words (compass points, cities, provinces) stay part of
  /// the name ("The North Face", "Calgary Co-op") and count only as an explicit branch qualifier
  /// ("Tim Hortons - Downtown", "Safeway (North Vancouver)").
  private static let nonIdentityWords: Set<String> = [
    "cf", "co", "corp", "corporation", "inc", "incorporated", "limited", "llc", "ltd", "ulc",
  ]

  private static let ignoredWords: Set<String> = ["and", "the"]

  private static let legalSuffixes: Set<String> = [
    "co", "corp", "corporation", "inc", "incorporated", "limited", "llc", "ltd", "ulc",
  ]

  private static let unitWords: Set<String> = ["bay", "no", "ste", "suite", "unit"]

  private static let spellings: [String: String] = [
    "center": "centre",
    "theater": "theatre",
  ]

  private static let leadingAbbreviations: [String: String] = [
    "ft": "fort",
    "mt": "mount",
    "st": "saint",
  ]

  private static let branchSeparators = [" - ", " – ", " — ", " | ", " @ ", ": "]

  /// The identity tokens and, when present, a branch qualifier from parentheses or after a branch
  /// separator. A department qualifier stays in the core.
  static func parsedName(_ name: String) -> (core: [String], qualifier: [String]?) {
    let folded = name.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
      locale: Locale(identifier: "en_CA")
    )
    var qualifierParts: [String] = []
    var remainder = folded
    while let open = remainder.firstIndex(of: "("),
      let close = remainder[open...].firstIndex(of: ")") {
      qualifierParts.append(String(remainder[remainder.index(after: open)..<close]))
      remainder.replaceSubrange(open...close, with: " ")
    }
    if let separator = branchSeparators
      .compactMap({ remainder.range(of: $0) })
      .min(by: { $0.lowerBound < $1.lowerBound }) {
      qualifierParts.append(String(remainder[separator.upperBound...]))
      remainder = String(remainder[..<separator.lowerBound])
    }
    let core = normalizedTokens(remainder)
    let qualifier = normalizedTokens(qualifierParts.joined(separator: " "))
    if qualifier.isEmpty {
      return (core, nil)
    }
    if qualifier.contains(where: { departmentWords.contains($0) }) {
      return (normalizedTokens(folded.replacingOccurrences(of: "(", with: " ")), nil)
    }
    return (core, qualifier)
  }

  static func normalizedTokens(_ value: String) -> [String] {
    var text = value
      .replacingOccurrences(of: "&", with: " and ")
      .replacingOccurrences(of: "+", with: " and ")
      .replacingOccurrences(of: #"['’ʼ`]"#, with: "", options: .regularExpression)
      // Store and unit numbers: "#1234", "No. 5".
      .replacingOccurrences(of: #"#\s*[a-z0-9-]+"#, with: " ", options: .regularExpression)
    text = String(
      text.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
    )
    var tokens = text.split(separator: " ").map(String.init)

    var withoutUnits: [String] = []
    var index = 0
    while index < tokens.count {
      let token = tokens[index]
      if unitWords.contains(token), index + 1 < tokens.count,
        tokens[index + 1].contains(where: \.isNumber) {
        index += 2
        continue
      }
      withoutUnits.append(token)
      index += 1
    }
    tokens = withoutUnits

    if let first = tokens.first, let expanded = leadingAbbreviations[first], tokens.count > 1 {
      tokens[0] = expanded
    }
    tokens = tokens
      .filter { !ignoredWords.contains($0) }
      .map { spellings[$0] ?? $0 }
    while tokens.count > 1, let last = tokens.last, legalSuffixes.contains(last) {
      tokens.removeLast()
    }
    return tokens
  }

  // MARK: - Comparison

  private static func tokensMatch(_ left: [String], _ right: [String]) -> Bool {
    guard !left.isEmpty, !right.isEmpty else {
      return false
    }
    if left == right {
      return true
    }
    let (shorter, longer) = left.count <= right.count ? (left, right) : (right, left)
    guard shorter.count < longer.count, let start = contiguousRange(of: shorter, in: longer) else {
      return false
    }
    let letters = shorter.reduce(0) { $0 + $1.count }
    guard shorter.count >= 2 || letters >= 3 else {
      return false
    }
    if shorter.allSatisfy({ genericWords.contains($0) }) {
      return false
    }
    let extra = Array(longer[..<start]) + Array(longer[(start + shorter.count)...])
    return extra.allSatisfy { nonIdentityWords.contains($0) }
  }

  private static func contiguousRange(of needle: [String], in haystack: [String]) -> Int? {
    guard !needle.isEmpty, needle.count <= haystack.count else { return nil }
    for start in 0...(haystack.count - needle.count)
    where Array(haystack[start..<(start + needle.count)]) == needle {
      return start
    }
    return nil
  }

  static func distanceMeters(
    fromLatitude: Double,
    fromLongitude: Double,
    toLatitude: Double,
    toLongitude: Double
  ) -> Double {
    let radius = 6_371_000.0
    let toRadians = Double.pi / 180
    let latitudeDelta = (toLatitude - fromLatitude) * toRadians
    let longitudeDelta = (toLongitude - fromLongitude) * toRadians
    let haversine =
      pow(sin(latitudeDelta / 2), 2)
      + cos(fromLatitude * toRadians) * cos(toLatitude * toRadians)
      * pow(sin(longitudeDelta / 2), 2)
    return 2 * radius * asin(min(1, sqrt(haversine)))
  }
}
