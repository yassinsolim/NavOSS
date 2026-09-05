# CarPlay Navigation Architecture

Status: Apple-approved, full tester flow implemented, physical validation gated

## Decision

NavOSS will support CarPlay as native scenes inside the existing iPhone app. It will not ship a separate CarPlay app or render the phone's React Native tree onto the vehicle display.

The implementation will use:

- Apple's CarPlay framework for all vehicle controls and overlays.
- A native MapLibre map view for the base map in each CarPlay-owned window.
- A native `NavOSSNavigation` service as the single source of the selected route, matched location, maneuver, reroute, arrival, and speech state.
- The same normalized route model and NavOSS API used by the phone experience.
- React Native as a consumer of native navigation state, not as the owner of a CarPlay session.

This preserves one route and one navigation session across the phone, main CarPlay display, and CarPlay Dashboard. Instrument-cluster and HUD surfaces remain future work.

## External Gate

CarPlay navigation is a managed Apple capability. The app needs the Boolean entitlement:

```xml
<key>com.apple.developer.carplay-maps</key>
<true/>
```

Apple approved the CarPlay Navigation App capability for the explicit App ID `org.navoss.mobile` on 2026-07-21. The Developer portal now exposes `com.apple.developer.carplay-maps` for Development, Ad Hoc, and App Store Connect provisioning.

This removes the external approval blocker, but it does not make the current implementation release-ready. A dedicated build can now continue an active phone route onto the main CarPlay display with a native route line, `CPNavigationSession`, maneuvers, travel estimates, arrival, reconnect state, and vehicle-side cancellation. While that scene is connected, the phone replaces its interactive map with a low-distraction companion. During guidance and arrival the companion shows the next maneuver, arrival summary, destination, and End or Done action; in every other connected state it shows only that navigation is running on the car's display.

The companion covers _every_ connected state, so the handset never runs a second MapLibre view against the car's. This deliberately withdraws search, the Saved and Contribute tabs, the tab bar, and map appearance for as long as the car is connected, including while parked, matching how first-party navigation apps hand the whole surface to the head unit. Phone-side route state that the companion cannot act on — loading, failed, or awaiting Start — is released on connect rather than stranded behind a surface with no Retry, Cancel, or Start control. Reaching those phone surfaces again means disconnecting from the car.

The native navigation service now owns active Core Location updates, map matching, maneuver progression, spoken guidance, background continuation, rerouting, arrival, and transient active-route recovery. CarPlay search uses the private NavOSS API, previews route alternatives with approved templates, and starts navigation without phone interaction. A Dashboard scene renders the shared route and guidance state without creating a second navigation session, with Go and Voice shortcuts that activate the main CarPlay scene. Apple decides which navigation app occupies the Dashboard tile; Voice opens NavOSS search and is not a custom Siri speech recognizer. Cluster metadata and real-vehicle Dashboard validation remain incomplete. Normal production builds remain unchanged; the dedicated `production-carplay` profile enables the scenes, entitlement, native API URL, and location background mode for controlled testing.

### Maps capability decision

Do not enable the separate `com.apple.developer.maps` capability shown as **Maps** in the Developer portal. Apple documents that entitlement as deprecated, available only for macOS 10.9 through 10.11, and no longer required for using Maps. It does not connect NavOSS to the Apple Maps app and is unrelated to the CarPlay Navigation App entitlement.

MapKit is a framework that can embed Apple map imagery, annotations, search, and other location features in an app. Modern iOS MapKit use does not require `com.apple.developer.maps`. NavOSS currently uses MapLibre and OpenFreeMap on the phone and in its native CarPlay spike, so enabling the deprecated Maps entitlement provides no benefit. Any future MapKit or Apple Maps URL integration should be evaluated as a separate product, data-source, privacy, and attribution decision.

## Why Foreground JavaScript Is Not Enough

NavOSS moved active navigation out of foreground JavaScript because a production navigation app needs native location processing and route matching:

- CarPlay must remain usable while the iPhone is locked and inaccessible.
- The phone and multiple CarPlay scenes may connect or disconnect independently.
- Guidance, rerouting, speech, and arrival must continue when the React Native UI is suspended.
- The displayed vehicle position should be map-matched while raw location remains available for off-route detection.
- CarPlay expects regular maneuver and travel-estimate updates from an active native navigation session.

The native navigation service now satisfies this ownership requirement; React installs a route only after explicit Start and consumes versioned native snapshots.

## Native Components

### Current continuation status

The entitlement-free native slice lives in `apps/mobile/modules/navoss-navigation`. It provides an autolinked iOS Expo module, deterministic Swift tests, route geometry ownership, course-aware and route-continuous segment scoring, raw and matched coordinates, route progress, horizontal-accuracy input, accuracy-aware off-route confirmation and recovery hysteresis, native reroute execution, spoken maneuver guidance, conservative endpoint arrival confirmation, transient active-route recovery, and typed snapshot events. The phone UI consumes versioned native state and uses its matched coordinate during active guidance. A sticky native `arrived` phase ends guidance and drives the phone completion panel.

