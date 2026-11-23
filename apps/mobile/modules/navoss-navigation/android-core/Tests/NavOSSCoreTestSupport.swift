import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Repository fixtures, located from this file (the Android test script rewrites the root to
/// the mirrored device path).
let facadeTestsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let repositoryRoot = facadeTestsDirectory.appendingPathComponent("../../../../../..").standardized

func repositoryFixture(_ path: String) throws -> Data {
  try Data(contentsOf: repositoryRoot.appendingPathComponent(path))
}

/// A file from the bundled `Fixtures` or `Golden` resources.
func bundled(_ directory: String, _ name: String) throws -> String {
  let url = try XCTUnwrap(
    Bundle.module.url(forResource: name, withExtension: nil, subdirectory: directory),
    "missing \(directory)/\(name)")
  return try String(contentsOf: url, encoding: .utf8)
}

/// Writes a regenerated fixture into the source tree (`NAVOSS_REGENERATE_GOLDEN=1`).
var regeneratesGolden: Bool {
  ProcessInfo.processInfo.environment["NAVOSS_REGENERATE_GOLDEN"] == "1"
}

func writeSource(_ directory: String, _ name: String, _ contents: String) throws {
  try contents.write(
    to: facadeTestsDirectory.appendingPathComponent(directory).appendingPathComponent(name),
    atomically: true, encoding: .utf8)
}

/// The server's answer of a recorded fixture (`response`), as the body the host would receive.
func recordedBody(_ path: String) throws -> String {
  let object = try JSONSerialization.jsonObject(with: try repositoryFixture(path)) as? [String: Any]
  let response = try XCTUnwrap(object?["response"])
  return String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self)
}

/// JSON re-encoded with sorted keys by one encoder, so two writers' output compares as text.
/// Parsed with `JSONDecoder` (exact binary doubles; `JSONSerialization` may read long numbers as
/// decimals), integral numbers read as integers.
func canonicalJSON(_ text: String) throws -> String {
  let value = try JSONDecoder().decode(CanonicalJSON.self, from: Data(text.utf8))
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
  return String(decoding: try encoder.encode(value), as: UTF8.self)
}

func canonicalJSON(object: Any) -> String {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
  return try! canonicalJSON(String(decoding: data, as: UTF8.self))
}

