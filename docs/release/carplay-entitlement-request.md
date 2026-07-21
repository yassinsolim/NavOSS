# CarPlay navigation entitlement request

Date prepared: 2026-07-20

Status: Approved by Apple on 2026-07-21

## Approval outcome

Apple enabled the **CarPlay Navigation App** additional capability for `org.navoss.mobile`. The approved entitlement key is `com.apple.developer.carplay-maps`, with Development, Ad Hoc, and App Store Connect provisioning support.

The approval is recorded, but CarPlay remains disabled in normal NavOSS builds. The current native scene is a compile spike whose destination actions still report that route loading is unavailable. Enable the scene and entitlement flags only in a dedicated build after native route loading, background navigation, maneuvers, estimates, and reconnect behavior are implemented and tested.

The separate deprecated `com.apple.developer.maps` capability is not required for CarPlay, MapKit, or connecting to Apple Maps and should remain disabled.

## App Type

Navigation (turn-by-turn directions)

## Tell us about your app

NavOSS is an account-free, privacy-first turn-by-turn navigation app beginning with Calgary, Alberta. The current iPhone app provides Calgary place and address search, route alternatives, an avoid-highways option, map-matched route progress, maneuver guidance, automatic rerouting, arrival detection, and official fixed intersection-safety-camera information from City of Calgary Open Data. NavOSS uses OpenStreetMap-derived map, search, and routing data with visible attribution and does not include advertising, commerce, messaging, social networking, or live-traffic claims.

NavOSS is being developed as an open-source navigation product with an original interface and native iOS navigation core. CarPlay will be an extension of the same active navigation session, designed primarily for navigation and to minimize driver interaction. The phone will not need to be physically operated while the app is in CarPlay mode.

## What specific CarPlay features do you plan to implement?

NavOSS will use Apple CarPlay templates and a native MapLibre map. The initial CarPlay experience will include:

- a full-screen `CPMapTemplate` showing the selected route and map-matched vehicle position;
- destination selection for Home, Work, recent searches, and saved favorites using `CPListTemplate`;
- Calgary place and address search using `CPSearchTemplate`;
- route alternatives with distance and estimated travel time using `CPTrip` and the CarPlay route-preview flow;
- starting, canceling, and rerouting a trip entirely from the CarPlay display without requiring interaction with the iPhone;
- turn-by-turn maneuvers, remaining distance, travel-time estimates, and arrival state through `CPNavigationSession`;
- spoken maneuver guidance and concise route-ahead notices, including official fixed safety-camera information where applicable;
- automatic rerouting after a confirmed departure from the route and continuity when CarPlay connects or disconnects during a trip; and
- CarPlay Dashboard and supported instrument-cluster or head-up-display route guidance where the vehicle and CarPlay APIs support those surfaces.

All controls and overlays will use Apple-provided CarPlay templates. NavOSS will not display messaging, commerce, social networking, gaming, a web browser, or unrelated settings in CarPlay. Interactions will be limited to short, driver-relevant navigation tasks.

## App Store URL

Leave blank. The App Store Connect record exists under Apple ID `6792619727`, but NavOSS does not yet have a public App Store product-page URL.

## Screenshots

Upload these three JPG files after they are generated in `docs/release/carplay-request/`:

1. `01-calgary-map-and-search.jpg`: account-free Calgary map, search, and official camera coverage.
2. `02-route-preview.jpg`: selected destination, route geometry, route choice, ETA, and distance.
3. `03-active-guidance.jpg`: active route, maneuver banner, matched vehicle position, remaining time, and arrival estimate.

The screenshots are current iPhone navigation evidence. They are not mock CarPlay screens and do not claim that the entitlement-gated CarPlay experience is already distributed.

## Addendum checkpoint

The Account Holder must personally decide whether to accept Apple's CarPlay Entitlement Addendum. The implementation is designed around its stated requirements: navigation is the primary CarPlay purpose, the interface minimizes driver distraction, no physical phone interaction is required in CarPlay mode, and no gaming, commerce, social networking, texting, messaging, or unrelated functionality is exposed on the vehicle display.
