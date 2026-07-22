import { NativeModule, requireNativeModule } from 'expo';

export interface NativeNavigationCapabilities {
  arrivalDetection: true;
  backgroundLocation: false;
  carPlayTripBridge: true;
  courseMatching: true;
  implementation: 'native-ios';
  offRouteDetection: true;
  replayInput: true;
  routeContinuity: true;
  routeMatching: true;
  safetyCameraAnnouncements: true;
  version: 7;
}

export interface NativeNavigationCoordinate {
  latitude: number;
  longitude: number;
}

export interface NativeNavigationDestination extends NativeNavigationCoordinate {
  id: string;
  label: string;
  name: string;
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
  routeProgress: number;
  routeVersion: number;
  sequence: number;
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
}

export interface NativeCarPlayTrip {
  destination: NativeNavigationDestination;
  distanceMeters: number;
  durationSeconds: number;
  geometry: NativeNavigationCoordinate[];
  id: string;
  steps: NativeCarPlayRouteStep[];
}

export interface NativeCarPlayState {
  connected: boolean;
  guidance?: NativeCarPlayGuidance;
  hasActiveTrip: boolean;
}

type NavOSSNavigationEvents = {
  onCarPlayNavigationEnded(event: { reason: 'carplay' }): void;
  onCarPlayStateChanged(state: NativeCarPlayState): void;
  onNavigationSnapshot(snapshot: NativeNavigationSnapshot): void;
};

declare class NavOSSNavigationModule extends NativeModule<NavOSSNavigationEvents> {
  announceSafetyCamera(): void;
  clearCarPlayTrip(): void;
  clearRoute(): NativeNavigationSnapshot;
  getCarPlayState(): NativeCarPlayState;
  getCapabilities(): NativeNavigationCapabilities;
  getSnapshot(): NativeNavigationSnapshot;
  recordRecentDestination(destination: NativeNavigationDestination): void;
  publishCarPlayGuidance(guidance: NativeCarPlayGuidance): void;
  publishCarPlayTrip(trip: NativeCarPlayTrip): void;
  replaceFavoriteDestinations(destinations: NativeNavigationDestination[]): void;
  setHomeDestination(destination: NativeNavigationDestination | null): void;
  setRoute(geometry: NativeNavigationCoordinate[]): NativeNavigationSnapshot;
  setWorkDestination(destination: NativeNavigationDestination | null): void;
  stopAnnouncements(): void;
  updateLocation(location: NativeNavigationLocationSample): NativeNavigationSnapshot;
}

export default requireNativeModule<NavOSSNavigationModule>('NavOSSNavigation');
