import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The Android boundary (docs/architecture/android-core.md): JS-shaped records in, the iOS
/// module's snapshot shape out, host callbacks, errors as values.
final class NavOSSCoreFacadeTests: XCTestCase {
  private let config = #"{"apiBaseUrl":"https://navoss.test"}"#

  private func makeEngine(_ host: RecordingCoreHost, config: String? = nil) throws
    -> NavOSSCoreEngine
  {
    try NavOSSCoreEngine(configJSON: config ?? self.config, host: host)
  }

  private func fixes() throws -> [String] {
    let trace = try bundled("Fixtures", "calgary-deerfoot-glenmore.trace.json")
    let object = try JSONSerialization.jsonObject(with: Data(trace.utf8)) as? [String: Any]
    return try XCTUnwrap(object?["fixes"] as? [[String: Any]]).map {
      String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self)
    }
  }

  private func timestamp(_ fix: String) throws -> Double {
    let object = try JSONSerialization.jsonObject(with: Data(fix.utf8)) as? [String: Any]
    return try XCTUnwrap(object?["timestampMs"] as? Double)
  }

  private func object(_ json: String) throws -> [String: Any] {
    try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  /// The facade's snapshot of the engine's current state against the iOS module's serializer.
  private func assertMatchesIOSModule(
    _ engine: NavOSSCoreEngine, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let state = engine.engine.currentState()
    let facade = try canonicalJSON(navOSSCoreSnapshot(state).encodedString())
    let reference = canonicalJSON(object: IOSModuleSerializer.serialize(state))
    guard facade != reference else { return }
    let difference = zip(facade.split(separator: "\n"), reference.split(separator: "\n"))
      .first { $0 != $1 }
    XCTFail("facade \(difference.map { "\($0.0) vs iOS \($0.1)" } ?? "differs in length")", file: file, line: line)
  }

  /// Golden file `name` (written from the iOS module's serializer) against the facade's snapshot.
  private func assertGolden(
    _ name: String, _ engine: NavOSSCoreEngine, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let state = engine.engine.currentState()
    // A proposal's id is random; the golden file holds a placeholder.
    func stable(_ text: String) -> String {
      guard let id = state.rerouteProposal?.id else { return text }
      return text.replacingOccurrences(of: id, with: "<proposal-id>")
    }
    let reference = stable(canonicalJSON(object: IOSModuleSerializer.serialize(state)) + "\n")
    if regeneratesGolden {
      try writeSource("Golden", name, reference)
    }
    let golden = try bundled("Golden", name)
    #if os(Android)
      // The golden files were written on macOS; bionic's libm differs in the last digits.
      for (label, text) in [("facade", stable(try engine.snapshot())), ("iOS serializer", reference)] {
        if let difference = jsonDifference(golden, text, tolerance: 1e-12) {
          XCTFail("\(label) vs \(name)\(difference)", file: file, line: line)
        }
      }
    #else
      XCTAssertEqual(
        stable(try canonicalJSON(engine.snapshot()) + "\n"), golden, file: file, line: line)
      XCTAssertEqual(reference, golden, file: file, line: line)
    #endif
  }

  // MARK: Fixtures

  /// The committed trip fixture is the recorded Calgary route as the iOS module serializes a
  /// trip, i.e. what JS holds and passes to `setRoute`.
  func testTheTripFixtureIsTheRecordedRouteInItsJSShape() throws {
    let trips = try navOSSTripsFromRoutesV2Response(
      JSONSerialization.data(
        withJSONObject: try XCTUnwrap(
          JSONSerialization.jsonObject(with: try repositoryFixture(calgaryRoute))
            as? [String: Any])["response"]!),
      destination: NavOSSCarPlayDestination(
        id: "replay-destination", label: "Replay destination", latitude: 50.9881,
        longitude: -114.094978, name: "Replay destination"))
    let trip = try XCTUnwrap(trips.first)
    let reference = canonicalJSON(object: IOSModuleSerializer.serialize(trip)) + "\n"
    if regeneratesGolden {
      try writeSource("Fixtures", "calgary-deerfoot-glenmore.trip.json", reference)
    }
    XCTAssertEqual(try calgaryTripJSON(), reference)
    XCTAssertEqual(try canonicalJSON(navOSSCoreTrip(trip).encodedString()) + "\n", reference)
  }

  // MARK: Trip record

  /// Every recorded `/v2/routes` trip survives serialize → decode unchanged.
  func testRecordedTripsRoundTripThroughTheJSShape() throws {
    let directory = repositoryRoot.appendingPathComponent("apps/mobile/test/fixtures/routes-v2")
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { $0.hasSuffix(".v2.json") }.sorted()
    XCTAssertGreaterThan(names.count, 5)
    var trips = 0
    for name in names {
      let fixture = try JSONSerialization.jsonObject(
        with: Data(contentsOf: directory.appendingPathComponent(name))) as? [String: Any]
      guard let response = fixture?["response"] else { continue }
      let decoded = try navOSSTripsFromRoutesV2Response(
        JSONSerialization.data(withJSONObject: response),
        destination: NavOSSCarPlayDestination(
          category: "poi", id: "d", label: "Destination 🚗", latitude: 51, longitude: -114,
          name: "Destination"))
      for trip in decoded {
        let json = navOSSCoreTrip(trip).encodedString()
        let record = try JSONDecoder().decode(NavOSSCoreTripRecord.self, from: Data(json.utf8))
        // The trip serializer omits the destination's category, as on iOS.
        XCTAssertEqual(
          record.trip,
          trip.replacingDestination(
            NavOSSCarPlayDestination(
              id: "d", label: "Destination 🚗", latitude: 51, longitude: -114,
              name: "Destination")),
          name)
        trips += 1
      }
    }
    XCTAssertGreaterThan(trips, 10)
  }

  func testTheTripRecordFollowsTheExpoRecordRules() throws {
    var trip = try object(try calgaryTripJSON())
    var steps = try XCTUnwrap(trip["steps"] as? [[String: Any]])
    steps[0]["lanes"] = [
      ["indications": ["straight"], "valid": true, "active": true, "validIndication": "straight"],
      ["indications": ["right"], "valid": false],
    ]
    steps[1]["lanes"] = [["indications": ["hover"], "valid": true]]
    steps[0]["roundaboutExit"] = 2.0
    trip["steps"] = steps
    let segments = try XCTUnwrap(trip["geometry"] as? [Any]).count - 1
    trip["congestion"] = Array(repeating: "slow", count: segments)
    trip["speedLimitsKph"] = Array(repeating: 100.0, count: segments)
    trip["traffic"] = [
      "delaySeconds": 60, "typicalDurationSeconds": 400,
      "oldestObservedAt": "2026-11-15T12:34:56.789Z",
    ]
    trip["waypoints"] = [[String: Any]]()
    trip["preferences"] = nil

    let decoded = try JSONDecoder().decode(
      NavOSSCoreTripRecord.self, from: JSONSerialization.data(withJSONObject: trip)
    ).trip
    let lanes = try XCTUnwrap(decoded.steps[0].lanes)
    XCTAssertEqual(lanes.map(\.isPreferred), [true, false])
    XCTAssertEqual(lanes.map(\.isValid), [true, false])
    XCTAssertEqual(lanes[0].activeIndication, .straight)
    XCTAssertNil(decoded.steps[1].lanes, "an unknown arrow drops the whole lane list")
    XCTAssertEqual(decoded.steps[0].roundaboutExit, 2)
    XCTAssertEqual(decoded.congestion?.count, segments)
    XCTAssertEqual(decoded.speedLimitsKph?.first, 100)
    XCTAssertEqual(
      decoded.traffic?.oldestObservedAt?.timeIntervalSince1970 ?? 0, 1_794_746_096.789,
      accuracy: 0.001)
    XCTAssertNil(decoded.waypoints, "an empty list means no waypoints")
    XCTAssertEqual(decoded.preferences, NavOSSRoutePreferences())

    trip["congestion"] = ["slow", "gridlock"]
    XCTAssertNil(
      try JSONDecoder().decode(
        NavOSSCoreTripRecord.self, from: JSONSerialization.data(withJSONObject: trip)
      ).trip.congestion, "an unknown level drops the whole list")
  }

  func testTripFeaturesMatchTheIOSModuleAndTheGoldenFile() throws {
    var trip = try object(try calgaryTripJSON())
    var steps = try XCTUnwrap(trip["steps"] as? [[String: Any]])
    steps[0]["lanes"] = [
      ["indications": ["straight", "right"], "valid": true, "active": true, "validIndication": "right"],
      ["indications": ["right"], "valid": false],
    ]
    steps[0]["signpostBranch"] = ["AB-2"]
    trip["steps"] = steps
    let segments = try XCTUnwrap(trip["geometry"] as? [Any]).count - 1
    trip["congestion"] = Array(repeating: "heavy", count: segments)
    trip["traffic"] = [
      "delaySeconds": 60, "typicalDurationSeconds": 400,
      "oldestObservedAt": "2026-11-15T12:34:56.789Z",
    ]
    trip["trafficSource"] = "navoss-community"
    trip["waypoints"] = [
      [
        "category": "poi", "id": "w", "label": "Stop 🍩", "latitude": 51.0,
        "longitude": -114.05, "name": "Stop",
      ]
    ]
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let snapshot = try object(
      try engine.setRoute(
        String(decoding: try JSONSerialization.data(withJSONObject: trip), as: UTF8.self)))
    let traffic = try XCTUnwrap((snapshot["trip"] as? [String: Any])?["traffic"] as? [String: Any])
    XCTAssertEqual(traffic["oldestObservedAt"] as? String, "2026-11-15T12:34:56Z")
    try assertGolden("trip-features.json", engine)
  }

  func testISO8601MatchesTheFoundationFormatter() {
    for seconds in [0, 1_794_746_096.789, 1_800_000_000, -86_400.5, 4_102_444_799.999] {
      let date = Date(timeIntervalSince1970: seconds)
      XCTAssertEqual(navOSSCoreISO8601(date), ISO8601DateFormatter().string(from: date))
    }
  }

  // MARK: Snapshots

  func testSnapshotsThroughATripMatchTheIOSModule() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    try assertGolden("idle.json", engine)
    _ = try engine.setRoute(try calgaryTripJSON())
    try assertGolden("route-start.json", engine)
    for fix in try fixes().prefix(60) {
      host.setNow(try timestamp(fix))
      _ = try engine.updateLocation(fix)
      try assertMatchesIOSModule(engine)
    }
    try assertGolden("tracking.json", engine)
    _ = engine.clearRoute()
    try assertMatchesIOSModule(engine)
  }

  /// The whole replay, every state checked against the iOS serializer, and the transcript
  /// against the committed one the Android instrumented test compares with.
  func testReplayMatchesTheIOSModuleAndTheCommittedTranscript() throws {
    let transcript = try runReplay { engine in try self.assertMatchesIOSModule(engine) }
    let text = transcript.joined(separator: "\n") + "\n"
    if regeneratesGolden {
      try writeSource("Fixtures", "calgary-deerfoot-glenmore.replay.txt", text)
    }
    let expected = try bundled("Fixtures", "calgary-deerfoot-glenmore.replay.txt")
    #if os(Android)
      assertTranscriptsMatch(
        expected.split(separator: "\n").map(String.init), transcript, tolerance: 1e-12)
    #else
      XCTAssertEqual(text, expected)
    #endif
    XCTAssertTrue(transcript.contains("request POST /v2/routes"), "the trace reroutes")
    XCTAssertTrue(transcript.contains { $0.hasPrefix("speak maneuver ") })
    // The detour is answered twice with the recorded route, and both replacements are installed.
    let reroutes = transcript.filter { $0.hasPrefix("reroute ") }
    XCTAssertEqual(reroutes.count, 2)
    XCTAssertTrue(reroutes.last?.contains(#""rerouteCount":2"#) == true)
    XCTAssertTrue(reroutes.allSatisfy { $0.contains(#""routeStatus":"tracking""#) })
  }

  func testAnAskFirstProposalMatchesTheIOSModule() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(
      host, config: #"{"apiBaseUrl":"https://navoss.test","rerouteMode":"ask-first"}"#)
    defer { engine.close() }
    _ = try engine.setRoute(try calgaryTripJSON())
    var proposalId: String?
    for fix in try fixes() {
      host.setNow(try timestamp(fix))
      let state = try engine.updateLocation(fix)
      guard state.contains(#""routeStatus":"rerouting""#) else { continue }
      if let config = host.takeRequest(endingWithAny: ["/v2/config"]) {
        engine.completeHTTPRequest(id: config.id, responseJSON: okResponse(try recordedBody(productionConfig)))
      }
      let routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/routes"]))
      let request = try object(try XCTUnwrap(object(routes.json)["body"] as? String))
      XCTAssertNotNil(request["origin"], "the reroute starts from the vehicle")
      engine.completeHTTPRequest(id: routes.id, responseJSON: okResponse(try recordedBody(calgaryRoute)))
      _ = try XCTUnwrap(host.waitUntilNotRerouting())
      proposalId = (try object(engine.snapshot())["rerouteProposal"] as? [String: Any])?["id"]
        as? String
      break
    }
    let id = try XCTUnwrap(proposalId, "ask-first offers the replacement")
    try assertGolden("ask-first-proposal.json", engine)
    XCTAssertFalse(engine.acceptRerouteProposal(id: "not-the-proposal"))
    XCTAssertTrue(engine.declineRerouteProposal(id: id))
    XCTAssertNil(try object(engine.snapshot())["rerouteProposal"])
  }

  // MARK: Restore through host storage

  func testATripRestoresThroughHostStorage() throws {
    let host = RecordingCoreHost()
    let first = try makeEngine(host)
    _ = try first.setRoute(try calgaryTripJSON())
    for fix in try fixes().prefix(30) {
      host.setNow(try timestamp(fix))
      _ = try first.updateLocation(fix)
    }
    first.close()
    XCTAssertNotNil(host.storage["org.navoss.mobile.active-navigation-trip.v2"])
    XCTAssertNotNil(host.storage["org.navoss.mobile.active-navigation-trip.v2.progress"])

    let restored = try makeEngine(host)
    defer { restored.close() }
    let acquiring = try object(restored.resumePersistedTrip())
    XCTAssertEqual(acquiring["isAcquiringPosition"] as? Bool, true)
    XCTAssertNil(acquiring["guidance"])
    try assertGolden("restored-acquiring.json", restored)

    // A first fix far off the route ends the restored trip and says why.
    host.setNow(host.nowMs() + 5_000)
    let offRoute = #"{"latitude":51.2,"longitude":-113.7,"horizontalAccuracyMeters":5,"timestampMs":\#(host.nowMs())}"#
    let ended = try object(try restored.updateLocation(offRoute))
    XCTAssertEqual(ended["tripEndReason"] as? String, "restored-trip-off-route")
    try assertGolden("restored-off-route.json", restored)
    XCTAssertNil(host.storage["org.navoss.mobile.active-navigation-trip.v2"])
  }

  // MARK: Callbacks

  func testHostEffectsOfStartAndClear() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    _ = try engine.setRoute(try calgaryTripJSON())
    XCTAssertEqual(
      host.events, ["cancelSpeech", "stateChanged", "needsLocationUpdates", "startClock"])
    // The camera list is asked for once, without any location.
    let cameras = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v1/cameras"]))
    XCTAssertEqual(requestURL(cameras.json), "https://navoss.test/v1/cameras")
    host.events.removeAll()
    _ = engine.clearRoute()
    XCTAssertEqual(
      host.events,
      ["stopClock", "stateChanged", "reconcileLocationUpdates false", "cancelSpeech"])
    XCTAssertEqual(try object(host.lastSnapshot)["phase"] as? String, "idle")
  }

  func testCamerasArriveThroughTheHostAndAreAnnounced() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    _ = try engine.setRoute(try calgaryTripJSON())
    let cameras = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v1/cameras"]))
    XCTAssertNil(try object(cameras.json)["body"])
    engine.completeHTTPRequest(id: cameras.id, responseJSON: okResponse(try recordedBody(productionCameras)))
    let done = expectation(description: "cameras installed")
    Task {
      await engine.waitForPendingWork()
      done.fulfill()
    }
    wait(for: [done], timeout: 30)
    XCTAssertGreaterThan(engine.engine.lock.withLock { engine.engine.safetyCameraLocked(id: "calgary-isc:50.9311404:-114.0322880") != nil } ? 1 : 0, 0)
  }

  func testAudioModeAndPreferences() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    XCTAssertEqual(
      try object(engine.preferences()) as NSDictionary,
      [
        "announceRoadReports": true, "audioMode": "all-guidance", "rerouteMode": "adaptive",
        "speedingAudibleWarning": false, "speedingToleranceKph": 5,
      ] as NSDictionary)
    try engine.setAudioMode("muted")
    XCTAssertEqual(host.events.last, "cancelSpeech")
    try engine.setRerouteMode("keep-route")
    engine.setSpeedingWarning(toleranceKph: 40, audible: true)
    engine.setAnnounceRoadReports(false)
    XCTAssertEqual(
      try object(engine.preferences()) as NSDictionary,
      [
        "announceRoadReports": false, "audioMode": "muted", "rerouteMode": "keep-route",
        "speedingAudibleWarning": true, "speedingToleranceKph": 20,
      ] as NSDictionary)
    XCTAssertEqual(try object(engine.snapshot())["rerouteMode"] as? String, "keep-route")
  }

  // MARK: HTTP

  func testAnUnreachableRerouteFailsAndRetriesLater() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    _ = try engine.setRoute(try calgaryTripJSON())
    for fix in try fixes() {
      host.setNow(try timestamp(fix))
      guard try engine.updateLocation(fix).contains(#""routeStatus":"rerouting""#) else { continue }
      let request = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config"]))
      engine.completeHTTPRequest(id: request.id, responseJSON: #"{"error":"unreachable"}"#)
      // Without a config the client still tries the routes.
      let routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/routes"]))
      engine.completeHTTPRequest(id: routes.id, responseJSON: "not json")
      let state = try object(try XCTUnwrap(host.waitUntilNotRerouting()))
      XCTAssertEqual(state["routeStatus"] as? String, "reroute-failed")
      // A repeated or unknown answer is ignored.
      engine.completeHTTPRequest(id: routes.id, responseJSON: okResponse("{}"))
      engine.completeHTTPRequest(id: 9_999, responseJSON: okResponse("{}"))
      return
    }
    XCTFail("the trace never left the route")
  }

  func testClearingCancelsAPendingReroute() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    _ = try engine.setRoute(try calgaryTripJSON())
    for fix in try fixes() {
      host.setNow(try timestamp(fix))
      guard try engine.updateLocation(fix).contains(#""routeStatus":"rerouting""#) else { continue }
      let config = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config"]))
      _ = engine.clearRoute()
      let cancelled = expectation(description: "cancelled")
      Task {
        await engine.engine.waitForPendingReroute()
        cancelled.fulfill()
      }
      wait(for: [cancelled], timeout: 30)
      XCTAssertEqual(host.cancelledRequests, [config.id])
      return
    }
    XCTFail("the trace never left the route")
  }

  func testRequestAndResponseJSON() throws {
    let request = NavOSSHTTPRequest(
      method: "POST", url: URL(string: "https://navoss.test/v2/routes")!,
      headers: ["content-type": "application/json"], body: Data(#"{"a":"é"}"#.utf8), timeout: 20)
    XCTAssertEqual(
      try object(NavOSSCoreHTTP.requestJSON(request)) as NSDictionary,
      [
        "method": "POST", "url": "https://navoss.test/v2/routes",
        "headers": ["content-type": "application/json"], "body": #"{"a":"é"}"#,
        "timeoutMs": 20_000,
      ] as NSDictionary)
    XCTAssertEqual(
      try NavOSSCoreHTTP.response(#"{"status":404,"body":"x"}"#).get(),
      NavOSSHTTPResponse(statusCode: 404, body: Data("x".utf8)))
    for unreachable in [#"{"error":"timeout"}"#, #"{"error":"unreachable"}"#, "[]", ""] {
      XCTAssertThrowsError(try NavOSSCoreHTTP.response(unreachable).get()) {
        XCTAssertTrue(NavOSSNavigationAPIClient.isUnreachable($0), unreachable)
      }
    }
    XCTAssertThrowsError(try NavOSSCoreHTTP.response(#"{"error":"cancelled"}"#).get()) {
      XCTAssertTrue($0 is CancellationError)
    }
  }

  // MARK: Errors

  func testFailuresAreErrorValuesWithStableCodes() throws {
    let host = RecordingCoreHost()
    func code(_ body: () throws -> Any) -> String? {
      do {
        _ = try body()
        return nil
      } catch let error as NavOSSCoreError {
        return error.code
      } catch {
        return "unexpected \(error)"
      }
    }
    XCTAssertEqual(code { try NavOSSCoreEngine(configJSON: "{", host: host) }, "invalid-json")
    XCTAssertEqual(code { try NavOSSCoreEngine(configJSON: "{}", host: host) }, "invalid-json")
    XCTAssertEqual(
      code { try NavOSSCoreEngine(configJSON: #"{"apiBaseUrl":"not a url"}"#, host: host) },
      "invalid-argument")
    XCTAssertEqual(
      code {
        try NavOSSCoreEngine(
          configJSON: #"{"apiBaseUrl":"https://x","audioMode":"loud"}"#, host: host)
      }, "invalid-argument")

    let engine = try makeEngine(host)
    defer { engine.close() }
    let fix = #"{"latitude":51,"longitude":-114,"timestampMs":1800000000000}"#
    XCTAssertEqual(code { try engine.updateLocation(fix) }, "no-active-trip")
    XCTAssertEqual(code { try engine.setRoute("[]") }, "invalid-json")
    XCTAssertEqual(code { try engine.setRoute("{}") }, "invalid-route")
    XCTAssertEqual(code { try engine.setRoute(#"{"speedLimitsKph":[50.5]}"#) }, "invalid-json")
    XCTAssertEqual(code { try engine.setRoute(#"{"id":7}"#) }, "invalid-json")
    XCTAssertEqual(code { try engine.setRerouteMode("sometimes") }, "invalid-argument")
    _ = try engine.setRoute(try calgaryTripJSON())
    XCTAssertEqual(code { try engine.updateLocation("garbage") }, "invalid-json")
    XCTAssertEqual(
      code { try engine.updateLocation(#"{"latitude":51,"longitude":-114}"#) }, "invalid-location")
    XCTAssertEqual(
      code { try engine.updateLocation(#"{"latitude":951,"longitude":-114,"timestampMs":1}"#) },
      "invalid-location")
  }

  func testNoCallbackAfterClose() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    _ = try engine.setRoute(try calgaryTripJSON())
    engine.close()
    host.events.removeAll()
    _ = engine.clearRoute()
    XCTAssertEqual(host.events, [])
  }
}

extension NavOSSCarPlayTrip {
  fileprivate func replacingDestination(_ destination: NavOSSCarPlayDestination)
    -> NavOSSCarPlayTrip
  {
    NavOSSCarPlayTrip(
      destination: destination, distanceMeters: distanceMeters, durationSeconds: durationSeconds,
      geometry: geometry, id: id, preferences: preferences, source: source,
      speedLimitsKph: speedLimitsKph, steps: steps, traffic: traffic, waypoints: waypoints,
      congestion: congestion, trafficSource: trafficSource)
  }
}
