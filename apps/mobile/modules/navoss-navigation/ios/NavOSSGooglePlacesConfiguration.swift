import Foundation

#if NAVOSS_GOOGLE_PLACES
import GooglePlacesSwift
#endif

enum NavOSSGooglePlacesConfiguration {
  private static var configured = false

  private static var apiKey: String? {
    guard
      Bundle.main.object(forInfoDictionaryKey: "NavOSSGooglePlacesEnabled") as? Bool == true,
      let value = Bundle.main.object(forInfoDictionaryKey: "NavOSSGooglePlacesAPIKey") as? String
    else {
      return nil
    }
    let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return key.isEmpty ? nil : key
  }

  static var isAvailable: Bool {
    #if NAVOSS_GOOGLE_PLACES
    return configured
    #else
    return false
    #endif
  }

  @MainActor
  static func configure() {
    #if NAVOSS_GOOGLE_PLACES
    guard let apiKey else { return }
    configured = PlacesClient.provideAPIKey(apiKey)
    #endif
  }

  static var openSourceLicenseInfo: String? {
    #if NAVOSS_GOOGLE_PLACES
    return PlacesClient.openSourceLicenseInfo
    #else
    return nil
    #endif
  }
}
