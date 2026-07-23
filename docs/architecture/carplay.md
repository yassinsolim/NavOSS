# CarPlay Navigation Architecture

Status: Apple-approved, full tester flow implemented, physical validation gated

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

Apple approved the CarPlay Navigation App capability for the explicit App ID `org.navoss.mobile` on 2026-07-21. The Developer portal now exposes `com.apple.developer.carplay-maps` for Development, Ad Hoc, and App Store Connect provisioning.

This removes the external approval blocker, but it does not make the current implementation release-ready. A dedicated build can now continue an active phone route onto the main CarPlay display with a native route line, `CPNavigationSession`, maneuvers, travel estimates, arrival, reconnect state, and vehicle-side cancellation. While that scene is connected, the phone replaces its interactive map with a low-distraction companion showing only the next maneuver, arrival summary, destination, and End or Done action.

The native navigation service now owns active Core Location updates, map matching, maneuver progression, spoken guidance, background continuation, rerouting, arrival, and transient active-route recovery. CarPlay search uses the private NavOSS API, previews route alternatives with approved templates, and starts navigation without phone interaction. Dashboard, cluster metadata, and real-vehicle validation remain incomplete. Normal production builds remain unchanged; the dedicated `production-carplay` profile enables the scene, entitlement, native API URL, and location background mode for controlled testing.

### Maps capability decision

Do not enable the separate `com.apple.developer.maps` capability shown as **Maps** in the Developer portal. Apple documents that entitlement as deprecated, available only for macOS 10.9 through 10.11, and no longer required for using Maps. It does not connect NavOSS to the Apple Maps app and is unrelated to the CarPlay Navigation App entitlement.

MapKit is a framework that can embed Apple map imagery, annotations, search, and other location features in an app. Modern iOS MapKit use does not require `com.apple.developer.maps`. NavOSS currently uses MapLibre and OpenFreeMap on the phone and in its native CarPlay spike, so enabling the deprecated Maps entitlement provides no benefit. Any future MapKit or Apple Maps URL integration should be evaluated as a separate product, data-source, privacy, and attribution decision.

## Why Foreground JavaScript Is Not Enough

The current alpha watches location and advances maneuvers in React Native while the app is in the foreground. It also draws the raw location coordinate. A production navigation app needs native location processing and route matching because:

- CarPlay must remain usable while the iPhone is locked and inaccessible.
- The phone and multiple CarPlay scenes may connect or disconnect independently.
- Guidance, rerouting, speech, and arrival must continue when the React Native UI is suspended.
- The displayed vehicle position should be map-matched while raw location remains available for off-route detection.
- CarPlay expects regular maneuver and travel-estimate updates from an active native navigation session.

The native navigation-core spike is therefore a prerequisite, not optional polish.

## Native Components

### Current continuation status

The entitlement-free native slice now lives in `apps/mobile/modules/navoss-navigation`. It provides an autolinked iOS Expo module, deterministic Swift tests, route geometry ownership, course-aware and route-continuous segment scoring, raw and matched coordinates, route progress, horizontal-accuracy input, accuracy-aware off-route confirmation and recovery hysteresis, conservative endpoint arrival confirmation, and typed snapshot events. The phone UI uses its matched coordinate during active guidance and falls back to raw GPS after a departure is confirmed. Foreground JavaScript consumes that confirmed state, requests a cooldown-limited replacement route, and installs it without ending guidance. A sticky native `arrived` phase ends guidance and drives the phone completion panel.

The shared native trip store now accepts a validated route, destination, steps, and live guidance summaries from the phone. It owns CarPlay connection state and emits vehicle-side cancellation back to React Native. The main CarPlay scene observes this store, restores an active trip when the display reconnects, draws the route through MapLibre Native, starts `CPNavigationSession`, and updates structured maneuvers and travel estimates. The entitlement and scene remain build-time gated.