The shared native trip store now accepts a validated route, destination, steps, and live guidance summaries from the phone. It owns CarPlay connection state and emits vehicle-side cancellation back to React Native. The main CarPlay scene observes this store, restores an active trip when the display reconnects, draws the route through MapLibre Native, starts `CPNavigationSession`, and updates structured maneuvers and travel estimates. The entitlement and scene remain build-time gated.

The main-display renderer now consumes the same monotonic native route progress as the phone. During active guidance it removes travelled geometry, anchors the remaining route at the matched road position, renders the shared NavOSS vehicle arrow instead of a generic dot, follows matched course with a forward-biased tilted camera, and clears stale route or vehicle layers on arrival, cancellation, preview, and reconnect transitions. Route previews show the selected green route, a muted alternate, and the destination marker. The basemap follows CarPlay light and dark appearance using the same Liberty and Dark OpenFreeMap styles as the phone.

Normal builds omit the CarPlay scene and entitlement but retain active-navigation background location for phone guidance. Native location runs during active navigation, while CarPlay needs a current origin, and for as long as a CarPlay display is connected. When in Use authorization and iOS's visible background indicator are used; Always authorization is not requested. The current active route is stored only for operating-system recovery and erased on End or confirmed arrival.

A connected display, from either the template scene or the Dashboard scene alone, also holds a `CLBackgroundActivitySession`. Under When in Use authorization that session is what keeps location flowing after the phone's screen sleeps, and without it the CarPlay map froze until the phone was physically woken, since the driver's phone is normally locked in a pocket or cradle. The design assumes that session is process-wide, so it also keeps MapLibre's own location manager delivering and the idle map needs no separate position feed. That assumption is unverified on a head unit and is the thing to check first if the idle map still stalls. Publishing a position through the shared trip store instead would be actively harmful: every fix posts a state change whose no-trip branch cancels in-flight route planning and hides trip previews. Idle phone use deliberately holds no session: the map is not visible then, so it would cost battery and show the background indicator for nothing. The accepted cost is that a connected CarPlay session holds navigation-grade location for its whole duration, including while the driver is using another app on the head unit.

### CarPlay Dashboard scene

`NavOSSCarPlayDashboardSceneDelegate` conforms to `CPTemplateApplicationDashboardSceneDelegate` and installs a separate MapLibre view in the Dashboard-owned window. It observes the shared trip and preference stores and renders route progress without starting another `CPNavigationSession`. While idle, its own map requests user location immediately so the Dashboard does not depend on opening the main CarPlay scene first. Go and Voice stage a one-shot action, activate the `.carTemplateApplication` scene role explicitly on iOS 17 and later, and drain the action only after that scene has an interface controller; Go opens Places and Voice opens Search. This prevents cold-start scene ordering from silently dropping either shortcut. Disconnect removes observers and deactivates the map view. Dashboard availability and tile selection remain controlled by CarPlay, not NavOSS.

### Navigation service

`NavOSSNavigation` owns after explicit Start:

- The selected route. Route alternatives remain preview state until one is selected.
- Raw and map-matched location.
- Current route segment and remaining geometry.
- Current and upcoming maneuvers.
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
5. Configure approved map controls and navigation actions.
6. Subscribe to `NavOSSNavigation` snapshots.

Apple does not permit arbitrary controls or React Native overlays in the base map view. Alerts, buttons, lists, search, trip previews, and guidance use CarPlay templates.

### Dashboard scene

`NavOSSCarPlayDashboardSceneDelegate` conforms to `CPTemplateApplicationDashboardSceneDelegate` and renders a second native MapLibre view into the dashboard window.

The scene manifest includes `CPSupportsDashboardNavigationScene`,
`CPTemplateApplicationDashboardSceneSessionRoleApplication`, and the Dashboard scene delegate.
While navigating, Dashboard receives the same matched location, route, and camera state as the
main display. When idle, it exposes the Go and Voice shortcuts allowed by `CPDashboardController`.

CarPlay owns Dashboard navigation-widget selection. NavOSS cannot declare itself the default or
force its Dashboard scene to connect, but it must advertise Dashboard navigation eligibility. A
route-choice preview is not active navigation: Apple calls
`selectedPreviewFor` while the sheet is visible, and NavOSS starts `CPNavigationSession` only after
the user taps Go and CarPlay calls `startedTrip`. Returning Home before Go can therefore leave the
previous navigation app in the widget. During an active NavOSS trip, CarPlay may promote NavOSS to
the navigation widget. iOS does not expose the region-limited default Navigation setting in Canada.

