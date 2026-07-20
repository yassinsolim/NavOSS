import CarPlay
import MapKit
internal import NavOSSNavigation
import UIKit

@objc(NavOSSCarPlaySceneDelegate)
@MainActor
final class NavOSSCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate,
  CPMapTemplateDelegate, CPSearchTemplateDelegate
{
  private weak var carWindow: CPWindow?
  private weak var interfaceController: CPInterfaceController?
  private var mapTemplate: CPMapTemplate?
  private var mapViewController: NavOSSCarPlayMapViewController?

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    self.interfaceController = interfaceController
    carWindow = window

    let mapViewController = NavOSSCarPlayMapViewController()
    self.mapViewController = mapViewController
    window.rootViewController = mapViewController

    let mapTemplate = makeMapTemplate()
    self.mapTemplate = mapTemplate
    interfaceController.setRootTemplate(mapTemplate, animated: false, completion: nil)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    self.interfaceController = nil
    carWindow = nil
    mapTemplate = nil
    mapViewController = nil
  }

  private func makeMapTemplate() -> CPMapTemplate {
    let template = CPMapTemplate()
    template.mapDelegate = self
    template.automaticallyHidesNavigationBar = true
    template.hidesButtonsWithNavigationBar = false

    let placesButton = CPBarButton(type: .text) { [weak self] _ in
      self?.showPlaces()
    }
    placesButton.title = "Places"
    template.leadingNavigationBarButtons = [placesButton]

    let recenterButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.recenter()
    }
    recenterButton.image = UIImage(systemName: "location.fill")
    let zoomInButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.zoom(by: 1)
    }
    zoomInButton.image = UIImage(systemName: "plus.magnifyingglass")
    let zoomOutButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.zoom(by: -1)
    }
    zoomOutButton.image = UIImage(systemName: "minus.magnifyingglass")
    template.mapButtons = [recenterButton, zoomInButton, zoomOutButton]
    return template
  }

  private func showPlaces() {
    guard let interfaceController else {
      return
    }

    let catalog = NavOSSCarPlayDestinationStore.shared.snapshot()
    var sections: [CPListSection] = []
    let shortcuts = [
      catalog.home.map { destinationItem($0, prefix: "Home") },
      catalog.work.map { destinationItem($0, prefix: "Work") },
    ].compactMap { $0 }
    if !shortcuts.isEmpty {
      sections.append(CPListSection(items: shortcuts, header: "Shortcuts", sectionIndexTitle: nil))
    }
    if !catalog.recents.isEmpty {
      sections.append(
        CPListSection(
          items: catalog.recents.prefix(6).map { destinationItem($0) },
          header: "Recent",
          sectionIndexTitle: nil
        )
      )
    }
    if !catalog.favorites.isEmpty {
      sections.append(
        CPListSection(
          items: catalog.favorites.prefix(6).map { destinationItem($0) },
          header: "Favorites",
          sectionIndexTitle: nil
        )
      )
    }

    let searchItem = CPListItem(text: "Search Calgary", detailText: "Places and addresses")
    searchItem.handler = { [weak self] _, completion in
      completion()
      let searchTemplate = CPSearchTemplate()
      searchTemplate.delegate = self
      self?.interfaceController?.pushTemplate(searchTemplate, animated: true, completion: nil)
    }
    sections.insert(CPListSection(items: [searchItem]), at: 0)

    let listTemplate = CPListTemplate(title: "Choose a destination", sections: sections)
    interfaceController.pushTemplate(listTemplate, animated: true, completion: nil)
  }

  private func destinationItem(
    _ destination: NavOSSCarPlayDestination,
    prefix: String? = nil
  ) -> CPListItem {
    let title = prefix.map { "\($0) · \(destination.name)" } ?? destination.name
    let item = CPListItem(text: title, detailText: destination.label)
    item.handler = { [weak self] _, completion in
      completion()
      self?.showRoutingUnavailableAlert(destination: destination)
    }
    return item
  }

  private func showRoutingUnavailableAlert(destination: NavOSSCarPlayDestination) {
    guard let mapTemplate else {
      return
    }
    let alert = CPNavigationAlert(
      titleVariants: [destination.name],
      subtitleVariants: ["CarPlay route loading will be enabled after native routing is connected."],
      image: nil,
      primaryAction: CPAlertAction(title: "OK", style: .default) { _ in },
      secondaryAction: nil,
      duration: 4
    )
    mapTemplate.present(navigationAlert: alert, animated: true)
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    updatedSearchText searchText: String,
    completionHandler: @escaping ([CPListItem]) -> Void
  ) {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.count >= 2 else {
      completionHandler([])
      return
    }
    let matches = NavOSSCarPlayDestinationStore.shared.snapshot().searchableDestinations
      .filter { destination in
        destination.name.localizedCaseInsensitiveContains(query) ||
          destination.label.localizedCaseInsensitiveContains(query)
      }
      .prefix(8)
      .map { destinationItem($0) }
    completionHandler(Array(matches))
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    selectedResult item: CPListItem,
    completionHandler: @escaping () -> Void
  ) {
    interfaceController?.popToRootTemplate(animated: true, completion: nil)
    completionHandler()
  }
}