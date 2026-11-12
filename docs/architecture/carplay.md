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

This preserves one route and one navigation session across the phone, the main CarPlay display, CarPlay Dashboard, and, where the vehicle offers one, the instrument cluster or head-up display.

## External Gate

CarPlay navigation is a managed Apple capability. The app needs the Boolean entitlement:

```xml
<key>com.apple.developer.carplay-maps</key>
<true/>
```

Apple approved the CarPlay Navigation App capability for the explicit App ID `org.navoss.mobile` on 2026-07-21. The Developer portal now exposes `com.apple.developer.carplay-maps` for Development, Ad Hoc, and App Store Connect provisioning.

The approved capability removes the entitlement blocker, not the field-validation gate. A dedicated
build can continue an active phone route onto the main CarPlay display with a native route line,
`CPNavigationSession`, maneuvers, travel estimates, arrival, reconnect state, and vehicle-side
cancellation. During active CarPlay guidance, the phone shows a compact next-maneuver card and a
scrollable list of remaining maneuvers. The live first distance follows native progress; later
distances describe the legs leading to those maneuvers. Instructions wrap without hiding the road
name. At standard text sizes, ETA, destination, and End remain outside the scrolling list. At
accessibility text sizes, the header, full-width maneuver cards, and untruncated trip summary scroll
together so they cannot squeeze the directions viewport away; a full-width End remains fixed below.
Arrival exposes Done with the same layout rules.

Connecting CarPlay while idle, loading, viewing a preview, or handling a route error preserves the
phone's interactive map and its search, Retry, Cancel, and Start controls. Those planning states are
not discarded on connect. A connected active trip whose maneuver is not yet resolved instead shows
an explicit waiting state with End; it does not claim the app is idle or trap the user without an
exit. End and confirmed arrival return to the appropriate actionable phone surface.

The native navigation service now owns active Core Location updates, map matching, maneuver progression, spoken guidance, background continuation, rerouting, arrival, and transient active-route recovery. CarPlay search uses the private NavOSS API, previews route alternatives with approved templates, and starts navigation without phone interaction. A Dashboard scene renders the shared route and guidance state without creating a second navigation session, with Go and Voice shortcuts that activate the main CarPlay scene. Apple decides which navigation app occupies the Dashboard tile; Voice opens NavOSS search and is not a custom Siri speech recognizer. Instrument-cluster rendering and maneuver metadata are implemented; real-vehicle Dashboard and cluster validation remain incomplete. Normal production builds remain unchanged; the dedicated `production-carplay` profile enables the scenes, entitlement, native API URL, and location background mode for controlled testing.

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

Phone and CarPlay order route alternatives by the whole-minute duration shown to the driver,
then by shorter distance when those displayed durations tie, then by precise duration. The
underlying duration, geometry, and route identifier are unchanged. The Fastest label and relative
time descriptions still use the true lowest-duration route, independently of list position.
Both clients apply the presentation ordering to validated responses so the behavior does not
depend on a coordinated API deployment.

Normal builds omit the CarPlay scene and entitlement but retain active-navigation background location for phone guidance. Native location runs during active navigation, while CarPlay needs a current origin, and for as long as a CarPlay display is connected. When in Use authorization and iOS's visible background indicator are used; Always authorization is not requested. The current active route is stored only for operating-system recovery and erased on End or confirmed arrival.