### Instrument cluster and HUD

NavOSS will provide CarPlay with structured turn-by-turn metadata rather than trying to draw arbitrary cluster UI. On supported OS and vehicle combinations this includes route segments, current segment, maneuver state, road-name variants, lane guidance, and travel estimates. Availability checks are required because display support is vehicle-dependent and some current APIs remain beta.

CarPlay Ultra is a vehicle and system integration. NavOSS can participate through supported CarPlay framework surfaces, but cannot reproduce Apple's system UI or promise instrument-cluster maps on every vehicle.

## User Flows

### Google Maps and Waze comparison

Physical phone comparisons and the live wireless CarPlay session show that NavOSS now has the
essential Apple navigation lifecycle, but not yet the information density or data breadth of mature
navigation products. The comparison is used to prioritize driving decisions, not to copy branded
UI or bypass CarPlay templates.

NavOSS matches the core interaction contract with native search, route alternatives, Start/End,
remaining-route trimming, matched heading, maneuver estimates, rerouting, arrival, and reconnect
continuity. The driving map also provides follow and full-route overview modes, adaptive camera
distance near maneuvers, guidance mute, automatic light/dark styles, and reduced 3D building clutter
during guidance. Persistent zoom controls remain available only while idle or previewing; active
guidance reserves its limited map-button surface for End, overview/follow, and sound.

The **Trip** screen exposes Add stop and View routes without replacing guidance immediately. Both
flows calculate alternatives from the current position, preserve route preferences and unvisited
waypoints, and keep the original trip active until the driver confirms **Go**. Cancel restores the
unchanged active trip.

Search and Settings are direct map controls while idle or parked, so neither depends on a navigation
bar that CarPlay may hide. Settings persists Automatic, Light, or Dark map appearance, North up or
Heading up orientation, avoid-highways/tolls/ferries/unpaved route preferences, and one of three
audio modes: All guidance speaks maneuvers and camera alerts; Alerts only suppresses maneuver speech
but keeps camera alerts; Muted suppresses both. Active guidance exposes End, overview/follow, sound
settings, and Report.

Phone and CarPlay controls read the same native preference store and receive local change events.
Future-route defaults remain separate from the preferences captured by an already active trip.

CarPlay reports use the same eight safety-oriented labels as the phone. They are bounded native
drafts with precise coordinate, creation time, and two-hour expiry. They remain private on the
device and are not shown to other drivers; no police/checkpoint option or free text exists. This is
an explicit testing state until the trust, moderation, rate-limit, confirmation, and expiry backend
is implemented.

The remaining gaps are primarily data and platform capabilities:

- live traffic, incident-aware ETA, closures, and traffic-coloured routes require a licensed feed;
- lane guidance, junction views, and signpost text require normalized provider data that is not
  present in the current route contract; posted speed limits already use geometry-aligned
  Valhalla/OpenStreetMap annotations and hide unknown values;
- public crowd reports require the planned trust, moderation, expiry, and anti-abuse backend;
- richer place imagery, ratings, entrances, and parking context require separately licensed data;
- Dashboard, cluster, HUD, and CarPlay Ultra surfaces remain vehicle- and entitlement-dependent.

NavOSS must not invent any of these signals. Until their source and quality gates exist, the
CarPlay experience should stay quieter than Google Maps or Waze rather than imply unavailable
traffic, lane, speed, or incident knowledge.

### Destination search

- Use `CPSearchTemplate` for bounded destination search.
- Label the root destination action **Search**, not Places.
- The Search list mirrors the phone's useful discovery groups with nearby Restaurants, Coffee,
  Bars, Gas, Groceries, Parking, Pharmacies, Parks, Shopping, Hotels, Attractions, Hospitals and
  clinics, Charging stations, Car repair, and Car wash. Typed category intent is preserved for
  restaurants, groceries, and parks so strict server filtering still applies.
- Show recents and locally stored favorites without requiring phone interaction.
- Keep result rows concise and provide clear no-network and degraded-provider states in CarPlay.
- Do not direct a moving driver to finish setup on the phone.

### Route preview

- Convert normalized alternatives into `CPTrip` and `CPRouteChoice` objects.
- Use `CPMapTemplate.showTripPreviews` for route selection.
- Draw selected and alternate route geometry in the native MapLibre view.
- Fit the full selected route with 68% of the map width reserved for the route-choice sheet, expand
  route bounds by 50%, cap preview zoom at 8.5, and
  use a 4-point route with a 7-point casing so the physical 800×480 display retains regional
  context without obscuring road choices.
- Mark both preview endpoints independently: green for the route origin and blue for the
  destination. Do not rely on the route stroke or MapLibre user-location layer to make either
  endpoint discoverable beneath CarPlay chrome.
