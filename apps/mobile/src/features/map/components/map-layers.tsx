import { GeoJSONSource, Layer, UserLocation } from '@maplibre/maplibre-react-native';
import type {
  Coordinate,
  OfficialSafetyCamera,
  RouteAlternativeV2,
  SafetyCamera,
  SafetyFacility,
  SearchResult,
  TrafficCamera,
} from '@navoss/contracts';
import type { TrafficCongestionLevel } from '@navoss/contracts';
import type { FeatureCollection, LineString } from 'geojson';
import { useMemo } from 'react';

import { communityReportFeatures } from '@/features/community/community';

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
import type { NativeCommunityReport } from '@/features/navigation/native-navigation';
import { mapAlignedHeadingDegrees } from '@/features/navigation/vehicle-heading';
import { VehiclePuck, type VehicleStyle } from '@/features/navigation/vehicle-puck';
import { useRenderCounter } from '@/lib/render-counter';
import { useStoreValue, type ValueStore } from '@/lib/value-store';
import { palette, trafficColors } from '@/theme/tokens';

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
  alternateRoutes: readonly RouteAlternativeV2[];
  /** First label layer of the basemap: traffic flow is drawn beneath it when no route is shown. */
  basemapLabelLayerId: string | undefined;
  /** Shared reports from other drivers; empty unless the server provides them and they are on. */
  communityReports: readonly NativeCommunityReport[];
  darkMap: boolean;
  deviceHeadingStore: ValueStore<number | undefined>;
  displayedSelectedRoute: RouteAlternativeV2 | undefined;
  isNavigating: boolean;
  roadEvents: readonly MapRoadEvent[];
  routeColor: RouteColor;
  safetyCameras: readonly SafetyCamera[];
  /** Congestion runs over the selected route; only when a live traffic source observed it. */
  selectedRouteCongestion: FeatureCollection<LineString> | undefined;
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
  /** Community traffic flow; empty unless the driver turned the layer on and the server is live. */
  trafficFlow: FeatureCollection<LineString, { congestion: TrafficCongestionLevel }>;
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
  basemapLabelLayerId,
  communityReports,
  darkMap,
  deviceHeadingStore,
  displayedSelectedRoute,
  isNavigating,
  roadEvents,
  routeColor,
  safetyCameras,
  safetyFacilities,
  searchResults,
  selectedRouteCongestion,
  selectedResult,
  showRoadEvents,
  showSafetyCameras,
  showSafetyFacilities,
  showUserLocation,
  torontoSafetyCameras,
  trafficCameras,
  trafficFlow,
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
  const communityReportData = useMemo(
    () => communityReportFeatures(communityReports),
    [communityReports],
  );
  // Above the route casing and beneath the route line while a route is drawn, so the route's own
  // congestion reads first; otherwise beneath the basemap's labels.
  const trafficPosition =
    displayedSelectedRoute !== undefined
      ? { afterId: 'selected-route-casing', key: 'route' }
      : basemapLabelLayerId !== undefined
        ? { beforeId: basemapLabelLayerId, key: `label-${basemapLabelLayerId}` }
        : { key: 'top' };
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
      {selectedRouteCongestion !== undefined && selectedRouteCongestion.features.length > 0 && (
        <GeoJSONSource data={selectedRouteCongestion} id="selected-route-congestion">
          <Layer
            id="selected-route-congestion-line"
            layout={ROUND_LINE}
            paint={{
              'line-color': [
                'match',
                ['get', 'level'],
                'stopped',
                trafficColors.stopped,
                'heavy',
                trafficColors.heavy,
                trafficColors.slow,
              ],
              'line-width': 6.5,
            }}
            type="line"
          />
        </GeoJSONSource>
      )}
      {trafficFlow.features.length > 0 && (
        <GeoJSONSource data={trafficFlow} id="community-traffic-flow">
          <Layer
            afterId={trafficPosition.afterId}
            beforeId={trafficPosition.beforeId}
            id="community-traffic-flow-line"
            // A layer's position is fixed when it is added: remount it when the anchor changes.
            key={trafficPosition.key}
            layout={ROUND_LINE}
            paint={{
              'line-color': [
                'match',
                ['get', 'congestion'],
                'stopped',
                trafficColors.stopped,
                'heavy',
                trafficColors.heavy,
                'slow',
                trafficColors.slow,
                trafficColors.free,
              ],
              'line-opacity': 0.92,
              'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
            }}
            type="line"
          />
        </GeoJSONSource>
      )}

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
        </>
      )}
      {/* Driver reports sit above official road events: they are the most recent information,
          and an unconfirmed report uses its own faded marker. */}
      {communityReports.length > 0 && (
        <GeoJSONSource data={communityReportData} id="community-reports-source">
          <Layer
            id="community-reports"
            layout={{
              'icon-allow-overlap': true,
              'icon-image': ['get', 'icon'],
              'icon-offset': ['get', 'offset'],
              'icon-size': 0.62,
              'symbol-sort-key': ['case', ['get', 'confirmed'], 1, 0],
            }}
            type="symbol"
          />
        </GeoJSONSource>
      )}
    </>
  );
}
