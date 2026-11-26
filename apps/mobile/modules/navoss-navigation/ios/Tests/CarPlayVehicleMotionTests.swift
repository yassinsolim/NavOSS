import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CarPlayVehicleMotionTests: XCTestCase {
  /// Replays every scenario in every mode and, when `NAVOSS_MOTION_REPORT` names a file, writes the
  /// numbers there as JSON. This measures; the behaviour is pinned by the tests below.
  func testMotionReplayReport() throws {
    var report: [String: [String: Double]] = [:]
    for scenario in ReplayScenarios.all {
      for mode in [ReplayMode.guidance, .guidanceWithCompass, .freeDrive] {
        let frames = MotionReplay.run(scenario, mode: mode)
        XCTAssertFalse(frames.isEmpty, "\(scenario.name) \(mode.rawValue)")
        report["\(scenario.name) \(mode.rawValue)"] = ReplayMetrics(frames, road: scenario.road).json
      }
    }
    guard let path = ProcessInfo.processInfo.environment["NAVOSS_MOTION_REPORT"] else { return }
    let data = try JSONSerialization.data(
      withJSONObject: report, options: [.sortedKeys, .prettyPrinted])
    try data.write(to: URL(fileURLWithPath: path))
  }
}
