import { ViewAnnotation, type ViewAnnotationRef } from '@maplibre/maplibre-react-native';
import type { Coordinate } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { NavOssColors } from '@/constants/navoss-theme';

export type VehicleStyle = 'arrow' | 'car';
export type VehicleMatchStatus = 'acquiring' | 'matched' | 'off-route';

interface VehiclePuckProps {
  coordinate: Coordinate;
  heading: number;
  vehicleStyle: VehicleStyle;
}

export function VehiclePuck({ coordinate, heading, vehicleStyle }: VehiclePuckProps) {
  const annotationRef = useRef<ViewAnnotationRef>(null);

  useEffect(() => {
    annotationRef.current?.refresh();
  }, [heading, vehicleStyle]);

  return (
    <ViewAnnotation
      anchor="center"
      id="navoss-vehicle-puck"
      lngLat={[coordinate.longitude, coordinate.latitude]}
      ref={annotationRef}
    >
      <View
        style={[
          styles.puck,
          vehicleStyle === 'car' ? styles.carPuck : styles.arrowPuck,
          vehicleStyle === 'arrow' && { transform: [{ rotate: `${String(heading)}deg` }] },
        ]}
      >
        <SymbolView
          name={
            vehicleStyle === 'car'
              ? { android: 'directions_car', ios: 'car.fill' }
              : { android: 'navigation', ios: 'location.north.fill' }
          }
          size={vehicleStyle === 'car' ? 23 : 25}
          tintColor={vehicleStyle === 'car' ? NavOssColors.asphalt : NavOssColors.white}
        />
      </View>
    </ViewAnnotation>
  );
}

const styles = StyleSheet.create({
  arrowPuck: {
    backgroundColor: NavOssColors.green,
  },
  carPuck: {
    backgroundColor: NavOssColors.sun,
  },
  puck: {
    alignItems: 'center',
    borderColor: NavOssColors.white,
    borderRadius: 23,
    borderWidth: 3,
    height: 46,
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.24,
    shadowRadius: 5,
    width: 46,
  },
});
