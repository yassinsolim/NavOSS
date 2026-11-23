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
    // The detour is answered with the recorded route: the route already followed, so nothing is
    // installed (`navigationIsMateriallySameRoute`) and the spacing asks for nothing more
    // while the vehicle runs beside the route (`NavigationRerouteSpacing`).
    let reroutes = transcript.filter { $0.hasPrefix("reroute ") }
    XCTAssertEqual(reroutes.count, 1)
    XCTAssertTrue(reroutes.last?.contains(#""rerouteCount":0"#) == true)
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
      // The recorded route moved about 200 m west: a different route. The recorded route itself
      // is the route followed, which is not offered again (`navigationIsMateriallySameRoute`).
      engine.completeHTTPRequest(
        id: routes.id, responseJSON: okResponse(try shiftedRecordedRoute(longitudeDegrees: -0.003)))
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

  /// The recorded Calgary response with every coordinate moved `longitudeDegrees` east.
  private func shiftedRecordedRoute(longitudeDegrees: Double) throws -> String {
    var response = try object(try recordedBody(calgaryRoute))
    func shifted(_ geometry: Any?) -> [[Double]]? {
      (geometry as? [[Double]])?.map { [$0[0] + longitudeDegrees, $0[1]] }
    }
    let routes = try XCTUnwrap(response["routes"] as? [[String: Any]]).map { route in
      var route = route
      route["geometry"] = shifted(route["geometry"])
      route["steps"] = (route["steps"] as? [[String: Any]])?.map { step in
        var step = step
        step["geometry"] = shifted(step["geometry"])
        return step
      }
      return route
    }
    response["routes"] = routes
    return String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self)
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

    // A first fix further from the route than any drive since the checkpoint (about 25 km,
    // seconds later) ends the restored trip and says why.
    host.setNow(host.nowMs() + 5_000)
    let tooFar = #"{"latitude":51.2,"longitude":-113.7,"horizontalAccuracyMeters":5,"timestampMs":\#(host.nowMs())}"#
    let ended = try object(try restored.updateLocation(tooFar))
    XCTAssertEqual(ended["tripEndReason"] as? String, "restored-trip-too-far")
    try assertGolden("restored-too-far.json", restored)
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
        await engine.engine.pendingRerouteTask?.value
        cancelled.fulfill()
      }
      wait(for: [cancelled], timeout: 30)
      XCTAssertEqual(host.waitForCancelled(1), [config.id])
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
    XCTAssertEqual(code { try engine.setRoute(#"{"speedLimitsKph":50}"#) }, "invalid-json")
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

// MARK: - Review findings (PR #159)

/// Interleavings are forced through hooks (the host's callbacks, `willPublish`,
/// `closeWillWait`), never by sleeping: a wait with a deadline only ends a failing run.
final class NavOSSCoreBoundaryRaceTests: XCTestCase {
  private func makeEngine(_ host: RecordingCoreHost) throws -> NavOSSCoreEngine {
    try NavOSSCoreEngine(configJSON: #"{"apiBaseUrl":"https://navoss.test"}"#, host: host)
  }

  private func fixes() throws -> [[String: Any]] {
    let trace = try bundled("Fixtures", "calgary-deerfoot-glenmore.trace.json")
    let object = try JSONSerialization.jsonObject(with: Data(trace.utf8)) as? [String: Any]
    return try XCTUnwrap(object?["fixes"] as? [[String: Any]])
  }

  private func json(_ object: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }

  /// Starts the Calgary trip, takes the camera request out of the way (`afterStart` runs then)
  /// and drives the trace until a fix starts a reroute. Returns that fix.
  @discardableResult
  private func driveUntilRerouting(
    _ engine: NavOSSCoreEngine, _ host: RecordingCoreHost, afterStart: () -> Void = {}
  ) throws -> [String: Any] {
    _ = try engine.setRoute(try calgaryTripJSON())
    _ = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v1/cameras"]))
    afterStart()
    for fix in try fixes() {
      host.setNow(try XCTUnwrap(fix["timestampMs"] as? Double))
      if try engine.updateLocation(try json(fix)).contains(#""routeStatus":"rerouting""#) {
        return fix
      }
    }
    throw XCTSkip("the trace never left the route")
  }

  /// Runs `body` on another thread and says whether it finished within ten seconds.
  private func finishesOnAnotherThread(_ body: @escaping @Sendable () -> Void) -> Bool {
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
      body()
      done.signal()
    }
    return done.wait(timeout: .now() + 10) == .success
  }

  // Finding 3: a reroute is cancelled with the engine lock held, and Swift runs cancellation
  // handlers synchronously. The host must be told once the lock is free: here it waits, as a
  // host may, for another thread's core call.
  func testTheHostIsToldOfACancelledRequestWithTheEngineLockFree() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    try driveUntilRerouting(engine, host)
    let config = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config"]))
    let otherThreadFinished = LockedBox<Bool?>(nil)
    host.onCancelHTTPRequest = { [unowned self] _ in
      otherThreadFinished.set(self.finishesOnAnotherThread { _ = engine.snapshot() })
    }
    _ = engine.clearRoute()
    XCTAssertEqual(host.waitForCancelled(1), [config.id])
    XCTAssertEqual(
      otherThreadFinished.get(), true,
      "cancelHttpRequest was called with the engine lock held: another thread's call blocked")
  }

  // Finding 5: closing cancels what the host still holds, before the host is let go.
  func testCloseCancelsTheRequestsTheHostHolds() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    _ = try engine.setRoute(try calgaryTripJSON())
    let cameras = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v1/cameras"]))
    engine.close()
    XCTAssertEqual(host.cancelledRequests, [cameras.id])
    // Its late answer is ignored, and nothing follows.
    host.events.removeAll()
    engine.completeHTTPRequest(id: cameras.id, responseJSON: okResponse("[]"))
    _ = engine.clearRoute()
    XCTAssertEqual(host.events, [])
    XCTAssertEqual(host.cancelledRequests, [cameras.id])
  }

  // Finding 6: a request cancelled between its registration and the host call is not sent
  // (and so not cancelled at the host either).
  func testARequestCancelledBeforeTheHostSeesItIsNeverPublished() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let settled = DispatchSemaphore(value: 0)
    // The reroute's request waits here until the fix that asked for it has returned.
    let fixReturned = DispatchSemaphore(value: 0)
    try driveUntilRerouting(engine, host) {
      engine.httpForTesting.willPublish = { _ in
        fixReturned.wait()
        _ = engine.clearRoute()
      }
      engine.httpForTesting.didPublish = { _ in settled.signal() }
    }
    fixReturned.signal()
    XCTAssertEqual(settled.wait(timeout: .now() + 30), .success)
    XCTAssertEqual(host.condition.withLock { host.httpLog.filter { !$0.hasSuffix(" 1") } }, [])
  }

  // Finding 6: a request cancelled while the host is being given it is cancelled at the host
  // after `httpRequest` returned, never before or during.
  func testACancelDuringPublicationReachesTheHostAfterTheRequest() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let settled = DispatchSemaphore(value: 0)
    let fixReturned = DispatchSemaphore(value: 0)
    try driveUntilRerouting(engine, host) {
      host.onHTTPRequest = { _, _ in
        fixReturned.wait()
        _ = engine.clearRoute()
      }
      engine.httpForTesting.didPublish = { _ in settled.signal() }
    }
    fixReturned.signal()
    XCTAssertEqual(settled.wait(timeout: .now() + 30), .success)
    XCTAssertEqual(
      host.condition.withLock { host.httpLog.filter { !$0.hasSuffix(" 1") } },
      ["request-begin 2", "request-end 2", "cancel 2"])
    // The host answering a request it was told to cancel changes nothing.
    engine.completeHTTPRequest(id: 2, responseJSON: okResponse("{}"))
  }

  // Finding 4: `close()` returns only once a callback already running has returned, and no
  // callback starts after it.
  func testCloseWaitsForARunningCallbackAndNoneFollows() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    let closeReturned = LockedBox(false)
    let closeReturnedDuringCallback = LockedBox<Bool?>(nil)
    let closerMoved = DispatchSemaphore(value: 0)
    let closerDone = DispatchSemaphore(value: 0)
    engine.bridgeForTesting.closeWillWait = { closerMoved.signal() }
    host.onStateChanged = {
      guard closeReturnedDuringCallback.get() == nil else { return }
      Thread.detachNewThread {
        engine.close()
        closeReturned.set(true)
        closerMoved.signal()
        closerDone.signal()
      }
      // Until `close()` on the other thread has either returned or begun to wait for us.
      _ = closerMoved.wait(timeout: .now() + 30)
      closeReturnedDuringCallback.set(closeReturned.get())
    }
    _ = try engine.setRoute(try calgaryTripJSON())
    XCTAssertEqual(closerDone.wait(timeout: .now() + 30), .success)
    XCTAssertEqual(
      closeReturnedDuringCallback.get(), false, "close() returned while a callback was running")
    XCTAssertEqual(host.events, ["cancelSpeech", "stateChanged"], "a callback started after close")
    XCTAssertEqual(host.requests.count, 0)
  }

  // Findings 1 and 4, re-entrant case: `close()` from inside a callback returns at once (it
  // cannot wait for its own caller) and no further callback starts.
  func testCloseFromInsideACallbackReturnsAndStopsCallbacks() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    host.onStateChanged = { engine.close() }
    _ = try engine.setRoute(try calgaryTripJSON())
    XCTAssertEqual(host.events, ["cancelSpeech", "stateChanged"])
    _ = engine.clearRoute()
    XCTAssertEqual(host.events, ["cancelSpeech", "stateChanged"])
    XCTAssertEqual(host.requests.count, 0)
  }

  // Finding 8: the reroute-mode and speeding setters each change part of one record. A
  // change that lands while the other setter is between its start and its write (here made
  // at exactly that point) must survive it.
  func testAPreferenceSetterKeepsAChangeMadeMeanwhile() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    engine.preferencesWillChange = {
      engine.preferencesWillChange = nil
      engine.setSpeedingWarning(toleranceKph: 12, audible: true)
    }
    try engine.setRerouteMode("ask-first")
    var preferences = engine.engine.currentNavigationPreferences()
    XCTAssertEqual(preferences.rerouteMode, .askFirst)
    XCTAssertEqual(preferences.speedingToleranceKph, 12)
    XCTAssertEqual(preferences.speedingAudibleWarning, true)

    engine.preferencesWillChange = {
      engine.preferencesWillChange = nil
      try? engine.setRerouteMode("keep-route")
    }
    engine.setSpeedingWarning(toleranceKph: 3, audible: false)
    preferences = engine.engine.currentNavigationPreferences()
    XCTAssertEqual(preferences.rerouteMode, .keepRoute)
    XCTAssertEqual(preferences.speedingToleranceKph, 3)
    XCTAssertEqual(preferences.speedingAudibleWarning, false)
  }

  // Finding 9: a fix the matcher ignores (older than the last one) must not lend its course
  // and accuracy to a reroute from the accepted position.
  func testALateFixDoesNotChangeTheRerouteOrigin() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let accepted = try driveUntilRerouting(engine, host)
    let acceptedAt = try XCTUnwrap(accepted["timestampMs"] as? Double)
    /// `origin`, `originHeadingDegrees` and `originHorizontalAccuracyMeters` of the request.
    func originOfNextRoutesRequest() throws -> [Double?] {
      // The config is asked for once per engine, then the routes.
      var routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config", "/v2/routes"]))
      if requestURL(routes.json)?.hasSuffix("/v2/config") == true {
        engine.completeHTTPRequest(
          id: routes.id, responseJSON: okResponse(try recordedBody(productionConfig)))
        routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/routes"]))
      }
      engine.completeHTTPRequest(id: routes.id, responseJSON: #"{"error":"unreachable"}"#)
      let request = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: Data(routes.json.utf8)) as? [String: Any])
      let body = try XCTUnwrap(request["body"] as? String)
      let payload = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
      let origin = try XCTUnwrap(payload["origin"] as? [String: Double])
      return [
        origin["latitude"], origin["longitude"], payload["originHeadingDegrees"] as? Double,
        payload["originHorizontalAccuracyMeters"] as? Double,
      ]
    }
    let first = try originOfNextRoutesRequest()
    XCTAssertEqual(
      first,
      [
        accepted["latitude"] as? Double, accepted["longitude"] as? Double,
        accepted["courseDegrees"] as? Double, accepted["horizontalAccuracyMeters"] as? Double,
      ])
    XCTAssertEqual(
      try XCTUnwrap(host.waitUntilNotRerouting()).contains(#""routeStatus":"reroute-failed""#),
      true)

    // Eleven seconds on (the retry is due), a fix captured before the accepted one arrives,
    // elsewhere and with its own course and accuracy.
    host.setNow(acceptedAt + 11_000)
    var late = accepted
    late["timestampMs"] = acceptedAt - 1_000
    late["latitude"] = try XCTUnwrap(accepted["latitude"] as? Double) + 0.0005
    late["courseDegrees"] = 123.0
    late["horizontalAccuracyMeters"] = 42.0
    XCTAssertTrue(
      try engine.updateLocation(try json(late)).contains(#""routeStatus":"rerouting""#),
      "the late fix did not start the retry this test needs")
    let retry = try originOfNextRoutesRequest()
    XCTAssertEqual(retry, first)
  }

  // Delta review 1: callbacks of two engines closing each other. Each close runs inside a
  // callback (of the other engine), so neither may wait for callbacks.
  func testTwoEnginesClosingEachOtherFromCallbacksDoNotDeadlock() throws {
    let hostA = RecordingCoreHost()
    let hostB = RecordingCoreHost()
    let engineA = try makeEngine(hostA)
    let engineB = try makeEngine(hostB)
    let trip = try calgaryTripJSON()
    // Both callbacks are running before either closes.
    let inA = DispatchSemaphore(value: 0)
    let inB = DispatchSemaphore(value: 0)
    hostA.onStateChanged = {
      inA.signal()
      _ = inB.wait(timeout: .now() + 30)
      engineB.close()
    }
    hostB.onStateChanged = {
      inB.signal()
      _ = inA.wait(timeout: .now() + 30)
      engineA.close()
    }
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
      _ = try? engineA.setRoute(trip)
      done.signal()
    }
    Thread.detachNewThread {
      _ = try? engineB.setRoute(trip)
      done.signal()
    }
    XCTAssertEqual(done.wait(timeout: .now() + 10), .success, "the closes wait for each other")
    XCTAssertEqual(done.wait(timeout: .now() + 10), .success, "the closes wait for each other")
  }

  // Delta review 2: a cancellation the flusher has claimed is still delivered when `close()`
  // runs at that moment: close waits for it instead of revoking the host under it.
  func testACancellationBeingFlushedSurvivesAConcurrentClose() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    try driveUntilRerouting(engine, host)
    let config = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config"]))
    let closerMoved = DispatchSemaphore(value: 0)
    let closed = DispatchSemaphore(value: 0)
    engine.bridgeForTesting.closeWillWait = { closerMoved.signal() }
    engine.httpForTesting.didClaimCancellations = {
      engine.httpForTesting.didClaimCancellations = nil
      Thread.detachNewThread {
        engine.close()
        closerMoved.signal()
        closed.signal()
      }
      // Until `close()` has either returned or begun to wait for this delivery.
      _ = closerMoved.wait(timeout: .now() + 30)
    }
    _ = engine.clearRoute()
    XCTAssertEqual(closed.wait(timeout: .now() + 30), .success)
    XCTAssertEqual(
      host.condition.withLock { host.cancelledRequests.filter { $0 == config.id } }, [config.id],
      "the host was never told to cancel a request it holds")
  }

  // Delta review 3: a fix the core refuses (here a negative speed) at the accepted fix's
  // coordinate, newer and with another accuracy, must not become the reroute origin.
  func testARefusedFixDoesNotChangeTheRerouteOrigin() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let accepted = try driveUntilRerouting(engine, host)
    let acceptedAt = try XCTUnwrap(accepted["timestampMs"] as? Double)
    func originOfNextRoutesRequest() throws -> [Double?] {
      var routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config", "/v2/routes"]))
      if requestURL(routes.json)?.hasSuffix("/v2/config") == true {
        engine.completeHTTPRequest(
          id: routes.id, responseJSON: okResponse(try recordedBody(productionConfig)))
        routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/routes"]))
      }
      engine.completeHTTPRequest(id: routes.id, responseJSON: #"{"error":"unreachable"}"#)
      let request = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: Data(routes.json.utf8)) as? [String: Any])
      let payload = try XCTUnwrap(
        try JSONSerialization.jsonObject(
          with: Data(try XCTUnwrap(request["body"] as? String).utf8)) as? [String: Any])
      return [
        payload["originHeadingDegrees"] as? Double,
        payload["originHorizontalAccuracyMeters"] as? Double,
      ]
    }
    let first = try originOfNextRoutesRequest()
    XCTAssertEqual(
      first,
      [accepted["courseDegrees"] as? Double, accepted["horizontalAccuracyMeters"] as? Double])
    XCTAssertNotNil(host.waitUntilNotRerouting())

    var refused = accepted
    refused["timestampMs"] = acceptedAt + 1_000
    refused["speedMetersPerSecond"] = -1.0
    refused["horizontalAccuracyMeters"] = 42.0
    XCTAssertThrowsError(try engine.updateLocation(try json(refused))) {
      XCTAssertEqual(($0 as? NavOSSCoreError)?.code, "invalid-location")
    }

    // Eleven seconds on, the accepted fix delivered again starts the retry.
    host.setNow(acceptedAt + 11_000)
    XCTAssertTrue(
      try engine.updateLocation(try json(accepted)).contains(#""routeStatus":"rerouting""#),
      "the repeated fix did not start the retry this test needs")
    XCTAssertEqual(try originOfNextRoutesRequest(), first)
  }

  // MARK: The reroute origin's fix. The matcher says which fix it applied; these pin that
  // nothing else can become the origin, whatever the interleaving.

  /// The fix the matcher holds for the reroute origin, as `[latitude, longitude, course,
  /// accuracy, timestamp]`.
  private func appliedFix(_ engine: NavOSSCoreEngine) -> [Double?]? {
    engine.engine.lock.withLock {
      engine.engine.lastAppliedFixLocked.map {
        [
          $0.coordinate.latitude, $0.coordinate.longitude, $0.courseDegrees,
          $0.horizontalAccuracyMeters,
          $0.timestamp.map { Date(timeIntervalSinceReferenceDate: $0).timeIntervalSince1970 * 1_000 },
        ]
      }
    }
  }

  private func values(_ fix: [String: Any]) -> [Double?] {
    ["latitude", "longitude", "courseDegrees", "horizontalAccuracyMeters", "timestampMs"].map {
      fix[$0] as? Double
    }
  }

  /// Heading and accuracy of the next `/v2/routes` request, which is then failed.
  private func failNextRoutesRequest(_ engine: NavOSSCoreEngine, _ host: RecordingCoreHost) throws
    -> [Double?]
  {
    var routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/config", "/v2/routes"]))
    if requestURL(routes.json)?.hasSuffix("/v2/config") == true {
      engine.completeHTTPRequest(
        id: routes.id, responseJSON: okResponse(try recordedBody(productionConfig)))
      routes = try XCTUnwrap(host.takeRequest(endingWithAny: ["/v2/routes"]))
    }
    engine.completeHTTPRequest(id: routes.id, responseJSON: #"{"error":"unreachable"}"#)
    let request = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: Data(routes.json.utf8)) as? [String: Any])
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(
        with: Data(try XCTUnwrap(request["body"] as? String).utf8)) as? [String: Any])
    XCTAssertNotNil(host.waitUntilNotRerouting())
    return [
      payload["originHeadingDegrees"] as? Double,
      payload["originHorizontalAccuracyMeters"] as? Double,
    ]
  }

  // Review at 48f34c0, 1: B's newer fix and A's older one cross. A enters after B and is
  // given to the engine after B's was applied, so the matcher ignores A. The origin stays B's.
  func testAnOlderFixCrossingANewerOneNeverBecomesTheOrigin() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let first = try driveUntilRerouting(engine, host)
    let firstAt = try XCTUnwrap(first["timestampMs"] as? Double)
    _ = try failNextRoutesRequest(engine, host)

    var newer = first
    newer["timestampMs"] = firstAt + 2_000
    newer["courseDegrees"] = 200.0
    newer["horizontalAccuracyMeters"] = 8.0
    var older = newer
    older["timestampMs"] = firstAt + 1_000
    older["courseDegrees"] = 123.0
    older["horizontalAccuracyMeters"] = 42.0
    let newerJSON = try json(newer)
    let olderJSON = try json(older)

    let olderEntered = DispatchSemaphore(value: 0)
    let newerReturned = DispatchSemaphore(value: 0)
    let olderReturned = DispatchSemaphore(value: 0)
    engine.fixWillIngest = { sample in
      if sample.courseDegrees == 200 {
        // B is decoded; A starts on another thread and is held just before the engine.
        Thread.detachNewThread {
          _ = try? engine.updateLocation(olderJSON)
          olderReturned.signal()
        }
        _ = olderEntered.wait(timeout: .now() + 30)
      } else {
        olderEntered.signal()
        _ = newerReturned.wait(timeout: .now() + 30)
      }
    }
    host.setNow(firstAt + 2_000)
    _ = try engine.updateLocation(newerJSON)
    newerReturned.signal()
    XCTAssertEqual(olderReturned.wait(timeout: .now() + 30), .success)
    engine.fixWillIngest = nil
    XCTAssertEqual(appliedFix(engine), values(newer))

    // The retry, started by B delivered again, carries B's heading and accuracy.
    host.setNow(firstAt + 11_000)
    XCTAssertTrue(try engine.updateLocation(newerJSON).contains(#""routeStatus":"rerouting""#))
    XCTAssertEqual(try failNextRoutesRequest(engine, host), [200, 8])
  }

  // Review at 48f34c0, 2: a fix applied on another thread while `setRoute` is still making
  // its callbacks belongs to the new trip and is kept when `setRoute` returns; a repeat of it
  // changes nothing.
  func testAFixAppliedDuringRouteStartIsKept() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let fix = try XCTUnwrap(try fixes().first)
    let fixJSON = try json(fix)
    host.setNow(try XCTUnwrap(fix["timestampMs"] as? Double))
    let started = LockedBox(false)
    let applied = LockedBox(false)
    host.onStateChanged = { [unowned self] in
      // Once: the fix's own state change comes through here too.
      guard !started.get() else { return }
      started.set(true)
      applied.set(self.finishesOnAnotherThread { _ = try? engine.updateLocation(fixJSON) })
    }
    _ = try engine.setRoute(try calgaryTripJSON())
    XCTAssertTrue(applied.get())
    XCTAssertEqual(appliedFix(engine), values(fix))
    _ = try engine.updateLocation(fixJSON)
    XCTAssertEqual(appliedFix(engine), values(fix))
  }

  // A refused fix, a repeated one and an older one are never the matcher's applied fix, and
  // a trip's fix is gone the moment another trip starts or the route is cleared.
  func testOnlyAnAppliedFixOfTheCurrentTripIsKept() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    XCTAssertNil(appliedFix(engine))
    let accepted = try driveUntilRerouting(engine, host)
    let acceptedAt = try XCTUnwrap(accepted["timestampMs"] as? Double)
    XCTAssertEqual(appliedFix(engine), values(accepted))

    var refused = accepted
    refused["timestampMs"] = acceptedAt + 1_000
    refused["speedMetersPerSecond"] = -1.0
    refused["horizontalAccuracyMeters"] = 42.0
    XCTAssertThrowsError(try engine.updateLocation(try json(refused)))
    XCTAssertEqual(appliedFix(engine), values(accepted), "a refused fix")

    var repeated = accepted
    repeated["horizontalAccuracyMeters"] = 43.0
    _ = try engine.updateLocation(try json(repeated))
    XCTAssertEqual(appliedFix(engine), values(accepted), "a repeated fix")

    var older = accepted
    older["timestampMs"] = acceptedAt - 1_000
    older["courseDegrees"] = 123.0
    _ = try engine.updateLocation(try json(older))
    XCTAssertEqual(appliedFix(engine), values(accepted), "an older fix")

    // Another trip: the old trip's fix is gone before any callback of the start runs.
    let seenInCallback = LockedBox<[[Double?]?]>([])
    host.onStateChanged = { [unowned self] in
      seenInCallback.set(seenInCallback.get() + [self.appliedFix(engine)])
    }
    _ = try engine.setRoute(try calgaryTripJSON())
    host.onStateChanged = nil
    XCTAssertEqual(seenInCallback.get().first, .some(nil), "the old trip's fix outlived it")
    XCTAssertNil(appliedFix(engine))

    let fix = try XCTUnwrap(try fixes().first)
    host.setNow(try XCTUnwrap(fix["timestampMs"] as? Double))
    _ = try engine.updateLocation(try json(fix))
    XCTAssertEqual(appliedFix(engine), values(fix))
    _ = engine.clearRoute()
    XCTAssertNil(appliedFix(engine))
  }

  // Finding 11: the boundary's own ceiling on what the host hands it.
  func testOversizedTextFromTheHostIsRefused() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    let oversized = String(repeating: " ", count: navOSSCoreMaximumJSONBytes + 1)
    XCTAssertThrowsError(try engine.setRoute(oversized)) {
      XCTAssertEqual(($0 as? NavOSSCoreError)?.code, "invalid-argument")
    }
    XCTAssertThrowsError(
      try NavOSSCoreHTTP.response(#"{"status":200,"body":""# + oversized + #""}"#).get()
    ) {
      guard case NavOSSNavigationAPIError.invalidResponse = $0 else {
        return XCTFail("an oversized answer must be an invalid response")
      }
    }
  }

  // Finding 10: what a failing call says names the field, never what was sent.
  func testErrorMessagesNameFieldsNotPayloads() throws {
    let host = RecordingCoreHost()
    let engine = try makeEngine(host)
    defer { engine.close() }
    func message(_ body: () throws -> Any) -> String {
      do {
        _ = try body()
        return "no error"
      } catch {
        return "\(error)"
      }
    }
    XCTAssertEqual(
      message { try engine.setRerouteMode("51.0447,-114.0719") },
      "invalid-argument: Unknown reroute mode")
    XCTAssertEqual(
      message { try engine.setAudioMode("51.0447,-114.0719") },
      "invalid-argument: Unknown audio mode")
    XCTAssertEqual(
      message { try engine.setRoute(#"{"destination":{"name":"Secret Place","latitude":"51.0447"}}"#) },
      "invalid-json: Wrong type at destination.latitude")
    XCTAssertEqual(
      message { try engine.setRoute(#"{"id":"Secret Place" 51.0447}"#) }, "invalid-json: Not JSON")
    XCTAssertEqual(
      message { try engine.updateLocation(#"{"latitude":51.0447,"longitude":"x"}"#) },
      "invalid-json: Wrong type at longitude")
    XCTAssertEqual(
      message { try engine.setRoute(#"{"id":"Secret Place"}"#) },
      "invalid-route: The trip failed validation")
  }
}

/// Finding 7: the trip and fix records against the cases of `Golden/record-rules.json`, each a
/// change to the recorded Calgary trip (or to a fix) and what must become of it.
final class NavOSSCoreRecordRuleTests: XCTestCase {
  private struct Case: Decodable {
    let name: String
    /// `trip` or `fix`.
    let record: String
    /// Keys and array indexes to the value replaced.
    let path: [PathElement]
    /// The JSON text put there.
    let value: String
    /// The error message, or `nil` when the record must be accepted.
    let error: String?
    /// Decoded values to find afterwards, by name (see `decoded`).
    let expect: [String: Double]?
  }

  private enum PathElement: Decodable {
    case key(String)
    case index(Int)

    init(from decoder: Decoder) throws {
      let container = try decoder.singleValueContainer()
      if let index = try? container.decode(Int.self) {
        self = .index(index)
      } else {
        self = .key(try container.decode(String.self))
      }
    }
  }

  private func replacing(_ node: Any, _ path: ArraySlice<PathElement>, with value: Any) throws -> Any {
    guard let head = path.first else { return value }
    switch head {
    case .key(let key):
      var object = try XCTUnwrap(node as? [String: Any])
      object[key] = try replacing(object[key] ?? [String: Any](), path.dropFirst(), with: value)
      return object
    case .index(let index):
      var array = try XCTUnwrap(node as? [Any])
      array[index] = try replacing(array[index], path.dropFirst(), with: value)
      return array
    }
  }

  func testRecordsFollowTheGoldenRules() throws {
    let cases = try JSONDecoder().decode(
      [Case].self, from: Data(try bundled("Golden", "record-rules.json").utf8))
    XCTAssertGreaterThan(cases.count, 40)
    let trip = try JSONSerialization.jsonObject(with: Data(try calgaryTripJSON().utf8))
    let fix: [String: Any] = [
      "latitude": 51.0, "longitude": -114.0, "timestampMs": 1_800_000_000_000.0,
      "courseDegrees": 90.0, "horizontalAccuracyMeters": 5.0, "speedMetersPerSecond": 10.0,
    ]
    for item in cases {
      let value = try JSONSerialization.jsonObject(
        with: Data(item.value.utf8), options: [.fragmentsAllowed])
      let changed = try replacing(item.record == "trip" ? trip : fix, item.path[...], with: value)
      let data = try JSONSerialization.data(withJSONObject: changed)
      var decoded: [String: Double] = [:]
      var failure: String?
      do {
        if item.record == "trip" {
          let trip = try JSONDecoder().decode(NavOSSCoreTripRecord.self, from: data).trip
          decoded = [
            "roundaboutExit": Double(trip.steps[0].roundaboutExit ?? -1),
            "speedLimit": Double(trip.speedLimitsKph?.first ?? -1),
            "waypoints": Double(trip.waypoints?.count ?? 0),
            "lanes": Double(trip.steps[0].lanes?.count ?? 0),
            "valid": trip.isValid ? 1 : 0,
          ]
        } else {
          let sample = try JSONDecoder().decode(NavOSSCoreLocationRecord.self, from: data).sample
          decoded = ["hasCourse": sample.courseDegrees == nil ? 0 : 1]
        }
      } catch {
        failure = NavOSSCoreError.invalidJSON(error).message
      }
      XCTAssertEqual(failure, item.error, item.name)
      for (key, want) in item.expect ?? [:] {
        XCTAssertEqual(decoded[key], want, "\(item.name): \(key)")
      }
    }
  }
}

/// A value shared between a test and the threads it starts.
final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) {
    self.value = value
  }

  func get() -> Value {
    lock.withLock { value }
  }

  func set(_ newValue: Value) {
    lock.withLock { value = newValue }
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
