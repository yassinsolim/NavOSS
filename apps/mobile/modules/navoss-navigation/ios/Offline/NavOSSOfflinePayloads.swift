import Foundation

/// JavaScript payloads for the offline-maps surface of the Expo module. Shapes match the
/// `NativeOffline*` types in `modules/navoss-navigation/index.ts`.
enum NavOSSOfflinePayloads {
  static func status(_ status: NavOSSOfflineStatus) -> [String: Any] {
    var payload: [String: Any] = [
      "catalog": catalog(status.catalog),
      "stale": status.catalog == .available(stale: true),
      "regions": status.regions.map(region),
      "storageBytes": status.storageBytes,
      "preferOffline": status.preferOffline,
      "networkAvailable": status.networkAvailable,
    ]
    if let bundleVersion = status.bundleVersion { payload["bundleVersion"] = bundleVersion }
    if let dataDate = status.dataDate { payload["dataDate"] = dataDate }
    if let available = status.availableBytes { payload["availableBytes"] = available }
    return payload
  }

  private static func catalog(_ state: NavOSSOfflineCatalogState) -> String {
    switch state {
    case .loading: "loading"
    case .notPublished: "not-published"
    case .unreachable: "unreachable"
    case .unsupported: "unsupported"
    case .available: "available"
    }
  }

  private static func region(_ status: NavOSSOfflineRegionStatus) -> [String: Any] {
    let bounds = status.region.bounds
    var payload: [String: Any] = [
      "id": status.region.id,
      "name": status.region.name,
      "bounds": [bounds.west, bounds.south, bounds.east, bounds.north],
      "downloadBytes": status.downloadBytes,
      "updateAvailable": status.updateAvailable,
      "attribution": status.region.attribution.map {
        ["text": $0.text, "url": $0.url, "license": $0.license]
      },
    ]
    if let installed = status.installed {
      payload["installedBytes"] = installed.installedBytes
      payload["installedVersion"] = installed.bundleVersion
      payload["installedDataDate"] = installed.region.dataDate
    }
    switch status.activity {
    case .idle:
      payload["state"] = status.installed == nil ? "not-downloaded" : "installed"
    case .queued:
      payload["state"] = "queued"
    case .downloading(let received, let total):
      payload["state"] = "downloading"
      payload["receivedBytes"] = received
      payload["totalBytes"] = total
    case .paused(let received, let total):
      payload["state"] = "paused"
      payload["receivedBytes"] = received
      payload["totalBytes"] = total
    case .verifying:
      payload["state"] = "verifying"
    case .installing:
      payload["state"] = "installing"
    case .failed(let failure, let received, let total):
      payload["state"] = "failed"
      payload["receivedBytes"] = received
      payload["totalBytes"] = total
      payload["failure"] = self.failure(failure)
    }
    return payload
  }

  private static func failure(_ failure: NavOSSOfflineFailure) -> [String: Any] {
    switch failure {
    case .insufficientStorage(let required, let available):
      ["reason": "storage", "requiredBytes": required, "availableBytes": available]
    case .network:
      ["reason": "network"]
    case .server(let statusCode):
      ["reason": "server", "statusCode": statusCode]
    case .integrity:
      ["reason": "integrity"]
    case .unsupported:
      ["reason": "unsupported"]
    case .installation:
      ["reason": "installation"]
    }
  }

  static func place(_ place: NavOSSOfflinePlace) -> [String: Any] {
    var payload: [String: Any] = [
      "id": place.id,
      "name": place.name,
      "label": place.label,
      "category": place.resultCategory,
      "nameSource": place.nameSource,
      "latitude": place.latitude,
      "longitude": place.longitude,
      "distanceMeters": place.straightLineMeters,
    ]
    if let detail = place.detailCategory { payload["detailCategory"] = detail }
    if !place.address.isEmpty { payload["address"] = place.address }
    return payload
  }

  /// Stable codes JavaScript maps to copy.
  static func errorCode(_ error: Error) -> String {
    switch error {
    case NavOSSOfflineRoutingError.outsideInstalledCoverage,
      NavOSSOfflineRoutingError.routeLeavesCoverage:
      "outside-coverage"
    case NavOSSOfflineRoutingError.noRoute:
      "no-route"
    case NavOSSOfflineSearchError.unavailable:
      "not-installed"
    default:
      "engine-unavailable"
    }
  }
}
