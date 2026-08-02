import { NativeModule, requireNativeModule } from 'expo';

export interface NativeNavigationCapabilities {
  arrivalDetection: true;
  backgroundLocation: boolean;
  carPlayTripBridge: true;
  courseMatching: true;
  implementation: 'native-ios';
  offRouteDetection: true;
  replayInput: true;
  routeContinuity: true;
  routeMatching: true;
  safetyCameraAnnouncements: true;
  version: 8;
}

export type NativeNavigationAudioMode = 'alerts-only' | 'all-guidance' | 'muted';

export interface NativeNavigationCoordinate {
  latitude: number;
  longitude: number;
}

export interface NativeNavigationDestination extends NativeNavigationCoordinate {
  category?: 'address' | 'landmark' | 'neighborhood' | 'poi' | 'street';
  id: string;
  label: string;
  name: string;
}

export interface NativeDestinationCatalog {
  favorites: NativeNavigationDestination[];
  home?: NativeNavigationDestination;
  recents: NativeNavigationDestination[];
  work?: NativeNavigationDestination;
}

export interface NativeNavigationLocationSample extends NativeNavigationCoordinate {
  courseDegrees?: number;
  horizontalAccuracyMeters?: number;
}

export interface NativeNavigationSnapshot {
  distanceFromRouteMeters?: number;
  horizontalAccuracyMeters?: number;
  isOffRoute: boolean;
  matchedCoordinate?: NativeNavigationCoordinate;
  matchedCourseDegrees?: number;
  phase: 'arrived' | 'idle' | 'tracking';
  rawCoordinate?: NativeNavigationCoordinate;
  rerouteCount: number;
  guidance?: NativeCarPlayGuidance;
  routeProgress: number;
  routeStatus: 'reroute-failed' | 'rerouting' | 'tracking';
  routeVersion: number;
  sequence: number;
  stateVersion: number;
  trip?: NativeCarPlayTrip;
}

export type NativeCarPlayGuidancePhase = 'arrived' | 'navigating' | 'preview';

export interface NativeCarPlayGuidance {
  distanceToManeuverMeters: number;
  durationToManeuverSeconds: number;
  instruction: string;
  maneuverType: string;
  phase: NativeCarPlayGuidancePhase;
  remainingDistanceMeters: number;
  remainingDurationSeconds: number;
  roadName: string;
  stepIndex: number;
}

export interface NativeCarPlayRouteStep {
  distanceMeters: number;
  durationSeconds: number;
  geometry: NativeNavigationCoordinate[];
  instruction: string;
  maneuverType: string;
  roadName: string;
  spokenInstruction?: string;
}

export interface NativeRoutePreferences {
  avoidFerries: boolean;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidUnpaved: boolean;
}

export interface NativeCarPlayTrip {
  destination: NativeNavigationDestination;
  distanceMeters: number;
  durationSeconds: number;
  geometry: NativeNavigationCoordinate[];
  id: string;
  preferences: NativeRoutePreferences;
  source?: string;
  speedLimitsKph?: number[];
  steps: NativeCarPlayRouteStep[];
  traffic?: {
    delaySeconds: number;
    typicalDurationSeconds: number;
  };
  waypoints?: NativeNavigationDestination[];
}

export interface NativeCarPlayState {
  connected: boolean;
  guidance?: NativeCarPlayGuidance;
  hasActiveTrip: boolean;
}

export interface NativeNavigationPreferences {
  audioMode: NativeNavigationAudioMode;
  routePreferences: NativeRoutePreferences;
}

type NavOSSNavigationEvents = {
  onCarPlayNavigationEnded(event: { reason: 'carplay' }): void;
  onCarPlayStateChanged(state: NativeCarPlayState): void;
  onNavigationPreferencesChanged(preferences: NativeNavigationPreferences): void;
  onNavigationSnapshot(snapshot: NativeNavigationSnapshot): void;
};

declare class NavOSSNavigationModule extends NativeModule<NavOSSNavigationEvents> {
  announceSafetyCamera(): void;
  clearCarPlayTrip(): void;
  clearDestinationHistory(): void;
  clearRecentDestinations(): void;
  clearRoute(): NativeNavigationSnapshot;
  getCarPlayState(): NativeCarPlayState;
  getAudioMode(): NativeNavigationAudioMode;
  getCapabilities(): NativeNavigationCapabilities;
  getDestinationCatalog(): NativeDestinationCatalog;
  getGooglePlacesOpenSourceLicenseInfo(): string | null;
  getNavigationPreferences(): NativeNavigationPreferences;
  getRecentDestinationIds(): string[];
  getRoutePreferences(): NativeRoutePreferences;
  getSnapshot(): NativeNavigationSnapshot;
  isFavoriteDestination(id: string): boolean;
  isCarPlayVisualHarness(): boolean;
  isGooglePlaceRatingAvailable(): boolean;
  recordRecentDestination(destination: NativeNavigationDestination): void;
  replaceFavoriteDestinations(destinations: NativeNavigationDestination[]): void;
  setHomeDestination(destination: NativeNavigationDestination | null): void;
  setAudioMode(mode: NativeNavigationAudioMode): void;
  setRoute(trip: NativeCarPlayTrip): NativeNavigationSnapshot;
  setRoutePreferences(preferences: NativeRoutePreferences): void;
  setWorkDestination(destination: NativeNavigationDestination | null): void;
  stopAnnouncements(): void;
  toggleFavoriteDestination(destination: NativeNavigationDestination): boolean;
  updateLocation(location: NativeNavigationLocationSample): NativeNavigationSnapshot;
}

export default requireNativeModule<NavOSSNavigationModule>('NavOSSNavigation');
