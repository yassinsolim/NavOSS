# CarPlay Navigation Architecture

Status: Proposed, entitlement-gated

## Decision

NavOSS will support CarPlay as native scenes inside the existing iPhone app. It will not ship a separate CarPlay app or render the phone's React Native tree onto the vehicle display.

The implementation will use:

- Apple's CarPlay framework for all vehicle controls and overlays.
- A native MapLibre map view for the base map in each CarPlay-owned window.
- A native `NavOSSNavigation` service as the single source of route, matched location, maneuver, lane, reroute, arrival, and speech state.
- The same normalized route model and NavOSS API used by the phone experience.
- React Native as a consumer of native navigation state, not as the owner of a CarPlay session.

This preserves one route and one navigation session across the phone, the main CarPlay display, CarPlay Dashboard, and supported instrument-cluster or HUD surfaces.

## External Gate

CarPlay navigation is a managed Apple capability. The app needs the Boolean entitlement:

```xml
<key>com.apple.developer.carplay-maps</key>
<true/>
```

Apple must approve the capability for the app's explicit App ID before a matching provisioning profile can be created. The Account Holder of an enrolled Apple Developer Program team submits the capability request and accepts the CarPlay terms. The current Personal Team workflow is sufficient for the phone alpha, but not for provisioning this managed capability.

Do not add the entitlement to the default Expo configuration before approval. An unapproved entitlement would break signed device builds without making the app appear in CarPlay.

## Why Foreground JavaScript Is Not Enough

The current alpha watches location and advances maneuvers in React Native while the app is in the foreground. It also draws the raw location coordinate. A production navigation app needs native location processing and route matching because:

- CarPlay must remain usable while the iPhone is locked and inaccessible.
- The phone and multiple CarPlay scenes may connect or disconnect independently.
- Guidance, rerouting, speech, and arrival must continue when the React Native UI is suspended.
- The displayed vehicle position should be map-matched while raw location remains available for off-route detection.
- CarPlay expects regular maneuver and travel-estimate updates from an active native navigation session.

The native navigation-core spike is therefore a prerequisite, not optional polish.

## Native Components

### Navigation service

`NavOSSNavigation` will own:

- The selected route and alternatives.
- Raw and map-matched location.
- Current route segment and remaining geometry.
- Current and upcoming maneuvers.
- Lane guidance where the provider has reliable lane data.
- ETA, remaining time, and remaining distance.
- Off-route confidence, reroute state, and arrival state.
- Speech and audio-session coordination.
- A replay location provider for deterministic tests.

The service exposes typed snapshots and events to both Swift scene delegates and the React Native TurboModule adapter.

### Main CarPlay scene

`NavOSSCarPlaySceneDelegate` conforms to `CPTemplateApplicationSceneDelegate` and handles the navigation-specific connection method that supplies both `CPInterfaceController` and `CPWindow`.

On connection it will:

1. Retain the interface controller and window for the session lifetime.
2. Install a native MapLibre view controller as the window's root view controller.
3. Draw only map content in that window.
4. Set `CPMapTemplate` as the root template.
5. Configure system map buttons for recenter, pan, zoom, route overview, and audio state.
6. Subscribe to `NavOSSNavigation` snapshots.

Apple does not permit arbitrary controls or React Native overlays in the base map view. Alerts, buttons, lists, search, trip previews, and guidance use CarPlay templates.

### Dashboard scene

`NavOSSCarPlayDashboardSceneDelegate` conforms to `CPTemplateApplicationDashboardSceneDelegate` and renders a second native MapLibre view into the dashboard window.

The scene manifest will include `CPSupportsDashboardNavigationScene` and the dashboard scene role. While navigating, Dashboard receives the same matched location, route, and camera state as the main display. When idle, it can expose at most two useful shortcut buttons, such as Home and Work or Recents.

### Instrument cluster and HUD

NavOSS will provide CarPlay with structured turn-by-turn metadata rather than trying to draw arbitrary cluster UI. On supported OS and vehicle combinations this includes route segments, current segment, maneuver state, road-name variants, lane guidance, and travel estimates. Availability checks are required because display support is vehicle-dependent and some current APIs remain beta.

CarPlay Ultra is a vehicle and system integration. NavOSS can participate through supported CarPlay framework surfaces, but cannot reproduce Apple's system UI or promise instrument-cluster maps on every vehicle.

## User Flows

### Destination search

- Use `CPSearchTemplate` for bounded destination search.
- Show recents and locally stored favorites without requiring phone interaction.
- Keep result rows concise and provide clear no-network and degraded-provider states in CarPlay.
- Do not direct a moving driver to finish setup on the phone.

### Route preview

- Convert normalized alternatives into `CPTrip` and `CPRouteChoice` objects.
- Use `CPMapTemplate.showTripPreviews` for route selection.
- Draw selected and alternate route geometry in the native MapLibre view.
- Include real duration, distance, and major-road summaries.
- Continue to state that live traffic is unavailable until a real traffic source exists.

### Active guidance

