import CryptoKit
import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Vectors generated from `communityAssertionClientData` in `@navoss/contracts` by
/// `apps/mobile/scripts/generate-community-assertion-vectors.mjs`. The server rebuilds this
/// string from the request; any byte of difference fails assertion verification.
final class CommunityAssertionTests: XCTestCase {
  private struct Vector: Decodable {
    struct Coordinate: Decodable {
      let latitude: Double
      let longitude: Double
    }

    struct Operation: Decodable {
      let coordinate: Coordinate?
      let heading: Int?
      let kind: String
      let observedAt: Coordinate?
      let reportId: String?
      let type: String?
      let vote: String?
    }

    let challenge: String
    let clientData: String
    let negativeZero: [Bool]
    let operation: Operation
    let sha256: String
  }

  private func loadVectors() throws -> [Vector] {
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: "community-client-data-vectors",
        withExtension: "json",
        subdirectory: "Fixtures"
      )
    )
    return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
  }

  private func coordinate(
    _ value: Vector.Coordinate,
    negativeZero: [Bool]
  ) -> NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(
      latitude: negativeZero.first == true ? -0.0 : value.latitude,
      longitude: negativeZero.last == true ? -0.0 : value.longitude
    )
  }

  private func operation(_ vector: Vector) throws -> NavOSSCommunityOperation {
    let operation = vector.operation
    switch operation.kind {
    case "submit-report":
      return .submitReport(
        type: try XCTUnwrap(operation.type.flatMap(NavOSSCarPlayReportType.init(rawValue:))),
        coordinate: coordinate(try XCTUnwrap(operation.coordinate), negativeZero: vector.negativeZero),
        heading: operation.heading
      )
    case "vote":
      return .vote(
        reportId: try XCTUnwrap(operation.reportId),
        vote: try XCTUnwrap(operation.vote.flatMap(NavOSSCommunityVote.init(rawValue:))),
        observedAt: coordinate(try XCTUnwrap(operation.observedAt), negativeZero: vector.negativeZero)
      )
    case "delete-report":
      return .deleteReport(reportId: try XCTUnwrap(operation.reportId))
    case "delete-installation":
      return .deleteInstallation
    case "traffic-credential":
      return .trafficCredential
    default:
      throw XCTSkip("unknown operation kind \(operation.kind)")
    }
  }

  func testSwiftClientDataMatchesEveryTypeScriptVectorByteForByte() throws {
    let vectors = try loadVectors()
    XCTAssertGreaterThan(vectors.count, 90)
    var kinds = Set<String>()
    for vector in vectors {
      let operation = try operation(vector)
      kinds.insert(operation.kind)
      let clientData = navOSSCommunityAssertionClientData(
        challenge: vector.challenge,
        operation: operation
      )
      XCTAssertEqual(Data(clientData.utf8), Data(vector.clientData.utf8))
      let hash = navOSSCommunityClientDataHash(challenge: vector.challenge, operation: operation)
      XCTAssertEqual(hash.map { String(format: "%02x", $0) }.joined(), vector.sha256)
    }
    XCTAssertEqual(
      kinds,
      ["submit-report", "vote", "delete-report", "delete-installation", "traffic-credential"]
    )
  }

  func testDegreesRoundExactBinaryTiesUpLikeJavaScriptNotHalfEvenLikePrintf() {
    // 51.0078125 is exactly representable; its seventh decimal is an exact tie.
    XCTAssertEqual(String(format: "%.6f", 51.0078125), "51.007812")
    XCTAssertEqual(navOSSJavaScriptFixedDegrees(51.0078125), "51.007813")
    XCTAssertEqual(navOSSJavaScriptFixedDegrees(-114.0078125), "-114.007813")
    XCTAssertEqual(navOSSJavaScriptFixedDegrees(-0.0), "0.000000")
    XCTAssertEqual(navOSSJavaScriptFixedDegrees(-0.0000001), "-0.000000")
    XCTAssertEqual(navOSSJavaScriptFixedDegrees(180), "180.000000")
  }
}

final class AppAttestFailureMappingTests: XCTestCase {
  private let domain = "com.apple.devicecheck.error"

  func testAMissingEntitlementDuringKeyGenerationOrAttestationMeansUnsupported() {
    // Without the entitlement DeviceCheck reports unknownSystemFailure (0), invalidInput (2) or
    // featureUnsupported (1), or an error from another domain.
    for code in [0, 1, 2] {
      XCTAssertEqual(navOSSAppAttestFailure(domain: domain, code: code, step: .generateKey), .unsupported)
      XCTAssertEqual(navOSSAppAttestFailure(domain: domain, code: code, step: .attestKey), .unsupported)
    }
    XCTAssertEqual(
      navOSSAppAttestFailure(domain: NSOSStatusErrorDomain, code: -34018, step: .generateKey),
      .unsupported)
  }

  func testRecoverableErrorsKeepTheirMeaning() {
    XCTAssertEqual(navOSSAppAttestFailure(domain: domain, code: 3, step: .generateAssertion), .invalidKey)
    XCTAssertEqual(navOSSAppAttestFailure(domain: domain, code: 4, step: .attestKey), .serviceUnavailable)
    XCTAssertEqual(navOSSAppAttestFailure(domain: domain, code: 0, step: .generateAssertion), .failed)
  }

  func testAnUnsupportedProviderNeverRegistersOrRetries() async {
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:9")!,
      provider: NavOSSUnavailableAttestationProvider(),
      store: NavOSSCommunityMemorySecretStore())
    XCTAssertFalse(client.canWrite)
    for _ in 0..<3 {
      do {
        _ = try await client.trafficCredential()
        XCTFail("must not proceed")
      } catch {
        XCTAssertEqual(error as? NavOSSCommunityFailure, .attestationUnsupported)
      }
    }
  }
}
