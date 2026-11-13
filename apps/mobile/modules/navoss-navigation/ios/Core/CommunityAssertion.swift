import CryptoKit
import Foundation

/// A driver's answer to "Still there?". Dismissing the prompt sends nothing.
public enum NavOSSCommunityVote: String, CaseIterable, Sendable {
  case present
  case notPresent = "not-present"
}

/// One write to `/v2/community/*` or `/v2/traffic/credentials`, as bound into its App Attest
/// assertion. Mirrors `CommunityAssertedOperation` in `packages/contracts/src/community-report.ts`.
public enum NavOSSCommunityOperation: Equatable, Sendable {
  case submitReport(
    type: NavOSSCarPlayReportType,
    coordinate: NavOSSCarPlayCoordinate,
    heading: Int?
  )
  case vote(reportId: String, vote: NavOSSCommunityVote, observedAt: NavOSSCarPlayCoordinate)
  case deleteReport(reportId: String)
  case deleteInstallation
  case trafficCredential

  var kind: String {
    switch self {
    case .submitReport: "submit-report"
    case .vote: "vote"
    case .deleteReport: "delete-report"
    case .deleteInstallation: "delete-installation"
    case .trafficCredential: "traffic-credential"
    }
  }
}

/// The canonical client data the server rebuilds from a validated request, byte for byte the
/// output of `communityAssertionClientData(challenge, operation)` in `@navoss/contracts`.
/// The shared vectors in `Tests/Fixtures/community-client-data-vectors.json` are generated
/// from the TypeScript helper and prove the two agree.
public func navOSSCommunityAssertionClientData(
  challenge: String,
  operation: NavOSSCommunityOperation
) -> String {
  var fields = ["navoss-community-v1", operation.kind, challenge]
  switch operation {
  case let .submitReport(type, coordinate, heading):
    fields.append(type.rawValue)
    fields.append(navOSSJavaScriptFixedDegrees(coordinate.latitude))
    fields.append(navOSSJavaScriptFixedDegrees(coordinate.longitude))
    fields.append(heading.map { String($0) } ?? "-")
  case let .vote(reportId, vote, observedAt):
    fields.append(reportId)
    fields.append(vote.rawValue)
    fields.append(navOSSJavaScriptFixedDegrees(observedAt.latitude))
    fields.append(navOSSJavaScriptFixedDegrees(observedAt.longitude))
  case let .deleteReport(reportId):
    fields.append(reportId)
  case .deleteInstallation, .trafficCredential:
    break
  }
  return fields.joined(separator: "\n")
}

/// SHA-256 of the UTF-8 client data: the `clientDataHash` App Attest signs.
public func navOSSCommunityClientDataHash(
  challenge: String,
  operation: NavOSSCommunityOperation
) -> Data {
  Data(
    SHA256.hash(
      data: Data(navOSSCommunityAssertionClientData(challenge: challenge, operation: operation).utf8)
    )
  )
}

/// `Number.prototype.toFixed(6)` exactly as ECMAScript defines it: the integer `n` nearest to
/// `|value| × 10⁶` computed on the exact binary value, ties to the larger `n`, with a minus sign
/// only when `value < 0` (so `-0` prints without one). `String(format: "%.6f")` differs on exact
/// ties (it rounds half to even), which would make the server reject the assertion.
func navOSSJavaScriptFixedDegrees(_ value: Double) -> String {
  precondition(value.isFinite && abs(value) < 1e9, "coordinates are validated before signing")
  let magnitude = abs(value)
  let scaled = navOSSRoundHalfUpMillionths(magnitude)
  let integerPart = scaled / 1_000_000
  let fraction = String(scaled % 1_000_000)
  let padded = String(repeating: "0", count: 6 - fraction.count) + fraction
  return "\(value < 0 ? "-" : "")\(integerPart).\(padded)"
}

/// `round-half-up(magnitude × 10⁶)` on the exact binary value of `magnitude` (0 ≤ magnitude < 1e9).
private func navOSSRoundHalfUpMillionths(_ magnitude: Double) -> UInt64 {
  // Below 1e-7 the scaled value is under 0.1, so it rounds to 0 whatever its exact digits.
  guard magnitude >= 1e-7 else { return 0 }
  // magnitude = significand × 2^shiftExponent with an integer 53-bit significand.
  let significand = (UInt64(1) << 52) | magnitude.significandBitPattern
  let shift = 52 - Int(magnitude.exponent)
  let product = significand.multipliedFullWidth(by: 1_000_000)
  let high = product.high
  let low = product.low
  guard shift > 0 else {
    // Integral magnitudes (≥ 2^52) cannot occur below 1e9.
    return low << UInt64(-shift)
  }
  let quotient: UInt64
  if shift >= 64 {
    quotient = high >> UInt64(shift - 64)
  } else {
    quotient = (low >> UInt64(shift)) | (high << UInt64(64 - shift))
  }
  let halfBit = shift - 1
  let roundsUp =
    halfBit >= 64
    ? (high >> UInt64(halfBit - 64)) & 1 == 1
    : (low >> UInt64(halfBit)) & 1 == 1
  return quotient + (roundsUp ? 1 : 0)
}