Normal builds omit the CarPlay scene and entitlement but retain active-navigation background location for phone guidance. Native location starts only during active navigation or, in the dedicated CarPlay build, while CarPlay needs a current origin. When in Use authorization and iOS's visible background indicator are used; Always authorization is not requested. The current active route is stored only for operating-system recovery and erased on End or confirmed arrival.

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

### Share ETA and Contacts decision

The phone experience uses the operating system share sheet for a static ETA message containing only the destination name, estimated arrival, remaining time, and remaining distance. It does not read Contacts, request Contacts permission, expose current coordinates or route geometry, create a tracking link, or maintain a recipient list. Apple's share sheet may suggest recent recipients without making those contacts available to NavOSS.

Do not add a custom recent-contacts browser to the CarPlay navigation app. Contacts access would require a purpose string and explicit limited or full authorization, and arbitrary contact browsing is not an approved `CPMapTemplate` navigation surface. The current CarPlay scene can display a truthful ETA for a route started on the phone, but it cannot start its own route yet. Share ETA remains omitted from the vehicle display to keep the first continuation slice focused and low-distraction.

A CarPlay Share ETA control remains gated until the native route/background lifecycle is complete and Apple documentation or review confirms a template-compliant, low-distraction interaction. It must not direct a moving driver to complete the action on the phone. Prefer a system-owned communication flow that does not reveal contacts to NavOSS; otherwise omit the control from CarPlay and keep system sharing on the phone.

## Map Rendering

MapLibre React Native 11.3.6 already links MapLibre Native 6.26.0 into the iOS application target using Swift Package Manager. The CarPlay scene can therefore import MapLibre and instantiate a native map view without adding a second map SDK.

Each display owns its own map view and camera, but all displays consume the same native navigation snapshot. Styles must support:

- Light and dark CarPlay appearances.
- Standard, portrait, minimum-size, and ultrawide displays.
- High contrast in direct sunlight and at night.
- Stable route casing, congestion patterns when real traffic exists, and a clearly visible matched-location puck.

## Expo Integration

The implementation is split between a local Expo module and app-target source templates:

```text
apps/mobile/modules/navoss-navigation/
  expo-module.config.json
  index.ts
  ios/
    NavOSSNavigationModule.swift
    Core/CarPlayTrip.swift

apps/mobile/carplay/ios/
    NavOSSCarPlayMapViewController.swift
    NavOSSCarPlaySceneDelegate.swift
    NavOSSPhoneSceneDelegate.swift

apps/mobile/plugins/with-navoss-carplay.cjs
```

The config plugin configures the native API URL and `location` background mode for every iOS navigation build. When `NAVOSS_CARPLAY_ENABLED=1`, it also:

- Adds the main CarPlay scene and the Expo-compatible phone window scene to `Info.plist`.
- Adds the required Swift templates to the application target.
- Adds the navigation entitlement only when `NAVOSS_CARPLAY_ENTITLEMENT_ENABLED=1`.
- Leaves Dashboard and instrument-cluster integration disabled until those implementations are complete.

When CarPlay is disabled, the plugin removes the CarPlay scene and entitlement. Background location is not a CarPlay entitlement: it supports an active trip on the phone and stops on End or confirmed arrival.

The ignored generated `ios/` directory remains disposable. All native behavior and configuration must regenerate from the module and plugin.

## Implementation Order

1. Complete: Apple approved the CarPlay Navigation App capability for `org.navoss.mobile` on 2026-07-21.
2. Complete for tester flow: native matched location, background progress, rerouting, speech, transient recovery, and deterministic replay.
3. Complete: the phone consumes native snapshots and no longer owns a second active location/reroute loop.
4. Complete: add a gated native CarPlay scene, shared trip bridge, MapLibre route rendering, maneuvers, estimates, reconnect state, and a minimal phone companion for routes started on the phone.
5. Enable the approved capability and regenerate provisioning only in a dedicated CarPlay build configuration after route loading and background continuity are complete.
6. Complete for main display: native search, route preview, `CPNavigationSession`, maneuvers, estimates, cancellation, and disconnect/reconnect behavior.
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