- Include real duration, distance, and major-road summaries.
- Continue to state that live traffic is unavailable until a real traffic source exists.

### Driving map

- Current speed comes directly from valid Core Location speed and is shown in km/h during active
  guidance.
- Posted speed limits come from geometry-aligned Valhalla/OpenStreetMap `maxspeed` annotations.
  NavOSS selects the nearest matched route segment and hides the sign for unknown or unlimited
  values rather than inferring a limit from road class.
- The CarPlay compass ornament is hidden because heading-up guidance and the explicit overview/follow
  control already provide orientation without colliding with template controls.
- Vehicle position and course interpolate only between received matched GPS updates. NavOSS does not
  extrapolate or predict movement beyond the latest real position.
- When Go arrives before a publishable GPS position, enter follow mode at the selected route origin
  and preserve that position across later nil-position snapshots. Replace it as soon as a real
  matched or raw location is published.
- Settings persist Automatic/Light/Dark appearance, All guidance/Alerts only/Muted audio, visible or
  hidden basemap points of interest, and Arrow/Car vehicle marker choices.

### Active guidance

- Seed the first active CarPlay position from the same fresh Core Location sample used to request
  routes, so tapping Go enters follow mode immediately instead of waiting for another GPS callback.

- Start a `CPNavigationSession` from the selected `CPTrip`.
- Keep at least one `CPManeuver` in `upcomingManeuvers`.
- Update `CPTravelEstimates` for the trip and current maneuver as native progress changes.
- Publish lane and route-segment metadata where available.
- Pause, resume, cancel, finish, and reroute through the matching CarPlay session APIs.
- Coordinate spoken guidance with the vehicle audio session without taking over overall volume.

An active native trip always exposes an explicit End action. The root map places an
`xmark.circle.fill` control first in its four-button map control list, so it remains available when
CarPlay hides the navigation bar or reduces the visible controls. The Places screen becomes a
Current trip screen with both an **End** bar button and an **End navigation** row. If a trip starts
from the phone while CarPlay search is open, CarPlay returns to the root map so the End control is
immediately reachable. These controls and Apple's built-in cancel callback share one idempotent
teardown path that cancels route/search work, clears previews, maneuvers, map overlays, and native
navigation state, stops background guidance, and notifies the phone.

### Share ETA and Contacts decision

The phone experience uses the operating system share sheet for a static ETA message containing only the destination name, estimated arrival, remaining time, and remaining distance. It does not read Contacts, request Contacts permission, expose current coordinates or route geometry, create a tracking link, or maintain a recipient list. Apple's share sheet may suggest recent recipients without making those contacts available to NavOSS.

Do not add a custom recent-contacts browser to the CarPlay navigation app. Contacts access would require a purpose string and explicit limited or full authorization, and arbitrary contact browsing is not an approved `CPMapTemplate` navigation surface. The current CarPlay scene can search, preview, and start its own route, or continue a route started on the phone. Share ETA remains omitted from the vehicle display to keep the first tester slice focused and low-distraction.

A CarPlay Share ETA control remains gated until the native route/background lifecycle is complete and Apple documentation or review confirms a template-compliant, low-distraction interaction. It must not direct a moving driver to complete the action on the phone. Prefer a system-owned communication flow that does not reveal contacts to NavOSS; otherwise omit the control from CarPlay and keep system sharing on the phone.

## Map Rendering

MapLibre React Native 11.3.6 already links MapLibre Native 6.26.0 into the iOS application target using Swift Package Manager. The CarPlay scene can therefore import MapLibre and instantiate a native map view without adding a second map SDK.

Each display owns its own map view and camera, but all displays consume the same native navigation snapshot. Styles must support:

- Light and dark CarPlay appearances.
- Standard, portrait, minimum-size, and ultrawide displays.
- High contrast in direct sunlight and at night.
- Stable route casing, congestion patterns when real traffic exists, and a clearly visible matched-location puck.

The checked-in Expo plugin packages the same `vehicle-arrow.png` used by the phone into the native app target. Simulator builds compile and link the CarPlay scene, but Xcode 26.6 strips the restricted CarPlay entitlement from ordinary ad hoc simulator signatures on this machine. The automated navigation harness therefore mounts the exact production `NavOSSCarPlayMapViewController` in a simulator-only phone window and captures deterministic preview, progress, appearance, and cleanup states. Vision OCR, pixel metrics, hashes, and perceptual comparisons reject blank, duplicated, stale, or permission-obscured frames. The visual entrypoint is compiler-gated to Simulator and absent from device binaries.

This renderer simulation complements rather than replaces CarPlay framework testing. Native tests validate shared trip state, route trimming, controls, and lifecycle; a signed TestFlight build and a real wired or wireless CarPlay system remain required to validate `CPMapTemplate` chrome, vehicle input, connection/reconnection, and head-unit-specific behavior.

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
