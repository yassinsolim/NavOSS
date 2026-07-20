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
  version: 5;
}

export interface NativeNavigationCoordinate {
  latitude: number;
  longitude: number;
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
  setRoute(geometry: NativeNavigationCoordinate[]): NativeNavigationSnapshot;
  stopAnnouncements(): void;
  updateLocation(location: NativeNavigationLocationSample): NativeNavigationSnapshot;
}

export default requireNativeModule<NavOSSNavigationModule>('NavOSSNavigation');
