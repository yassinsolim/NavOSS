import Foundation

public enum NavOSSOfflineStyleError: Error, Equatable, Sendable {
  case invalidStyle
  case unsupportedLayout
}

/// Binds an offline bundle style (portable `pmtiles://maps.pmtiles`, `./glyphs/...`,
/// `./sprites/ofm` references) to the installed files, exactly like the pipeline's reference
/// `bindOfflineStyle` for native: `pmtiles://file:///…/maps.pmtiles`, `file:///…/glyphs/…` and
/// `file:///…/sprites/ofm`, percent-encoded. Any other source, or any remaining network URL,
/// fails closed: an offline style must never reach for the network.
public func navOSSBindOfflineStyle(
  _ styleData: Data,
  mapsFile: URL,
  resourcesRoot: URL
) throws -> Data {
  guard var style = try? JSONSerialization.jsonObject(with: styleData) as? [String: Any],
    style["version"] as? Int == 8,
    style["layers"] is [Any],
    var sources = style["sources"] as? [String: Any]
  else {
    throw NavOSSOfflineStyleError.invalidStyle
  }
  guard var openMapTiles = sources["openmaptiles"] as? [String: Any],
    openMapTiles["url"] as? String == "pmtiles://maps.pmtiles",
    sources.count == 1,
    style["glyphs"] as? String == "./glyphs/{fontstack}/{range}.pbf",
    style["sprite"] as? String == "./sprites/ofm",
    mapsFile.isFileURL, resourcesRoot.isFileURL
  else {
    throw NavOSSOfflineStyleError.unsupportedLayout
  }
  let resources = resourcesRoot.standardizedFileURL.absoluteString
    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  openMapTiles["url"] = "pmtiles://\(mapsFile.standardizedFileURL.absoluteString)"
  sources["openmaptiles"] = openMapTiles
  style["sources"] = sources
  // `absoluteString` of a file URL is `file:///…`; trimming removed the trailing slash only.
  style["glyphs"] = "\(resources)/glyphs/{fontstack}/{range}.pbf"
  style["sprite"] = "\(resources)/sprites/ofm"
  return try JSONSerialization.data(withJSONObject: style, options: [.sortedKeys, .withoutEscapingSlashes])
}

/// The offline style slug for a NavOSS style preset name, mirroring the hosted OpenFreeMap slugs
/// the phone and CarPlay already use (`liberty`, `bright`, `positron`, `dark`).
public func navOSSOfflineStyleSlug(_ slug: String) -> String? {
  navOSSOfflineStyleSlugs.contains(slug) ? slug : nil
}