A connected display, from either the template scene or the Dashboard scene alone, also holds a `CLBackgroundActivitySession`. Under When in Use authorization that session is what keeps location flowing after the phone's screen sleeps, and without it the CarPlay map froze until the phone was physically woken, since the driver's phone is normally locked in a pocket or cradle. TestFlight build 70 verified on a real car that the design's prior assumption — that the session is process-wide and also keeps MapLibre's own location manager delivering — does not hold: the idle map still opened on its hard-coded Calgary default and never moved. `NavOSSCarPlayMapViewController` now supplies `MLNMapView.locationManager` with `NavOSSCarPlayLocationManager`, a custom `MLNLocationManager` (the protocol's own documentation notes a conforming type need not be `CLLocationManager`-backed at all) wrapping a `CLLocationManager` configured with `allowsBackgroundLocationUpdates`, independently of whatever keeps any other manager's session alive. The main scene's `didConnect` also starts `setCarPlayConnected` before the first `recenter()`, which previously ran first and found no cached fix from either source. Publishing a position through the shared trip store instead would still be actively harmful: every fix posts a state change whose no-trip branch cancels in-flight route planning and hides trip previews. Idle phone use deliberately holds no session: the map is not visible then, so it would cost battery and show the background indicator for nothing. The accepted cost is that a connected CarPlay session holds navigation-grade location for its whole duration, including while the driver is using another app on the head unit.

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

Two separate mechanisms reach a vehicle's cluster or head-up display, and NavOSS uses both through
public API under the existing `com.apple.developer.carplay-maps` entitlement:

- **Navigation metadata.** The main scene adds every route maneuver to its `CPNavigationSession`
  when guidance starts (`addManeuvers`, iOS 17.4+), with `maneuverType`, `junctionType`,
  geometry-measured `junctionExitAngle`, `trafficSide`, road-following names, highway exit labels
  when the route supplies them, `currentRoadNameVariants`, speed-aware `maneuverState`, and
  per-maneuver and trip `CPTravelEstimates`. Lane guidance is added with `addLaneGuidances` and
  linked to its maneuver on iOS 18+, only when the route carries lanes. The vehicle renders this
  metadata itself; NavOSS draws nothing for it.
- **Cluster map.** `NavOSSCarPlayInstrumentClusterSceneDelegate` implements
  `CPTemplateApplicationInstrumentClusterSceneDelegate` (iOS 15.4+). The plugin registers the
  `CPTemplateApplicationInstrumentClusterSceneSessionRoleApplication` configuration and sets
  `CPSupportsInstrumentClusterNavigationScene`. When the car connects a cluster window, NavOSS
  installs its own map view controller showing the shared route, vehicle, and maneuver arrow. It
  handles the car's zoom controls, follows `contentStyle`, hides its own speed badge because the
  cluster already has a speedometer, and draws the speed-limit sign only while the vehicle's cluster
  speed-limit setting is not Disabled.

Whether a cluster or HUD connects is the vehicle's decision; most CarPlay systems have neither, and
Xcode's Simulator cannot show one. Apple's separate CarPlay Simulator app can. CarPlay Ultra is a
vehicle and system integration that NavOSS cannot reproduce. It participates only through these
framework surfaces.

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
settings, and Trip actions; reporting is available from the Current trip list.

Phone and CarPlay controls read the same native preference store and receive local change events.
Future-route defaults remain separate from the preferences captured by an already active trip.

CarPlay voice search starts only from its microphone control. Microphone and Speech Recognition
permission prompts appear on the iPhone; approval is not a guarantee that an on-device recognizer
or vehicle input route is available. Recording requires an available on-device recognizer and never
falls back to cloud recognition. Transient recording-start failures have a short bounded retry;
permanent failures retain an actionable error. Recording uses the `.record` category in the
`.default` mode. `.measurement` was dropped because it turns off the system's gain control and noise
suppression, which a car microphone needs over road noise. After activation, NavOSS explicitly
prefers the car's `CarAudio` input, then a Bluetooth hands-free microphone, then a headset, then the
iPhone. Every voice failure opens a list with **Try voice search again**, **Type a destination**,
and **Home, Work, and recents**, so a phone without an on-device English recognizer still reaches a
destination. A recognized query opens its results list immediately in a searching state and fills
it in place.

### Siri

`NavigateWithNavOSSIntent` (App Intents, iOS 16+) and the `NavOSSAppShortcuts` provider support
"Navigate to _place_ with NavOSS", "Take me to _place_ with NavOSS", and "Navigate with NavOSS",
which asks "Where to?". Places resolve from Home, Work, saved places, and recents first. Other
names go to the NavOSS search API near the current position. When CarPlay is connected, the intent
shows routes to the place on the car screen. It brings the main CarPlay scene forward if needed and
replaces nothing until the driver taps Go. During a trip it offers the place as a new destination.
Without CarPlay, Siri replies that CarPlay is needed and does not open the phone UI. Limits:

- Siri itself, not NavOSS, processes the spoken phrase.
- App Shortcut phrases can match free-form place names only through the entity query.
- Apple Maps-style "Navigate to X" without "with NavOSS" goes to the user's default navigation app.
  Third-party apps cannot claim that phrase.
- The intent ships only in CarPlay-enabled builds, because the plugin copies it with the CarPlay
  sources.

The navigation service is the sole owner of shared audio-session deactivation. Recording leases
block speech cleanup from releasing an active microphone session. Completing or failing capture
returns ownership to the service, including when queued speech is stale. A failed deactivation keeps
its release obligation and retries with a capped delay until success or a new owner supersedes it;
there is no terminal retry cutoff. Epoch checks precede any operating-system call so stale work
cannot deactivate a newer owner. This prevents an assumed or abandoned release from leaving other
audio ducked.

CarPlay reports use the same eight safety-oriented labels as the phone. During guidance the Report
map button opens an eight-tile grid, and one more tap saves the report and returns to the map with
a three-second confirmation. Reports are bounded native drafts with precise coordinate, creation
time, and two-hour expiry. They remain private on the device and are not shown to other drivers; no
police/checkpoint option or free text exists. This is an explicit testing state until the trust,
moderation, rate-limit, confirmation, and expiry backend is implemented.

The map is ready for data it does not have yet. Each of these inputs is optional and renders
nothing while absent:

- `NavOSSCarPlayTrip.congestion: [NavOSSCarPlayCongestionLevel]?` (one level per geometry segment)
  colours slow, heavy, and stopped stretches of the remaining route;
- `NavOSSCarPlayMapAlertStore.shared.publish([NavOSSCarPlayMapAlert])` draws camera and report
  markers;
- `NavOSSCarPlayRouteStep.lanes`, `maneuverModifier`, `roundaboutExit`, `exitNumber`, `signpost`,
  `signpostBranch`, `signpostToward`, `junctionName`, `currentRoadName`, `bearingBeforeDegrees`,
  and `bearingAfterDegrees` mirror the route contract's `/v2/routes` step enrichment and feed lane guidance, maneuver symbols, exit labels, and the current-road pill.

The remaining gaps are primarily data and platform capabilities:

- nothing publishes congestion or map alerts yet. Live traffic, incident-aware ETA, closures, and
  shared reports need real sources first;
- the native route client does not yet request or decode the enriched route contract, so lanes,
  modifiers, exits, and signposts are absent at runtime. Maneuver types and roundabout exits are
  read from the provider's instruction text, and turn angles are measured from route geometry;
- public crowd reports require the planned trust, moderation, expiry, and anti-abuse backend;
- richer place imagery, ratings, entrances, and parking context require separately licensed data;
- Dashboard, cluster, HUD, and CarPlay Ultra surfaces remain vehicle-dependent and unvalidated on
  a real car.

NavOSS must not invent any of these signals. Until their source and quality gates exist, the
CarPlay experience should stay quieter than Google Maps or Waze rather than imply unavailable
traffic, lane, speed, or incident knowledge.

### Destination search

- The Search grid puts Home, Work, Recents, and Saved first, then Gas, Coffee, Food, and Parking.
  Its navigation bar holds Categories, Keyboard, and Microphone, and Categories lists every nearby
  category.
- Typed search waits about 280 ms after the last keystroke before asking the API. A superseded
  keystroke receives the previous results instead of an empty list, and the keyboard's Search key
  opens the full result list.
- Category results open immediately in a searching state. They are ordered nearest first, and each
  row shows its straight-line distance and label. Empty, offline, and location-unavailable results
  each show a message and a way forward.
- Home or Work that is not set, and empty Recents or Saved lists, explain how to fill them and
  offer search instead of ending there.
- Keep result rows concise and do not direct a moving driver to finish setup on the phone.

### Route preview

- Convert normalized alternatives into `CPTrip` and `CPRouteChoice` objects.
- Use `CPMapTemplate.showRouteChoicesPreview` for route selection, with Go (new trip) or Use
  route (a change to the active trip), Routes, and Overview buttons.
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

- The follow camera is course-up, or north-up from Settings, with the vehicle in the lower part of
  the view. Speed sets the viewing distance, from 550 m when stopped to about 1.1 km at 100 km/h,
  capped at 1.35 km. An approaching maneuver pulls it closer. Pitch eases between 50° close in and
  36° far out. Distance, pitch, and heading ease toward their targets with frame-rate-independent
  time constants, so speed changes, the next maneuver, and corners never snap the view.
- The render loop is bound to the car's screen and requests 60 fps (30 fps minimum). It keeps
  running until both the vehicle and the camera have settled, then stops until the next fix.
- During guidance the camera centres in the area beside CarPlay's guidance card, using the window's
  horizontal safe-area insets. It ignores the top inset, which changes whenever the navigation bar
  appears.
- The route is drawn as the NavOSS teal-green line with a casing. The full route is drawn grey
  underneath, so road already driven reads as travelled. Alternates are grey with their own casing.
- Within 1 km of the next maneuver, a white arrow with a dark outline is drawn on the road through
  the turn. It follows a roundabout's circulation to the exit.
- Road-name labels are enlarged by about 22% with a stronger halo during guidance and restored
  afterwards. POIs and 3D buildings hide during guidance.
- The current-road pill sits at the bottom centre of the live safe area. It shows only while
  following and only when the route names the road.
- Current speed comes directly from valid Core Location speed and is shown in km/h in a round badge
  during active guidance. It turns red at 5 km/h or more over a known posted limit; the tolerance is
  an input for a future setting. The posted limit is a black-on-white MAX sign beside it.
- The main-display speed and speed-limit readouts anchor to the map content's top-right bounds,
  independently of transient template safe-area insets. They follow a real content resize but do not
  move when chrome appears or disappears. Dashboard rendering keeps its own safe-area behavior.
  When no posted limit is available, the current-speed badge occupies the rightmost slot instead of
  reserving empty space for the hidden limit; a returning limit restores the original badge order.
- Posted speed limits come from geometry-aligned Valhalla/OpenStreetMap `maxspeed` annotations.
  NavOSS selects the nearest matched route segment and hides the sign for unknown or unlimited
  values rather than inferring a limit from road class.
- In Automatic appearance the map follows the vehicle's suggested `contentStyle` (iOS 15.4+), which
  the car changes for night or headlights, before the window's own trait collection.
- The CarPlay compass ornament is hidden because heading-up guidance and the explicit overview/follow
  control already provide orientation without colliding with template controls.
- Vehicle position and course interpolate only between received matched GPS updates. NavOSS does not
  extrapolate or predict movement beyond the latest real position.
- When Go arrives before a publishable GPS position, enter follow mode at the selected route origin
  and preserve that position across later nil-position snapshots. Replace it as soon as a real
  matched or raw location is published.
- Settings persist Automatic/Light/Dark appearance, All guidance/Alerts only/Muted audio, visible or
  hidden basemap points of interest, and Arrow/Car vehicle marker choices. Choosing a sound mode
  from the driving map's sound button returns straight to the map.

### Active guidance

- Seed the first active CarPlay position from the same fresh Core Location sample used to request
  routes, so tapping Go enters follow mode immediately instead of waiting for another GPS callback.
- Start a `CPNavigationSession` from the selected `CPTrip` and add every maneuver to it up front.
- Turn-card symbols are drawn from the maneuver kind and the exit angle measured from route geometry.
  Slight, normal, and sharp turns, keep and fork, ramps, U-turns, and roundabouts each look like the
  junction; roundabouts show the circulation to the numbered exit. Instruction variants add the
  signpost and the road name when the route has them.
- `upcomingManeuvers` holds the next maneuver. It also holds the one after it ("then") when the
  second follows within 250 m.
- `maneuverState` is speed-aware: execute within max(60 m, 6 s of travel), prepare within
  max(400 m, 25 s), and continue beyond 2 km.
- `currentRoadNameVariants` is the road being driven, taken from the step in progress. It used to be
  the upcoming road.
- `CPLaneGuidance` is set as `currentLaneGuidance` only during prepare and execute, and only when
  the route supplies lanes.
- Per-maneuver estimates count down to the next maneuver. Each maneuver's `initialTravelEstimates`
  is its full leg, and trip estimates use the remaining distance and time.
- Arrival pauses the trip with the destination name and a persistent "You've arrived" alert with
  Done (ends the trip) or Keep map. A new route for the same destination while guiding is announced
  with a short "New route" alert. Only one navigation alert shows at a time; a newer message
  replaces the older one instead of being dropped.
- Coordinate spoken guidance with the vehicle audio session without taking over overall volume.

Not yet used: `CPRouteSegment` and `resumeTrip(updatedRouteSegments:currentSegment:rerouteReason:)`
(iOS 26.4) for reroutes. A reroute currently adds the new route's maneuvers to the running session.

An active native trip always exposes an explicit End action. During guidance the four map buttons
are End, Overview/Follow, Sound, and Report. The navigation bar's **Trip** button, which CarPlay
reveals on any touch, opens the Current trip list: Add stop, Stops, Change destination, View routes,
Report, and End navigation, plus an **End** bar button. **Stops** lists the remaining stops in
order. Choosing one offers Remove stop or Move earlier, then shows recalculated alternatives; the
current trip keeps guiding until the driver chooses a route. If a trip starts from the phone while
CarPlay search is open, CarPlay returns to the root map so the End control is immediately reachable.
These controls and Apple's built-in cancel callback share one idempotent teardown path. It cancels
route and search work, clears previews, maneuvers, map overlays, and native navigation state, stops
background guidance, and notifies the phone.

### Resume, reconnect, and stale templates

- Returning to NavOSS from another CarPlay app or a call keeps the template stack and an open route
  preview with its choices. Earlier builds popped to the root map on every activation and discarded
  the preview. A preview is dropped only when a trip started on the phone while NavOSS was away, or
  when the trip it was replacing ended. The preview's location lease is released while away and
  taken again on return.
- Searches and route requests started before switching away keep running, and their results are
  waiting on return.
- The Current trip list refreshes on return and on every trip change, so it never offers actions
  for a trip that ended elsewhere.
- Reconnecting rebuilds the map, the navigation session, and every maneuver from the shared trip
  store, then drains pending Dashboard and Siri requests.

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

The `hud-wide-chrome` renderer scenario exercises the production anchoring option with real UIKit
layout at 1024- and 1280-point widths, including inset reveal/hide, and is part of the maintained
visual scenario list. `guidance-maneuver` and `guidance-night` render an 800 × 480 CarPlay frame
with a guidance-card inset while approaching a turn: the maneuver arrow, the current-road pill
(asserted), and the speed and limit badges. The night run uses the dark style and is over the limit.
`guidance-annotations` feeds harness-only fixture congestion and camera/report markers through the
optional inputs in overview. `maneuver-symbols` lays out every turn-card symbol for review. The opt-in `audio-release` scenario exercises the real navigation service and
`AVSpeechSynthesizer`: speech activation, interruption by a recording lease, lease release, and
natural speech-completion release. It requires working simulator speech output, records no
microphone input, and is selected with `SIMCTL_CHILD_NAVOSS_CARPLAY_VISUAL_SCENARIO=audio-release`
when launching the simulator app. Unit tests cover repeated release failures and stale owners;
neither those tests nor the simulator scenario verify vehicle-microphone capture or music mixing
on a physical head unit.

## Expo Integration

The implementation is split between a local Expo module and app-target source templates:

```text
apps/mobile/modules/navoss-navigation/
  expo-module.config.json
  index.ts
  ios/
    NavOSSNavigationModule.swift
    Core/CarPlayTrip.swift
    Core/CarPlayGuidancePresentation.swift

apps/mobile/carplay/ios/
    NavOSSCarPlayMapViewController.swift
    NavOSSCarPlayManeuverSymbols.swift
    NavOSSCarPlaySceneDelegate.swift
    NavOSSCarPlayDashboardSceneDelegate.swift
    NavOSSCarPlayInstrumentClusterSceneDelegate.swift
    NavOSSCarPlayVoiceSearchCoordinator.swift
    NavOSSCarPlayVisualHarnessViewController.swift
    NavOSSNavigationIntents.swift
    NavOSSPhoneSceneDelegate.swift

apps/mobile/plugins/with-navoss-carplay.cjs
```

The config plugin configures the native API URL and `location` background mode for every iOS navigation build. When `NAVOSS_CARPLAY_ENABLED=1`, it also:

- Adds the main CarPlay, Dashboard, and instrument-cluster scenes and the Expo-compatible phone
  window scene to `Info.plist`, with `CPSupportsDashboardNavigationScene` and
  `CPSupportsInstrumentClusterNavigationScene`.
- Adds every Swift file in `apps/mobile/carplay/ios` (the plugin's `sourceFiles`) to the
  application target. A unit test fails when that list and the directory disagree. CI's CarPlay
  generated sources job regenerates the project and fails when any copy differs from its source.
- Adds the navigation entitlement only when `NAVOSS_CARPLAY_ENTITLEMENT_ENABLED=1`.

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
