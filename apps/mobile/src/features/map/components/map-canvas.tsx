import {
  Camera,
  type CameraRef,
  Images,
  Map,
  type MapRef,
  type StyleSpecification,
} from '@maplibre/maplibre-react-native';
import type { Coordinate } from '@navoss/contracts';
import type { ReactNode, RefObject } from 'react';
import { StyleSheet } from 'react-native';

import type { CameraChange } from '@/features/map/controller/use-map-controller';
import type { NavigationViewMode } from '@/features/map/map-preferences';
import { guidanceCameraPadding, type ScreenMetrics } from '@/features/map/overlay-layout';
import { NAVIGATION_CAMERA_TRANSITION } from '@/features/navigation/navigation-camera';
import { useRenderCounter } from '@/lib/render-counter';
import { palette } from '@/theme/tokens';

const CANADA_CENTER: [longitude: number, latitude: number] = [-106.3468, 56.1304];
const INITIAL_VIEW_STATE = { center: CANADA_CENTER, zoom: 3.2 };
// Explicit, not undefined: the native camera keeps the last padding it was given, so guidance
// padding would otherwise survive the trip and push the next route preview under its sheet.
const NO_PADDING = { bottom: 0, left: 0, right: 0, top: 0 };

const MAP_IMAGES = {
  'road-closure': require('@/assets/images/road-closure-marker.png'),
  'road-construction': require('@/assets/images/road-construction-marker.png'),
  'road-incident': require('@/assets/images/road-incident-marker.png'),
  'safety-camera': require('@/assets/images/camera-marker.png'),
  'vehicle-arrow': require('@/assets/images/vehicle-arrow.png'),
  'vehicle-car': require('@/assets/images/vehicle-car.png'),
};

export interface MapCanvasProps {
  accessibilityLabel: string;
  cameraRef: RefObject<CameraRef | null>;
  /** Layers and sources drawn over the basemap. */
  children: ReactNode;
  /** Hidden from assistive tech while a full-screen tab covers the map. */
  hidden: boolean;
  idleCenter: [longitude: number, latitude: number] | undefined;
  idleShouldFollow: boolean;
  isNavigating: boolean;
  isNavigationFollowing: boolean;
  mapRef: RefObject<MapRef | null>;
  mapStyle: string | StyleSpecification;
  metrics: ScreenMetrics;
  navigationBearing: number | undefined;
  navigationView: NavigationViewMode;
  onCameraChange: (change: CameraChange) => void;
  onLoadError: (failed: boolean) => void;
  onLongPress: (coordinate: Coordinate) => void;
  onPress: (point: [number, number], coordinate: Coordinate) => void;
  vehicleCoordinate: Coordinate | undefined;
}

/**
 * The MapLibre view and its camera. The camera follows the vehicle during guidance and the
 * driver's position while idle; any gesture hands control back to the driver until they recenter.
 *
 * `onRegionIsChanging` fires every frame of a pan or zoom. It only forwards the frame to the
 * controller, which writes it to a shared value and a store; this component does not re-render.
 */
export function MapCanvas({
  accessibilityLabel,
  cameraRef,
  children,
  hidden,
  idleCenter,
  idleShouldFollow,
  isNavigating,
  isNavigationFollowing,
  mapRef,
  mapStyle,
  metrics,
  navigationBearing,
  navigationView,
  onCameraChange,
  onLoadError,
  onLongPress,
  onPress,
  vehicleCoordinate,
}: MapCanvasProps) {
  useRenderCounter('MapCanvas');
  const followsVehicle = isNavigating && isNavigationFollowing;
  const animatesFollow = isNavigating || idleShouldFollow;

  return (
    <Map
      accessibilityElementsHidden={hidden}
      accessibilityLabel={accessibilityLabel}
      attribution={false}
      compass={!isNavigating}
      compassPosition={{ right: 14, top: metrics.topInset + 124 }}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      logo={false}
      mapStyle={mapStyle}
      onDidFailLoadingMap={() => {
        onLoadError(true);
      }}
      onDidFinishLoadingMap={() => {
        onLoadError(false);
      }}
      onLongPress={({ nativeEvent }) => {
        const [longitude, latitude] = nativeEvent.lngLat;
        onLongPress({ latitude, longitude });
      }}
      onPress={({ nativeEvent }) => {
        const [longitude, latitude] = nativeEvent.lngLat;
        onPress(nativeEvent.point, { latitude, longitude });
      }}
      onRegionIsChanging={({ nativeEvent }) => {
        onCameraChange({
          bearing: nativeEvent.bearing,
          userInteraction: nativeEvent.userInteraction === true,
          zoom: nativeEvent.zoom,
        });
      }}
      preferredFramesPerSecond={60}
      ref={mapRef}
      style={styles.map}
      tintColor={palette.tealLight}
    >
      <Images images={MAP_IMAGES} />
      <Camera
        bearing={followsVehicle ? navigationBearing : undefined}
        center={
          isNavigating
            ? followsVehicle && vehicleCoordinate !== undefined
              ? [vehicleCoordinate.longitude, vehicleCoordinate.latitude]
              : undefined
            : idleCenter
        }
        duration={animatesFollow ? NAVIGATION_CAMERA_TRANSITION.duration : undefined}
        easing={animatesFollow ? NAVIGATION_CAMERA_TRANSITION.easing : undefined}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={19}
        minZoom={0}
        padding={isNavigating ? guidanceCameraPadding(metrics) : NO_PADDING}
        pitch={followsVehicle ? (navigationView === 'tilted' ? 42 : 0) : undefined}
        ref={cameraRef}
        zoom={followsVehicle ? 16 : idleShouldFollow ? 15 : undefined}
      />
      {children}
    </Map>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
});
