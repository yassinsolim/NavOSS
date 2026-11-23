import Foundation
import NavOSSNavigationCore

// Feeds a recorded route and a fix trace through the engine facade and prints every event,
// one per line, so the output on Android and macOS can be compared byte for byte.
// Usage: NavOSSReplay <routes-v2 fixture> <trace>

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  FileHandle.standardError.write(Data("usage: NavOSSReplay <route fixture> <trace>\n".utf8))
  exit(2)
}

func object(_ path: String) throws -> [String: Any] {
  let data = try Data(contentsOf: URL(fileURLWithPath: path))
  return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
}

func text(_ value: Any) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
}

do {
  let fixture = try object(arguments[1])
  let trace = try object(arguments[2])
  let request = fixture["request"] as? [String: Any] ?? [:]
  var destination = request["destination"] as? [String: Any] ?? [:]
  destination["id"] = "replay-destination"
  destination["label"] = "Replay destination"
  destination["name"] = "Replay destination"

  let engine = NavOSSEngineFacade()
  engine.setSpeedingWarning(toleranceKph: 5, audible: true)
  engine.onEvent = { kind, json in
    if kind == "speech" { print("speech \(json)") }
  }
  let route = try text([
    "destination": destination, "routeIndex": 0, "response": fixture["response"] ?? [:],
  ] as [String: Any])
  print("route \(try engine.setRoute(fromRoutesV2Request: route))")
  for fix in trace["fixes"] as? [[String: Any]] ?? [] {
    print("state \(try engine.updateLocation(try text(fix)))")
  }
  print("clear \(try engine.clearRoute())")
} catch {
  print("error \(error)")
  exit(1)
}
