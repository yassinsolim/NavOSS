import { GeoJSONSource, Layer, UserLocation } from '@maplibre/maplibre-react-native';
import type {
  Coordinate,
  OfficialSafetyCamera,
  RouteAlternative,
  SafetyCamera,
  SafetyFacility,
  SearchResult,
  TrafficCamera,
} from '@navoss/contracts';
import { useMemo } from 'react';

import { headingConeFeature } from '@/features/map/heading-cone';
import {
  type MapRoadEvent,
  roadEventFeatures,
  routeFeatures,
  safetyCameraFeatures,
  safetyFacilityFeatures,
  searchResultFeatures,
  selectedPlaceFeature,
  trafficCameraFeatures,
} from '@/features/map/map-features';
import { ROUTE_COLORS, type RouteColor } from '@/features/map/map-preferences';
import { mapAlignedHeadingDegrees } from '@/features/navigation/vehicle-heading';
import { VehiclePuck, type VehicleStyle } from '@/features/navigation/vehicle-puck';
import { useRenderCounter } from '@/lib/render-counter';
import { useStoreValue, type ValueStore } from '@/lib/value-store';
import { palette } from '@/theme/tokens';

// OpenFreeMap serves Noto Sans glyphs for every style NavOSS loads.
const LABEL_FONT = ['Noto Sans Regular'];
const ROUND_LINE = { 'line-cap': 'round', 'line-join': 'round' } as const;

/**
 * The compass cone under the position dot. It is the only component that subscribes to the
 * compass and the quantised zoom, so a turning phone or a pinch redraws this one polygon.
 */
function FacingConeLayer({
  coordinate,
  courseFallback,
  deviceHeadingStore,
  zoomStepStore,
}: {
  coordinate: Coordinate | undefined;
  /** Course over ground, used during guidance on devices without a usable compass. */
  courseFallback: number | undefined;
  deviceHeadingStore: ValueStore<number | undefined>;
  zoomStepStore: ValueStore<number | undefined>;
}) {
  useRenderCounter('FacingConeLayer');
  const deviceHeading = useStoreValue(deviceHeadingStore);
  const zoomStep = useStoreValue(zoomStepStore);
  // Compass first: it answers "which way am I pointing" even stopped.
  const heading = deviceHeading ?? courseFallback;
  const feature = useMemo(
    () => headingConeFeature(coordinate, heading, zoomStep),
    [coordinate, heading, zoomStep],
  );
  if (feature === undefined) return null;
  return (
    <GeoJSONSource data={feature} id="navoss-facing-cone">
      <Layer
        id="navoss-facing-cone-fill"
        paint={{ 'fill-color': palette.tealLight, 'fill-opacity': 0.25 }}
        type="fill"
      />
    </GeoJSONSource>
  );
}

export interface MapLayersProps {
  alternateRoutes: readonly RouteAlternative[];
  darkMap: boolean;
  deviceHeadingStore: ValueStore<number | undefined>;
  displayedSelectedRoute: RouteAlternative | undefined;
  isNavigating: boolean;
  roadEvents: readonly MapRoadEvent[];
  routeColor: RouteColor;
  safetyCameras: readonly SafetyCamera[];
  safetyFacilities: readonly SafetyFacility[];
  /** Results drawn as tappable dots. Empty unless the explore surface is showing results. */
  searchResults: readonly SearchResult[];
  selectedResult: SearchResult | undefined;
  showRoadEvents: boolean;
  showSafetyCameras: boolean;
  showSafetyFacilities: boolean;
  showUserLocation: boolean;
  torontoSafetyCameras: readonly OfficialSafetyCamera[];
  trafficCameras: readonly TrafficCamera[];
  userCoordinate: Coordinate | undefined;
  userHeading: number;
  vehicleCoordinate: Coordinate | undefined;
  vehicleStyle: VehicleStyle;
  zoomStepStore: ValueStore<number | undefined>;
}

/**
 * Everything NavOSS draws over the basemap, bottom to top: position, route lines, then point
 * symbols. Every source's data is memoised on the data it is built from, so a re-render that
 * changes nothing here uploads nothing to the map.
 */
