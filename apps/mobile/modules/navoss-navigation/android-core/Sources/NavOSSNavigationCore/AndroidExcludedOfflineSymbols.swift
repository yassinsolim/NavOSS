// The Android subset does not compile the offline (Valhalla, SQLite, zlib) sources.
// CarPlayTrip.swift compares route sources against this marker; keep the value equal
// to `navOSSOfflineRouteSource` in ios/Core/OfflineRouting.swift.
public let navOSSOfflineRouteSource = "offline-valhalla"
