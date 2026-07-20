import { NativeModule, requireNativeModule } from 'expo';

export interface NativeNavigationCapabilities {
  arrivalDetection: true;
  backgroundLocation: false;
  courseMatching: true;
  implementation: 'native-ios';
  offRouteDetection: true;
  replayInput: true;
  routeContinuity: true;
  routeMatching: true;
  safetyCameraAnnouncements: true;
  version: 6;
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

type NavOSSNavigationEvents = {
  onNavigationSnapshot(snapshot: NativeNavigationSnapshot): void;
};

declare class NavOSSNavigationModule extends NativeModule<NavOSSNavigationEvents> {
  announceSafetyCamera(): void;
  clearRoute(): NativeNavigationSnapshot;
  getCapabilities(): NativeNavigationCapabilities;
  getSnapshot(): NativeNavigationSnapshot;
  recordRecentDestination(destination: NativeNavigationDestination): void;
  replaceFavoriteDestinations(destinations: NativeNavigationDestination[]): void;
  setHomeDestination(destination: NativeNavigationDestination | null): void;
  setRoute(geometry: NativeNavigationCoordinate[]): NativeNavigationSnapshot;
  setWorkDestination(destination: NativeNavigationDestination | null): void;
  stopAnnouncements(): void;
  updateLocation(location: NativeNavigationLocationSample): NativeNavigationSnapshot;
}

export default requireNativeModule<NavOSSNavigationModule>('NavOSSNavigation');
