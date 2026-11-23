import { Layer, UserLocation } from '@maplibre/maplibre-react-native';
import type { Coordinate } from '@navoss/contracts';
import { memo, useEffect, useState } from 'react';

import {
  type FreeDriveTrack,
  freeDriveMarker,
  freeDriveMillisecondsUntilStale,
  mapVehicle,
} from '@/features/map/free-drive-vehicle';
import { mapAlignedHeadingDegrees } from '@/features/navigation/vehicle-heading';
import { VehiclePuck, type VehicleStyle } from '@/features/navigation/vehicle-puck';
import { useRenderCounter } from '@/lib/render-counter';
import { useStoreValue, type ValueStore } from '@/lib/value-store';

interface MapVehicleProps {
  compassStore: ValueStore<number | undefined>;
  /** Location is granted and found, outside a trip (the old condition for MapLibre's dot). */
  locationAvailable: boolean;
  trackStore: ValueStore<FreeDriveTrack>;
  /** Where guidance draws the vehicle; undefined without a trip. */
  tripCoordinate: Coordinate | undefined;
  /** Guidance's heading before this component existed: the last known course, else north. */
  tripFallbackHeadingDegrees: number;
  vehicleStyle: VehicleStyle;
}

/**
 * The driver's position: the one NavOSS vehicle during a trip and in free drive, or MapLibre's
 * location dot when the position cannot be drawn as the vehicle (see `freeDriveMarker`). It
 * subscribes to the fix and the compass itself, so a fix re-renders this component only. The
 * vehicle is a single element in one place in the tree, so Start and End move the same marker
 * rather than swapping one for another.
 */
export const MapVehicle = memo(function MapVehicle({
  compassStore,
  locationAvailable,
  trackStore,
  tripCoordinate,
  tripFallbackHeadingDegrees,
  vehicleStyle,
}: MapVehicleProps) {
  useRenderCounter('MapVehicle');
  const track = useStoreValue(trackStore);
  const compassDegrees = useStoreValue(compassStore);
  // Re-evaluated when the held fix turns stale, since no new fix may arrive to do it.
  const [, setStaleCheck] = useState(0);
  const [drawnHeading, setDrawnHeading] = useState<number | undefined>(undefined);
  const nowMs = Date.now();
  const vehicle = mapVehicle({
    freeDrive: freeDriveMarker({ compassDegrees, locationAvailable, nowMs, track }),
    previousHeadingDegrees: drawnHeading,
    trip:
      tripCoordinate === undefined
        ? undefined
        : {
            coordinate: tripCoordinate,
            courseDegrees: track.tripCourseDegrees,
            fallbackHeadingDegrees: tripFallbackHeadingDegrees,
          },
  });
  const heading = vehicle.kind === 'vehicle' ? vehicle.headingDegrees : undefined;
  if (heading !== drawnHeading) setDrawnHeading(heading);

  const fix = track.fix;
  const freeDriving = tripCoordinate === undefined;
  useEffect(() => {
    const untilStale = freeDriving ? freeDriveMillisecondsUntilStale(fix, Date.now()) : undefined;
    if (untilStale === undefined) return;
    const timer = setTimeout(() => {
      setStaleCheck((count) => count + 1);
    }, untilStale);
    return () => {
      clearTimeout(timer);
    };
  }, [fix, freeDriving]);

  // MapLibre's dot stays mounted (drawing nothing) while the vehicle shows, so it already has a
  // position when the vehicle goes stale and the dot can appear at once.
  const standby = vehicle.kind === 'vehicle' && tripCoordinate === undefined;
  return (
    <>
      {(vehicle.kind === 'location-dot' || standby) && (
        <UserLocation accuracy heading>
          {standby ? (
            <Layer
              id="navoss-location-standby"
              paint={{ 'circle-opacity': 0, 'circle-radius': 0 }}
              type="circle"
            />
          ) : undefined}
        </UserLocation>
      )}
      {vehicle.kind === 'vehicle' && (
        <VehiclePuck
          coordinate={vehicle.coordinate}
          heading={mapAlignedHeadingDegrees(vehicle.headingDegrees)}
          vehicleStyle={vehicleStyle}
        />
      )}
    </>
  );
});