export function MapLayers({
  alternateRoutes,
  darkMap,
  deviceHeadingStore,
  displayedSelectedRoute,
  isNavigating,
  roadEvents,
  routeColor,
  safetyCameras,
  safetyFacilities,
  searchResults,
  selectedResult,
  showRoadEvents,
  showSafetyCameras,
  showSafetyFacilities,
  showUserLocation,
  torontoSafetyCameras,
  trafficCameras,
  userCoordinate,
  userHeading,
  vehicleCoordinate,
  vehicleStyle,
  zoomStepStore,
}: MapLayersProps) {
  useRenderCounter('MapLayers');
  const selectedPlaceData = useMemo(() => selectedPlaceFeature(selectedResult), [selectedResult]);
  const searchResultData = useMemo(() => searchResultFeatures(searchResults), [searchResults]);
  const alternateRouteData = useMemo(() => routeFeatures(alternateRoutes), [alternateRoutes]);
  const selectedRouteData = useMemo(
    () =>
      displayedSelectedRoute === undefined ? undefined : routeFeatures([displayedSelectedRoute]),
    [displayedSelectedRoute],
  );
  const safetyCameraData = useMemo(() => safetyCameraFeatures(safetyCameras), [safetyCameras]);
  const torontoCameraData = useMemo(
    () => safetyCameraFeatures(torontoSafetyCameras),
    [torontoSafetyCameras],
  );
  const trafficCameraData = useMemo(() => trafficCameraFeatures(trafficCameras), [trafficCameras]);
  const safetyFacilityData = useMemo(
    () => safetyFacilityFeatures(safetyFacilities),
    [safetyFacilities],
  );
  const roadEventData = useMemo(
    () => ({
      closure: roadEventFeatures(roadEvents, 'closure'),
      construction: roadEventFeatures(roadEvents, 'construction'),
      incident: roadEventFeatures(roadEvents, 'incident'),
    }),
    [roadEvents],
  );
  const labelColor = darkMap ? '#F2F5F2' : palette.ink;
  const labelHalo = darkMap ? palette.ink : palette.white;

  return (
    <>
      <FacingConeLayer
        coordinate={vehicleCoordinate}
        courseFallback={isNavigating ? userHeading : undefined}
        deviceHeadingStore={deviceHeadingStore}
        zoomStepStore={zoomStepStore}
      />
      {showUserLocation && <UserLocation accuracy heading />}

      {alternateRoutes.length > 0 && (
        <GeoJSONSource data={alternateRouteData} id="alternate-routes">
          <Layer
            id="alternate-route-lines"
            layout={ROUND_LINE}
            paint={{ 'line-color': '#81908E', 'line-opacity': 0.7, 'line-width': 5 }}
            type="line"
          />
        </GeoJSONSource>
      )}
      {selectedRouteData !== undefined && (
        <GeoJSONSource data={selectedRouteData} id="selected-route">
          <Layer
            id="selected-route-casing"
            layout={ROUND_LINE}
            paint={{ 'line-color': palette.white, 'line-width': 10 }}
            type="line"
          />
          {/* Route colour is a paint property of our own layer: changing it repaints this line
              and leaves the basemap style untouched. */}
          <Layer
            id="selected-route-line"
            layout={ROUND_LINE}
            paint={{ 'line-color': ROUTE_COLORS[routeColor], 'line-width': 6.5 }}
            type="line"
          />
        </GeoJSONSource>
      )}
      {/* Wave 2 seam: the traffic-flow line layer mounts here, above the route and below every
          point symbol, coloured from `trafficColors` by speed ratio and gated on its opt-in
          preference. Draw it under `selected-route-line` with `beforeId` if it should sit
          beneath the active route. */}

      {isNavigating && userCoordinate !== undefined && vehicleCoordinate !== undefined && (
        <VehiclePuck
          coordinate={vehicleCoordinate}
          heading={mapAlignedHeadingDegrees(userHeading)}
          vehicleStyle={vehicleStyle}
        />
      )}

      <GeoJSONSource data={selectedPlaceData} id="selected-place">
        <Layer
          id="selected-place-halo"
          paint={{ 'circle-color': palette.coral, 'circle-opacity': 0.22, 'circle-radius': 20 }}
          type="circle"
        />
        <Layer
          id="selected-place-dot"
          paint={{
            'circle-color': palette.coral,
            'circle-radius': 8,
            'circle-stroke-color': palette.white,
            'circle-stroke-width': 3,
          }}
          type="circle"
        />
      </GeoJSONSource>

      {/* One symbol source for all results: the map draws and hit-tests them itself, instead of
          React Native positioning a native view per result on every camera frame. */}
      <GeoJSONSource data={searchResultData} id="search-results">
        <Layer
          id="search-result-dots"
          paint={{
            'circle-color': palette.coral,
            'circle-radius': 9,
            'circle-stroke-color': palette.white,
            'circle-stroke-width': 2.5,
          }}
          type="circle"
        />
        <Layer
          id="search-result-labels"
          layout={{
            'symbol-sort-key': ['get', 'rank'],
            'text-anchor': 'top',
            'text-field': ['get', 'name'],
            'text-font': LABEL_FONT,
            'text-max-width': 9,
            'text-offset': [0, 0.9],
            'text-optional': true,
            'text-size': 12,
          }}
          paint={{
            'text-color': labelColor,
            'text-halo-color': labelHalo,
            'text-halo-width': 1.5,
          }}
          type="symbol"
        />
      </GeoJSONSource>

      {showSafetyCameras && trafficCameras.length > 0 && (
        <GeoJSONSource data={trafficCameraData} id="traffic-cameras">
          <Layer
            id="traffic-camera-dots"
            paint={{
              'circle-color': palette.tealLight,
              'circle-radius': 8,
              'circle-stroke-color': palette.white,
              'circle-stroke-width': 2.5,
            }}
            type="circle"
          />
          <Layer
            id="traffic-camera-labels"
            layout={{
              'text-anchor': 'top',
              'text-field': 'Webcam',
              'text-font': LABEL_FONT,
              'text-offset': [0, 0.8],
              'text-optional': true,
              'text-size': 11,
            }}
            minzoom={12}
            paint={{
              'text-color': labelColor,
              'text-halo-color': labelHalo,
              'text-halo-width': 1.5,
            }}
            type="symbol"
          />
        </GeoJSONSource>
      )}
      {showSafetyFacilities && safetyFacilities.length > 0 && (
        <GeoJSONSource data={safetyFacilityData} id="safety-facilities">
          <Layer
            id="safety-facility-dots"
            paint={{
              'circle-color': '#31418F',
              'circle-radius': 8,
              'circle-stroke-color': palette.white,
              'circle-stroke-width': 2.5,
            }}
            type="circle"
          />
          <Layer
            id="safety-facility-labels"
            layout={{
              'text-anchor': 'top',
              'text-field': 'RCMP',
              'text-font': LABEL_FONT,
              'text-offset': [0, 0.8],
              'text-optional': true,
              'text-size': 11,
            }}
            minzoom={11}
            paint={{
              'text-color': labelColor,
              'text-halo-color': labelHalo,
              'text-halo-width': 1.5,
            }}
            type="symbol"
          />
        </GeoJSONSource>
      )}

      {showSafetyCameras && safetyCameras.length > 0 && (
        <GeoJSONSource data={safetyCameraData} id="safety-cameras">
          <Layer
            id="safety-camera-symbols"
            layout={{
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
              'icon-image': 'safety-camera',
              'icon-size': 0.5,
            }}
            type="symbol"
          />
        </GeoJSONSource>
      )}
      {showSafetyCameras && torontoSafetyCameras.length > 0 && (
        <GeoJSONSource data={torontoCameraData} id="toronto-safety-cameras">
          <Layer
            id="toronto-safety-camera-symbols"
            layout={{
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
              'icon-image': 'safety-camera',
              'icon-size': 0.5,
            }}
            type="symbol"
          />
        </GeoJSONSource>
      )}
      {showRoadEvents && (
        <>
          <GeoJSONSource data={roadEventData.construction} id="official-construction-events-source">
            <Layer
              id="official-construction-events"
              layout={{ 'icon-image': 'road-construction', 'icon-size': 0.58 }}
              type="symbol"
            />
          </GeoJSONSource>
          <GeoJSONSource data={roadEventData.closure} id="road-closure-events-source">
            <Layer
              id="road-closure-events"
              layout={{ 'icon-image': 'road-closure', 'icon-size': 0.58 }}
              type="symbol"
            />
          </GeoJSONSource>
          <GeoJSONSource data={roadEventData.incident} id="road-incident-events-source">
            <Layer
              id="road-incident-events"
              layout={{ 'icon-image': 'road-incident', 'icon-size': 0.58 }}
              type="symbol"
            />
          </GeoJSONSource>
          {/* Wave 2 seam: the community-reports symbol source mounts here, beside the official
              road-event layers and above them, with its own layer id for hit-testing in
              `handleMapPress`. */}
        </>
      )}
    </>
  );
}
