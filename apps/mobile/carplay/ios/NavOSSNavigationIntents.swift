import AppIntents
import CarPlay
internal import NavOSSNavigation
import UIKit

/// A place Siri can hand to NavOSS: a saved place, a recent destination, or a search result.
struct NavOSSPlaceEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Place")
  static let defaultQuery = NavOSSPlaceQuery()

  let id: String
  let name: String
  let label: String
  let latitude: Double
  let longitude: Double
  let category: String?

  init(_ destination: NavOSSCarPlayDestination) {
    id = destination.id
    name = destination.name
    label = destination.label
    latitude = destination.latitude
    longitude = destination.longitude
    category = destination.category
  }

  var destination: NavOSSCarPlayDestination {
    NavOSSCarPlayDestination(
      category: category, id: id, label: label, latitude: latitude, longitude: longitude,
      name: name)
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(name)",
      subtitle: label.isEmpty ? nil : "\(label)"
    )
  }
}

/// Resolves spoken place names against the driver's own saved places first, then the NavOSS
/// search API near the current position. Nothing Siri passes in is stored.
struct NavOSSPlaceQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [NavOSSPlaceEntity] {
    let known = await NavOSSIntentPlaces.known()
    return identifiers.compactMap { identifier in known.first { $0.id == identifier } }
  }

  func suggestedEntities() async throws -> [NavOSSPlaceEntity] {
    await NavOSSIntentPlaces.saved()
  }

  func entities(matching string: String) async throws -> [NavOSSPlaceEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return [] }
    let saved = await NavOSSIntentPlaces.saved().filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || $0.label.localizedCaseInsensitiveContains(query)
    }
    let remote: [NavOSSPlaceEntity]
    do {
      let client = try NavOSSNavigationAPIClient()
      remote = try await client.search(
        query: query,
        proximity: NavOSSNavigationService.shared.currentCoordinate()
      ).prefix(5).map(NavOSSPlaceEntity.init)
    } catch {
      remote = []
    }
    await NavOSSIntentPlaces.remember(remote)
    var seen = Set<String>()
    return (saved + remote).filter { seen.insert($0.id).inserted }
  }
}

/// Places the intent can resolve by identifier: saved places plus the latest search results.
@MainActor
enum NavOSSIntentPlaces {
  private static var lastResults: [NavOSSPlaceEntity] = []

  static func saved() -> [NavOSSPlaceEntity] {
    let catalog = NavOSSCarPlayDestinationStore.shared.snapshot()
    return ([catalog.home, catalog.work].compactMap { $0 } + catalog.favorites + catalog.recents)
      .map(NavOSSPlaceEntity.init)
  }

  static func known() -> [NavOSSPlaceEntity] {
    saved() + lastResults
  }

  static func remember(_ results: [NavOSSPlaceEntity]) {
    lastResults = results
  }
}

/// "Navigate to <place> with NavOSS". Shows routes to the place on the CarPlay screen; the trip
/// starts only when the driver taps Go, so a misheard name never starts guidance by itself.
struct NavigateWithNavOSSIntent: AppIntent {
  static let title: LocalizedStringResource = "Navigate with NavOSS"
  static let description = IntentDescription(
    "Shows routes to a place on the NavOSS CarPlay screen. Tap Go to start."
  )
  static let openAppWhenRun = false

  @Parameter(title: "Destination", requestValueDialog: "Where to?")
  var destination: NavOSSPlaceEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Navigate to \(\.$destination)")
  }

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard NavOSSCarPlayIntentRequests.isCarPlayConnected else {
      return .result(
        dialog: "Connect your iPhone to CarPlay to navigate with NavOSS. On iPhone, search for \(destination.name) in NavOSS."
      )
    }
    NavOSSCarPlayIntentRequests.request(destination.destination)
    return .result(dialog: "Showing routes to \(destination.name) on your car screen. Tap Go to start.")
  }
}

struct NavOSSAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: NavigateWithNavOSSIntent(),
      phrases: [
        "Navigate to \(\.$destination) with \(.applicationName)",
        "Take me to \(\.$destination) with \(.applicationName)",
        "Directions to \(\.$destination) in \(.applicationName)",
        "Navigate with \(.applicationName)",
      ],
      shortTitle: "Navigate",
      systemImageName: "arrow.triangle.turn.up.right.diamond.fill"
    )
  }
}

extension Notification.Name {
  static let navOSSCarPlayIntentDestinationRequested = Notification.Name(
    "org.navoss.mobile.carplay-intent-destination-requested"
  )
}

/// Hands a Siri destination to the main CarPlay scene. A request made while that scene is not in
/// front waits here and is taken when the scene connects or becomes active.
@MainActor
enum NavOSSCarPlayIntentRequests {
  private static var pending: NavOSSCarPlayDestination?

  static var isCarPlayConnected: Bool {
    UIApplication.shared.connectedScenes.contains { $0.session.role == .carTemplateApplication }
  }

  static func request(_ destination: NavOSSCarPlayDestination) {
    pending = destination
    NotificationCenter.default.post(name: .navOSSCarPlayIntentDestinationRequested, object: nil)
    let foreground = UIApplication.shared.connectedScenes.contains {
      $0.session.role == .carTemplateApplication && $0.activationState == .foregroundActive
    }
    guard !foreground else { return }
    if #available(iOS 17.0, *) {
      let request = UISceneSessionActivationRequest(role: .carTemplateApplication)
      UIApplication.shared.activateSceneSession(for: request, errorHandler: nil)
    } else {
      let session = UIApplication.shared.openSessions.first { $0.role == .carTemplateApplication }
      UIApplication.shared.requestSceneSessionActivation(
        session, userActivity: nil, options: nil, errorHandler: nil)
    }
  }

  static func take() -> NavOSSCarPlayDestination? {
    defer { pending = nil }
    return pending
  }

  /// Keeps Siri's suggested places in step with the saved-place catalogue.
  static func refreshSuggestedPlaces() {
    NavOSSAppShortcuts.updateAppShortcutParameters()
  }
}
