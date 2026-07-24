import { Layer, LayerAnnotation } from '@maplibre/maplibre-react-native';
import type { Coordinate } from '@navoss/contracts';

import { NAVIGATION_CAMERA_TRANSITION } from '@/features/navigation/navigation-camera';

export type VehicleStyle = 'arrow' | 'car';
export type VehicleMatchStatus = 'acquiring' | 'matched' | 'off-route';

interface VehiclePuckProps {
  coordinate: Coordinate;
  heading: number;
  vehicleStyle: VehicleStyle;
}

export function VehiclePuck({ coordinate, heading, vehicleStyle }: VehiclePuckProps) {
  return (
    <LayerAnnotation
      animated
      animationDuration={NAVIGATION_CAMERA_TRANSITION.duration}
      id="navoss-vehicle-puck"
      lngLat={[coordinate.longitude, coordinate.latitude]}
    >
      <Layer
        id="navoss-vehicle-puck-symbol"
        layout={{
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-image': vehicleStyle === 'car' ? 'vehicle-car' : 'vehicle-arrow',
          'icon-rotate': heading,
          'icon-rotation-alignment': 'map',
          'icon-size': 0.72,
        }}
        type="symbol"
      />
    </LayerAnnotation>
  );
}
