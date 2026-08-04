import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  googlePlacesBuildConfiguration,
  sourceFiles,
} = require('../plugins/with-navoss-carplay.cjs');

describe('Google Places build configuration', () => {
  it('is disabled and keyless by default', () => {
    expect(googlePlacesBuildConfiguration({})).toEqual({ enabled: false });
  });

  it('fails closed when enabled without a key', () => {
    expect(() => googlePlacesBuildConfiguration({ NAVOSS_GOOGLE_PLACES_ENABLED: '1' })).toThrow(
      'GOOGLE_PLACES_IOS_API_KEY is required',
    );
  });

  it('passes the trimmed key only to an enabled build', () => {
    expect(
      googlePlacesBuildConfiguration({
        GOOGLE_PLACES_IOS_API_KEY: '  test-restricted-key  ',
        NAVOSS_GOOGLE_PLACES_ENABLED: '1',
      }),
    ).toEqual({ apiKey: 'test-restricted-key', enabled: true });
  });

  it('keeps default production keyless and provides an explicit Google-enabled profile', () => {
    const eas = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'eas.json'), 'utf8'));

    expect(eas.build.production.env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('0');
    expect(eas.build['internal-carplay']).toMatchObject({
      distribution: 'internal',
      environment: 'production',
      env: {
        NAVOSS_CARPLAY_ENABLED: '1',
        NAVOSS_CARPLAY_ENTITLEMENT_ENABLED: '1',
        NAVOSS_GOOGLE_PLACES_ENABLED: '0',
      },
    });
    expect(eas.build['production-carplay'].env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('0');
    expect(eas.build['production-carplay-google'].env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('1');
    expect(eas.submit['production-carplay-google'].ios.ascAppId).toBe('6792619727');
  });

  it('renders photos, rating count, and reviews in the standard Google place details view', () => {
    const nativeView = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'modules/navoss-navigation/ios/NavOSSGooglePlaceRatingView.swift',
      ),
      'utf8',
    );

    expect(nativeView).toContain('GooglePlacesSwift.PlaceDetailsView(');
    expect(nativeView).toContain('content: [.media(), .rating(), .reviews()]');
    expect(nativeView).not.toContain('AdvancedPlaceDetailsView(');
  });

  it('packages the visual host behind simulator compiler guards', () => {
    expect(sourceFiles).toContain('NavOSSCarPlayVisualHarnessViewController.swift');

    const carPlayScene = readFileSync(
      resolve(import.meta.dirname, '..', 'carplay/ios/NavOSSCarPlaySceneDelegate.swift'),
      'utf8',
    );
    const carPlayMap = readFileSync(
      resolve(import.meta.dirname, '..', 'carplay/ios/NavOSSCarPlayMapViewController.swift'),
      'utf8',
    );
    const visualHarness = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'carplay/ios/NavOSSCarPlayVisualHarnessViewController.swift',
      ),
      'utf8',
    );
    const phoneScene = readFileSync(
      resolve(import.meta.dirname, '..', 'carplay/ios/NavOSSPhoneSceneDelegate.swift'),
      'utf8',
    );
    const navigationModule = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'modules/navoss-navigation/ios/NavOSSNavigationModule.swift',
      ),
      'utf8',
    );
    const navigationService = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'modules/navoss-navigation/ios/NavOSSNavigationService.swift',
      ),
      'utf8',
    );
    const navigationTypes = readFileSync(
      resolve(import.meta.dirname, '..', 'modules/navoss-navigation/index.ts'),
      'utf8',
    );
    const navigationSnapshotContract = navigationTypes.slice(
      navigationTypes.indexOf('export interface NativeNavigationSnapshot'),
      navigationTypes.indexOf('export type NativeCarPlayGuidancePhase'),
    );

    expect(visualHarness).toContain('#if targetEnvironment(simulator)');
    expect(carPlayScene).toMatch(
      /SearchCategory\(\s*category: "fuel",\s*label: "Gas",\s*query: "fuel",\s*systemImageName: "fuelpump\.fill"\s*\)/,
    );
    expect(carPlayScene).not.toContain('SearchCategory(category: nil');
    expect(carPlayScene).toContain('image: UIImage(systemName: category.systemImageName)');
    expect(carPlayScene).toContain('item.accessoryType = .disclosureIndicator');
    expect(carPlayScene).toContain('image: audioModeImage(mode)');
    expect(carPlayScene).toContain('image: appearanceImage(appearance)');
    expect(carPlayScene).toContain('image: vehicleMarkerImage(marker)');
    expect(carPlayScene).toContain('title: "Search"');
    expect(carPlayScene).toContain('titleVariants: ["Recent searches", "Recents"]');
    expect(carPlayScene).toContain('titleVariants: ["Gas stations", "Gas"]');
    expect(carPlayScene).toContain('titleVariants: ["Restaurants", "Food"]');
    expect(carPlayScene).toContain('CPBarButton(image: carPlayImage("keyboard"))');
    expect(carPlayScene).toContain('CPBarButton(image: carPlayImage("mic.fill"))');
    expect(carPlayScene).toContain('let template = CPGridTemplate(\n        title: "Settings"');
    for (const [category, title] of [
      ['routeOptions', 'Route options'],
      ['alertOptions', 'Alert options'],
      ['mapColors', 'Map colors'],
      ['mapOrientation', 'Map orientation'],
      ['mapDisplay', 'Map display'],
      ['volume', 'Volume'],
      ['drivingAvatar', 'Driving avatar'],
    ]) {
      expect(carPlayScene).toContain(`case .${category}: "${title}"`);
    }
    expect(carPlayScene).toContain('header: "Route options"');
    expect(carPlayScene).toContain('header: "Map orientation"');
    expect(carPlayScene).toContain(
      'mapViewController?.applyMapOrientation(preferences.mapOrientation)',
    );
    expect(carPlayScene).toContain('self.preferencesStore.setRoutePreferences(updated)');
    expect(carPlayScene).toContain('preferences: routePreferences');
    expect(carPlayScene).not.toContain('preferences: NavOSSRoutePreferences(),');
    expect(carPlayScene).toContain('text: "Add stop"');
    expect(carPlayScene).toContain('text: "View routes"');
    expect(carPlayScene).toContain('self?.returnToMapAndLoadActiveRouteAlternatives()');
    expect(carPlayScene).toContain('self.showRoutePreviews(routes, replacingActiveTrip: true)');
    expect(carPlayScene.match(/awaitCurrentRouteOrigin\(\)/g)).toHaveLength(3);
    expect(carPlayScene).toContain('Check Location access on your iPhone, then try again.');
    expect(navigationService).toContain('public func awaitCurrentRouteOrigin(');
    expect(navigationService).toContain('try await Task.sleep(nanoseconds: 100_000_000)');
    expect(carPlayScene).toContain('let systemTrip = makeSystemTrip(routes)');
    expect(carPlayScene).toContain(
      'showRouteChoicesPreview(for: systemTrip, textConfiguration: nil)',
    );
    expect(carPlayScene).toContain('let routeChoices = routes.enumerated().map');
    expect(carPlayScene).toContain('additionalInformationVariants: [estimates]');
    expect(carPlayScene).toContain('selectionSummaryVariants: ["\\(summary) · \\(estimates)"');
    expect(carPlayScene).toContain('waypoints: waypoints');
    expect(carPlayScene).toContain('previousNavigationSession?.cancelTrip()');
    expect(carPlayScene).toContain('navigationSession = previousNavigationSession');
    expect(carPlayScene).toMatch(
      /navigationSession = nil[\s\S]*?try NavOSSNavigationService\.shared\.startNavigation\(route\)[\s\S]*?previousNavigationSession\?\.cancelTrip\(\)[\s\S]*?navigationSession = mapTemplate\.startNavigationSession\(for: trip\)[\s\S]*?activeManeuver = nil[\s\S]*?apply\(NavOSSCarPlayTripStore\.shared\.snapshot\(\)\)/,
    );
    expect(navigationModule).toContain('onNavigationPreferencesChanged');
    expect(navigationSnapshotContract).not.toContain('audioMode');
    expect(navigationTypes).toMatch(
      /interface NativeCarPlayState \{\s+connected: boolean;\s+guidance\?: NativeCarPlayGuidance;\s+hasActiveTrip: boolean;\s+\}/,
    );
    expect(navigationTypes).toMatch(
      /interface NativeNavigationPreferences \{\s+audioMode: NativeNavigationAudioMode;\s+routePreferences: NativeRoutePreferences;\s+\}/,
    );
    expect(carPlayScene).toContain('routeChoicesByIdentifier = [:]');
    expect(carPlayScene).toContain('mapTemplate?.hideTripPreviews()');
    expect(carPlayScene).toContain('func sceneDidBecomeActive(_ scene: UIScene)');
    expect(carPlayScene).toContain(
      'interfaceController.popToRootTemplate(animated: false, completion: nil)',
    );
    expect(carPlayScene).toContain('mapViewController?.recenter()');
    expect(carPlayScene).toContain('interfaceController.topTemplate !== mapTemplate');
    expect(carPlayMap).toMatch(
      /else if routeCoordinates\.count >= 2 \{\s*fitRoute\(animated: false\)\s*\} else \{\s*recenter\(\)/,
    );
    expect(carPlayMap).toContain('mapView.bounds.width * 0.60');
    expect(carPlayMap).toContain('previewCoordinatesWithBreathingRoom(routeCoordinates)');
    expect(carPlayMap).toContain('(maximumLatitude - minimumLatitude) * 0.25');
    expect(carPlayMap).toContain('(maximumLongitude - minimumLongitude) * 0.25');
    expect(carPlayMap).toContain('matchedCoordinate: (renderedPosition ?? position)?.coordinate');
    expect(carPlayMap).toContain('routeCoordinates[0] = CLLocationCoordinate2D(');
    expect(carPlayMap).toContain('NSExpression(forConstantValue: activeGuidance ? 11 : 13)');
    expect(carPlayMap).toContain('NSExpression(forConstantValue: activeGuidance ? 7 : 9)');
    expect(carPlayMap).toContain(
      'UIEdgeInsets(top: 56, left: previewSheetInset, bottom: 56, right: 48)',
    );
    expect(carPlayMap).toContain('speedLimitLabel.widthAnchor.constraint(equalToConstant: 38)');
    expect(carPlayMap).toContain('speedLabel.widthAnchor.constraint(equalToConstant: 38)');
    expect(carPlayMap).toContain('shouldEnterFollowMode');
    expect(carPlayMap).toContain('didUpdate userLocation: MLNUserLocation?');
    expect(carPlayMap).toContain('zoomLevel: 15.5');
    expect(visualHarness).toContain('case "idle-location"');
    expect(carPlayMap).toContain('navOSSCarPlayIsSpeeding(');
    expect(carPlayMap).toContain('bringPositionLayerToFront(position, in: style)');
    expect(carPlayMap).toContain('style.removeLayer(positionLayer)');
    expect(carPlayMap).toContain('style.addLayer(positionLayer)');
    expect(carPlayMap).toContain('forConstantValue: UIColor.systemBlue');
    expect(carPlayMap).toContain('circleRadius = NSExpression(forConstantValue: 6)');
    expect(carPlayMap).toContain('circleStrokeWidth = NSExpression(forConstantValue: 2)');
    expect(carPlayMap).toContain('UIColor.systemRed.withAlphaComponent(0.88)');
    expect(carPlayMap).toContain('style.setImage(carMarkerImage(), forName: carImageIdentifier)');
    expect(carPlayMap).toContain('private func carMarkerImage() -> UIImage');
    expect(carPlayMap).toContain('mapView.attributionButton.isHidden = true');
    expect(carPlayMap).toContain('© OpenStreetMap contributors');
    expect(carPlayMap).toContain('func mapViewDidFailLoadingMap(');
    expect(carPlayMap).toContain('styleLoadRetryCount < 2');
    expect(carPlayMap).toContain('deadline: .now() + 8');
    expect(phoneScene).toContain('#if targetEnvironment(simulator)');
    expect(phoneScene).toContain('NAVOSS_CARPLAY_VISUAL_SCENARIO');
    expect(phoneScene).toContain('"idle-location"');
  });
});