private enum CanonicalJSON: Codable {
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([CanonicalJSON])
  case object([String: CanonicalJSON])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Int.self) {
      self = .int(value)
    } else if let value = try? container.decode(Double.self) {
      self = value.rounded() == value && abs(value) < 1e15 ? .int(Int(value)) : .double(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([CanonicalJSON].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: CanonicalJSON].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .int(let value): try container.encode(value)
    case .double(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

/// The recorded Calgary route as the JS trip record the Android module passes to `setRoute`.
func calgaryTripJSON() throws -> String {
  try bundled("Fixtures", "calgary-deerfoot-glenmore.trip.json")
}

let calgaryRoute = "apps/mobile/test/fixtures/routes-v2/calgary-deerfoot-glenmore.v2.json"
let productionConfig = "apps/mobile/test/fixtures/server-config/new-server.v2-config.json"
let productionCameras = "apps/mobile/test/fixtures/server-config/production-2026-11.cameras.json"

/// Records every callback; HTTP requests wait in `requests` until the test answers them.
final class RecordingCoreHost: NavOSSCoreHost, @unchecked Sendable {
  let condition = NSCondition()
  var currentMs: Double = 1_800_000_000_000
  var storage: [String: String] = [:]
  var requests: [(id: Int64, json: String)] = []
  var cancelledRequests: [Int64] = []
  var events: [String] = []
  var spoken: [String] = []
  var lastSnapshot = ""
  /// `request-begin <id>`, `request-end <id>` and `cancel <id>`, in the order the host saw them.
  var httpLog: [String] = []
  /// Interleaving hooks, run inside the callback with no test lock held.
  var onStateChanged: (() -> Void)?
  var onHTTPRequest: ((Int64, String) -> Void)?
  var onCancelHTTPRequest: ((Int64) -> Void)?

  func stateChanged(_ snapshotJSON: String) {
    let hook = condition.withLock {
      lastSnapshot = snapshotJSON
      events.append("stateChanged")
      condition.broadcast()
      return onStateChanged
    }
    hook?()
  }

  func speak(text: String, kind: String, generation: UInt64) {
    condition.withLock {
      spoken.append("speak \(kind) \(text)")
      events.append("speak")
    }
  }

  func cancelSpeech(generation: UInt64) {
    condition.withLock { events.append("cancelSpeech") }
  }

  func needsLocationUpdates() {
    condition.withLock { events.append("needsLocationUpdates") }
  }

  func reconcileLocationUpdates(generation: UInt64, shouldTrack: Bool) {
    condition.withLock { events.append("reconcileLocationUpdates \(shouldTrack)") }
  }

  func startClock(generation: UInt64) {
    condition.withLock { events.append("startClock") }
  }

  func stopClock(generation: UInt64) {
    condition.withLock { events.append("stopClock") }
  }

  func httpRequest(id: Int64, json: String) {
    let hook = condition.withLock {
      httpLog.append("request-begin \(id)")
      requests.append((id, json))
      condition.broadcast()
      return onHTTPRequest
    }
    hook?(id, json)
    condition.withLock { httpLog.append("request-end \(id)") }
  }

  func cancelHTTPRequest(id: Int64) {
    let hook = condition.withLock {
      httpLog.append("cancel \(id)")
      return onCancelHTTPRequest
    }
    hook?(id)
    condition.withLock {
      cancelledRequests.append(id)
      condition.broadcast()
    }
  }

  /// Waits up to 30 s for the host to have been told of `count` cancelled requests.
  func waitForCancelled(_ count: Int) -> [Int64]? {
    condition.withLock {
      let deadline = Date().addingTimeInterval(30)
      while cancelledRequests.count < count {
        if !condition.wait(until: deadline) { return nil }
      }
      return cancelledRequests
    }
  }

  func storageRead(key: String) -> String? {
    condition.withLock { storage[key] }
  }

  func storageWrite(key: String, value: String?) {
    condition.withLock { storage[key] = value }
  }

  func nowMs() -> Double {
    condition.withLock { currentMs }
  }

  func setNow(_ ms: Double) {
    condition.withLock { currentMs = ms }
  }

  /// Takes the spoken lines collected so far.
  func drainSpoken() -> [String] {
    condition.withLock {
      defer { spoken.removeAll() }
      return spoken
    }
  }

  /// Waits up to 30 s for an unanswered request whose URL ends with one of `suffixes`.
  func takeRequest(endingWithAny suffixes: [String]) -> (id: Int64, json: String)? {
    condition.withLock {
      let deadline = Date().addingTimeInterval(30)
      while true {
        if let index = requests.firstIndex(where: { request in
          suffixes.contains { requestURL(request.json)?.hasSuffix($0) == true }
        }) {
          return requests.remove(at: index)
        }
        if !condition.wait(until: deadline) {
          // Never the requests themselves: they carry coordinates.
          print("no request among", requests.count, "cancelled", cancelledRequests.count, "events", events.suffix(8))
          return nil
        }
      }
    }
  }

  /// Waits up to 30 s for a published snapshot that is not `rerouting`.
  func waitUntilNotRerouting() -> String? {
    condition.withLock {
      let deadline = Date().addingTimeInterval(30)
      while lastSnapshot.contains(#""routeStatus":"rerouting""#) {
        if !condition.wait(until: deadline) { return nil }
      }
      return lastSnapshot
    }
  }
}

func requestURL(_ json: String) -> String? {
  (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])?["url"] as? String
}

func okResponse(_ body: String) -> String {
  String(
    decoding: try! JSONSerialization.data(withJSONObject: ["status": 200, "body": body]),
    as: UTF8.self)
}

/// The replay script shared with the Kotlin instrumented test (`NavOSSCoreTest`), which runs it
/// through JNI on Android and compares its transcript with the committed macOS one:
///
/// 1. Create with `{"apiBaseUrl": "https://navoss.test", "speedingAudibleWarning": true}`; the
///    host clock is the time of the latest fix (the first fix's before any).
/// 2. `setRoute(trip)`, then each fix in order: `updateLocation(fix)`.
/// 3. HTTP requests are held unanswered (the camera list never arrives) except while a returned
///    snapshot says `routeStatus: rerouting`: then no fix is sent, a request for `…/v2/config`
///    is answered with the config fixture and one for `…/v2/routes` with the recorded Calgary
///    response, each with status 200, and the replay waits for a state change that leaves
///    `rerouting`; `getSnapshot()` is then printed as `reroute`.
/// 4. `clearRoute()`.
///
/// Lines: `route|state|reroute|clear <snapshot>`, `speak <kind> <text>` before the line of the
/// call that caused it, and `request GET /v2/config` / `request POST /v2/routes`.
func runReplay(
  checkEachState: ((NavOSSCoreEngine) throws -> Void)? = nil
) throws -> [String] {
  let trip = try calgaryTripJSON()
  let traceText = try bundled("Fixtures", "calgary-deerfoot-glenmore.trace.json")
  let trace = try XCTUnwrap(
    try JSONSerialization.jsonObject(with: Data(traceText.utf8)) as? [String: Any])
  let fixes = try XCTUnwrap(trace["fixes"] as? [[String: Any]])
  let configBody = try recordedBody(productionConfig)
  let routesBody = try recordedBody(calgaryRoute)

  let host = RecordingCoreHost()
  host.setNow(try XCTUnwrap(fixes.first?["timestampMs"] as? Double))
  let engine = try NavOSSCoreEngine(
    configJSON: #"{"apiBaseUrl":"https://navoss.test","speedingAudibleWarning":true}"#,
    host: host)
  defer { engine.close() }
  var lines: [String] = []
  func emit(_ line: String) throws {
    lines += host.drainSpoken()
    lines.append(line)
    try checkEachState?(engine)
  }
  try emit("route \(try engine.setRoute(trip))")
  for fix in fixes {
    host.setNow(try XCTUnwrap(fix["timestampMs"] as? Double))
    let json = String(decoding: try JSONSerialization.data(withJSONObject: fix), as: UTF8.self)
    let state = try engine.updateLocation(json)
    try emit("state \(state)")
    guard state.contains(#""routeStatus":"rerouting""#) else { continue }
    // The config is asked for once per engine (then cached), then the routes.
    while true {
      let request = try XCTUnwrap(
        host.takeRequest(endingWithAny: ["/v2/config", "/v2/routes"]), "no route request")
      let isConfig = requestURL(request.json)?.hasSuffix("/v2/config") == true
      lines.append(isConfig ? "request GET /v2/config" : "request POST /v2/routes")
      engine.completeHTTPRequest(
        id: request.id, responseJSON: okResponse(isConfig ? configBody : routesBody))
      if !isConfig { break }
    }
    _ = try XCTUnwrap(host.waitUntilNotRerouting(), "the reroute did not finish")
    try emit("reroute \(engine.snapshot())")
  }
  try emit("clear \(engine.clearRoute())")
  return lines
}

/// Compares two transcripts: same lines, same keys, strings and integers; floating point within
/// `tolerance` relative (Apple libm and bionic differ in the last digits).
func assertTranscriptsMatch(
  _ expected: [String], _ actual: [String], tolerance: Double,
  file: StaticString = #filePath, line: UInt = #line
) {
  XCTAssertEqual(expected.count, actual.count, "line count", file: file, line: line)
  for (index, (want, got)) in zip(expected, actual).enumerated() where want != got {
    let wantParts = want.split(separator: " ", maxSplits: 1).map(String.init)
    let gotParts = got.split(separator: " ", maxSplits: 1).map(String.init)
    guard wantParts.first == gotParts.first, wantParts.first != "speak",
      wantParts.first != "request", wantParts.count == 2, gotParts.count == 2,
      let wantJSON = try? JSONSerialization.jsonObject(with: Data(wantParts[1].utf8)),
      let gotJSON = try? JSONSerialization.jsonObject(with: Data(gotParts[1].utf8))
    else {
      XCTFail("line \(index + 1): \(want) != \(got)", file: file, line: line)
      continue
    }
    if let difference = jsonDifference(wantJSON, gotJSON, tolerance: tolerance, path: "") {
      XCTFail("line \(index + 1)\(difference)", file: file, line: line)
    }
  }
}

/// Two JSON texts with the same structure, strings and integers, and floating point within
/// `tolerance` relative. `nil` when they match, otherwise where they differ.
func jsonDifference(_ expected: String, _ actual: String, tolerance: Double) -> String? {
  guard let a = try? JSONSerialization.jsonObject(with: Data(expected.utf8)),
    let b = try? JSONSerialization.jsonObject(with: Data(actual.utf8))
  else { return "not JSON" }
  return jsonDifference(a, b, tolerance: tolerance, path: "")
}

private func jsonDifference(_ a: Any, _ b: Any, tolerance: Double, path: String) -> String? {
  switch (a, b) {
  case let (a as [String: Any], b as [String: Any]):
    guard Set(a.keys) == Set(b.keys) else { return "\(path): keys \(a.keys.sorted()) != \(b.keys.sorted())" }
    for key in a.keys.sorted() {
      if let difference = jsonDifference(a[key]!, b[key]!, tolerance: tolerance, path: path + "." + key) {
        return difference
      }
    }
    return nil
  case let (a as [Any], b as [Any]):
    guard a.count == b.count else { return "\(path): \(a.count) != \(b.count) items" }
    for (index, (x, y)) in zip(a, b).enumerated() {
      if let difference = jsonDifference(x, y, tolerance: tolerance, path: "\(path)[\(index)]") {
        return difference
      }
    }
    return nil
  case let (a as NSNumber, b as NSNumber):
    let x = a.doubleValue
    let y = b.doubleValue
    if x == y { return nil }
    let relative = abs(x - y) / max(abs(x), abs(y))
    return relative <= tolerance ? nil : "\(path): \(x) != \(y)"
  case let (a as String, b as String):
    return a == b ? nil : "\(path): \(a) != \(b)"
  default:
    return "\(path): \(a) != \(b)"
  }
}