- Start a `CPNavigationSession` from the selected `CPTrip`.
- Keep at least one `CPManeuver` in `upcomingManeuvers`.
- Update `CPTravelEstimates` for the trip and current maneuver as native progress changes.
- Publish lane and route-segment metadata where available.
- Pause, resume, cancel, finish, and reroute through the matching CarPlay session APIs.
- Coordinate spoken guidance with the vehicle audio session without taking over overall volume.

## Map Rendering

MapLibre React Native 11.3.6 already links MapLibre Native 6.26.0 into the iOS application target using Swift Package Manager. The CarPlay scene can therefore import MapLibre and instantiate a native map view without adding a second map SDK.

Each display owns its own map view and camera, but all displays consume the same native navigation snapshot. Styles must support:

- Light and dark CarPlay appearances.
- Standard, portrait, minimum-size, and ultrawide displays.
- High contrast in direct sunlight and at night.
- Stable route casing, congestion patterns when real traffic exists, and a clearly visible matched-location puck.

## Expo Integration

Native source should live in a local Expo module, planned at:

```text
apps/mobile/modules/navoss-navigation/
  expo-module.config.json
  ios/
    NavOSSNavigationModule.swift
    NavOSSNavigationService.swift
    NavOSSCarPlaySceneDelegate.swift
    NavOSSCarPlayDashboardSceneDelegate.swift
    NavOSSCarPlayMapViewController.swift
  plugin/
    withNavOSSCarPlay.js
```

The config plugin will be idempotent and enabled only when `NAVOSS_CARPLAY_ENABLED=1`. After Apple approval it will:

- Add the navigation entitlement.
- Add main CarPlay and Dashboard scene configurations to `Info.plist`.
- Set `CPSupportsDashboardNavigationScene`.
- Add required Swift files to the application target.
- Add background location configuration only with the matching permission, privacy, and App Store declarations.

The ignored generated `ios/` directory remains disposable. All native behavior and configuration must regenerate from the module and plugin.

## Implementation Order

1. Enroll the release team and submit the CarPlay navigation capability request for `org.navoss.mobile`.
2. Complete the native navigation-core spike with matched location, background progress, rerouting, speech, and deterministic replay.
3. Make the phone UI consume native snapshots and remove foreground JavaScript as the navigation source of truth.
4. Add an entitlement-disabled native CarPlay scene unit and compile spike using MapLibre Native.
5. After approval, enable the capability and provisioning profile in a dedicated CarPlay build configuration.
6. Implement search, route preview, `CPNavigationSession`, maneuvers, estimates, and disconnect/reconnect behavior.
7. Add Dashboard rendering and guarded cluster/HUD metadata.
8. Validate in Simulator, a physical iPhone while locked, and at least one wired and one wireless real CarPlay system.

## Validation Matrix

Apple recommends testing at least these simulator configurations:

| Configuration   | Resolution | Scale |
| --------------- | ---------: | ----: |
| Minimum         |  748 x 456 |   @2x |
| Portrait        | 768 x 1024 |   @2x |
| Standard        |  800 x 480 |   @2x |
| High resolution | 1920 x 720 |   @3x |

Additional required checks:

- Phone locked before and during navigation.
- CarPlay connected before app launch and connected mid-route.
- Main display and Dashboard connecting and disconnecting in either order.
- Route started on phone, started in CarPlay, rerouted, canceled, and resumed.
- No network, stale route/search provider, poor GPS, and skipped location updates.
- Voice prompt mixing with radio, calls, Siri, and other audio apps.
- Light, dark, portrait, ultrawide, touch, rotary, and touchpad interaction.
- Real vehicle or aftermarket-system testing; Simulator is not sufficient for lock, Siri, or audio behavior.

## Approval-Ready Evidence

The capability request and eventual App Review submission should be backed by:

- A working account-free navigation flow on iPhone.
- A privacy policy and accurate location/background-use disclosure.
- Screens or a short capture showing search, route preview, and active guidance.
- Reliable rerouting, voice, arrival, and network-loss behavior.
- Clear source attribution and no claim of live traffic while unavailable.
- A driver-distraction review showing that all vehicle interactions use approved templates.

## Apple References

- [Requesting CarPlay Entitlements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
- [Request access to managed capabilities](https://developer.apple.com/help/account/capabilities/capability-requests/)
- [Displaying Content in CarPlay](https://developer.apple.com/documentation/carplay/displaying-content-in-carplay)
- [Integrating CarPlay with Your Navigation App](https://developer.apple.com/documentation/carplay/integrating-carplay-with-your-navigation-app)
- [CPMapTemplate](https://developer.apple.com/documentation/carplay/cpmaptemplate)
- [CPNavigationSession](https://developer.apple.com/documentation/carplay/cpnavigationsession)
- [Using the CarPlay Simulator](https://developer.apple.com/documentation/carplay/using-the-carplay-simulator)
- [CarPlay Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/carplay)
- [Turbocharge your app for CarPlay](https://developer.apple.com/videos/play/wwdc2025/216/)
- [Rev up your CarPlay app](https://developer.apple.com/videos/play/wwdc2026/212/)
