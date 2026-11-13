import type {
  Coordinate,
  OfficialRoadEvent,
  RoadEvent,
  RouteAlternativeV2,
  SafetyCamera,
  SafetyFacility,
  SearchResult,
  TrafficCamera,
} from '@navoss/contracts';
import type { FeatureCollection, LineString, Point } from 'geojson';

import type { MapRegion } from '@/features/map/map-region';

/**
 * Everything the map draws that is not the basemap, as pure GeoJSON builders. Callers memoise
 * the results: a new collection identity makes MapLibre re-upload the whole source.
 */

export type MapRoadEvent = RoadEvent | OfficialRoadEvent;
export type RoadEventRegion = 'calgary' | 'kelowna-bc' | 'ontario';

export const EMPTY_POINT_COLLECTION: FeatureCollection<Point> = {
  features: [],
  type: 'FeatureCollection',
};

export const ROAD_EVENT_LAYER_IDS = [
  'official-construction-events',
  'road-closure-events',
  'road-incident-events',
] as const;
export const SAFETY_CAMERA_LAYER_IDS = [
  'safety-camera-symbols',
  'toronto-safety-camera-symbols',
] as const;
export const SEARCH_RESULT_LAYER_IDS = ['search-result-dots'] as const;
export const TRAFFIC_CAMERA_LAYER_IDS = ['traffic-camera-dots'] as const;
export const SAFETY_FACILITY_LAYER_IDS = ['safety-facility-dots'] as const;

/** Road-event overlays exist only for the exact regions that publish them. */
export function roadEventRegionForMapRegion(
  mapRegion: MapRegion | undefined,
): RoadEventRegion | undefined {
  if (mapRegion === 'calgary-ab') return 'calgary';
  if (mapRegion === 'ontario' || mapRegion === 'kelowna-bc') return mapRegion;
  return undefined;
}

function point(coordinate: Coordinate): Point {
  return { coordinates: [coordinate.longitude, coordinate.latitude], type: 'Point' };
}

export function selectedPlaceFeature(result: SearchResult | undefined): FeatureCollection<Point> {
  if (result === undefined) return EMPTY_POINT_COLLECTION;
  return {
    features: [{ geometry: point(result.center), properties: { id: result.id }, type: 'Feature' }],
    type: 'FeatureCollection',
  };
}

/** Search results as one symbol source, replacing a native view per result. */
export function searchResultFeatures(results: readonly SearchResult[]): FeatureCollection<Point> {
  if (results.length === 0) return EMPTY_POINT_COLLECTION;
  return {
    features: results.map((result, index) => ({
      geometry: point(result.center),
      // `rank` lets the layer draw the best match on top and keep its label when labels collide.
      properties: { id: result.id, name: result.name, rank: index },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

export function routeFeatures(
  routes: readonly RouteAlternativeV2[],
): FeatureCollection<LineString> {
  return {
    features: routes.map((route) => ({
      geometry: { coordinates: route.geometry, type: 'LineString' },
      properties: { id: route.id },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

const EARTH_METERS_PER_DEGREE = 111_320;

function segmentMeters(start: [number, number], end: [number, number]): number {
  const longitudeScale =
    EARTH_METERS_PER_DEGREE * Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  return Math.hypot(
    (end[1] - start[1]) * EARTH_METERS_PER_DEGREE,
    (end[0] - start[0]) * longitudeScale,
  );
}

/**
 * Runs of slow, heavy or stopped traffic along a route, drawn over its line. Free-flowing and
 * unknown segments draw nothing, so the route keeps its own colour there; a congestion array
 * that does not line up with the geometry draws nothing at all rather than colouring the wrong
 * road. Road already driven (before `progress`, a 0–1 fraction of the route) is dropped. Mirrors
 * CarPlay's `navOSSCarPlayCongestionRuns`.
 */
export function congestionFeatures(
  route: Pick<RouteAlternativeV2, 'congestion' | 'geometry'>,
  progress = 0,
): FeatureCollection<LineString> | undefined {
  const { congestion, geometry } = route;
  if (congestion?.length !== geometry.length - 1 || geometry.length < 2) return undefined;
  const cumulative = [0];
  for (let index = 1; index < geometry.length; index += 1) {
    cumulative.push(
      (cumulative[index - 1] ?? 0) +
        segmentMeters(geometry[index - 1] ?? [0, 0], geometry[index] ?? [0, 0]),
    );
  }
  const travelled =
    (Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0) * (cumulative.at(-1) ?? 0);
  const features: FeatureCollection<LineString>['features'] = [];
  let level: string | undefined;
  let coordinates: [number, number][] = [];
  const flush = () => {
    if (level !== undefined && coordinates.length >= 2) {
      features.push({
        geometry: { coordinates, type: 'LineString' },
        properties: { level },
        type: 'Feature',
      });
    }
    level = undefined;
    coordinates = [];
  };
  congestion.forEach((segmentLevel, index) => {
    const start = geometry[index] ?? [0, 0];
    const end = geometry[index + 1] ?? [0, 0];
    const startAlong = cumulative[index] ?? 0;
    const endAlong = cumulative[index + 1] ?? 0;
    if (segmentLevel === 'free' || segmentLevel === 'unknown' || endAlong <= travelled) {
      flush();
      return;
    }
    if (segmentLevel !== level || coordinates.length === 0) {
      flush();
      level = segmentLevel;
      const length = endAlong - startAlong;
      if (startAlong < travelled && length > 0) {
        const fraction = (travelled - startAlong) / length;
        coordinates = [
          [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction],
        ];
      } else {
        coordinates = [start];
      }
    }
    coordinates.push(end);
  });
  flush();
  return { features, type: 'FeatureCollection' };
}

export function safetyCameraFeatures(
  cameras: readonly (Pick<SafetyCamera, 'coordinate' | 'id' | 'location'> &
    Partial<Pick<SafetyCamera, 'direction'>> & {
      enforcement: readonly SafetyCamera['enforcement'][number][];
    })[],
): FeatureCollection<Point> {
  return {
    features: cameras.map((camera) => ({
      geometry: point(camera.coordinate),
      properties: {
        ...(camera.direction === undefined ? {} : { direction: camera.direction }),
        enforcement: camera.enforcement.join(','),
        id: camera.id,
        location: camera.location,
      },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

export function roadEventFeatures(
  events: readonly MapRoadEvent[],
  type: MapRoadEvent['type'],
): FeatureCollection<Point> {
  return {
    features: events
      .filter((event) => event.type === type)
      .map((event) => ({
        geometry: point(event.coordinate),
        properties: { id: event.id },
        type: 'Feature',
      })),
    type: 'FeatureCollection',
  };
}

export function trafficCameraFeatures(cameras: readonly TrafficCamera[]): FeatureCollection<Point> {
  return {
    features: cameras.map((camera) => ({
      geometry: point(camera.coordinate),
      properties: { id: camera.id },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

export function safetyFacilityFeatures(
  facilities: readonly SafetyFacility[],
): FeatureCollection<Point> {
  return {
    features: facilities.map((facility) => ({
      geometry: point(facility.coordinate),
      properties: { id: facility.id },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

/**
 * The items within `maxMeters` of a route. A route preview is drawn at city zoom, where every
 * camera in the region would bury the line; only the ones the route actually passes matter.
 */
export function itemsNearRoute<T extends { coordinate: Coordinate }>(
  items: readonly T[],
  route: Pick<RouteAlternativeV2, 'geometry'>,
  maxMeters: number,
): T[] {
  const geometry = route.geometry;
  if (geometry.length === 0) return [];
  return items.filter(({ coordinate }) => {
    const metresPerLongitude = 111_320 * Math.cos((coordinate.latitude * Math.PI) / 180);
    const limitSquared = maxMeters ** 2;
    let previousX = ((geometry[0]?.[0] ?? 0) - coordinate.longitude) * metresPerLongitude;
    let previousY = ((geometry[0]?.[1] ?? 0) - coordinate.latitude) * 110_540;
    if (previousX ** 2 + previousY ** 2 <= limitSquared) return true;
    for (let index = 1; index < geometry.length; index += 1) {
      const x = ((geometry[index]?.[0] ?? 0) - coordinate.longitude) * metresPerLongitude;
      const y = ((geometry[index]?.[1] ?? 0) - coordinate.latitude) * 110_540;
      const segmentX = x - previousX;
      const segmentY = y - previousY;
      const lengthSquared = segmentX ** 2 + segmentY ** 2;
      const along =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, -(previousX * segmentX + previousY * segmentY) / lengthSquared),
            );
      const nearestX = previousX + segmentX * along;
      const nearestY = previousY + segmentY * along;
      if (nearestX ** 2 + nearestY ** 2 <= limitSquared) return true;
      previousX = x;
      previousY = y;
    }
    return false;
  });
}

/** The `id` property of the first rendered feature that carries one. */
export function renderedFeatureId(
  features: readonly { properties?: Record<string, unknown> | null }[],
): string | undefined {
  return features
    .map((feature) => feature.properties?.id)
    .find((id): id is string => typeof id === 'string');
}

export function droppedPinResult(coordinate: Coordinate): SearchResult {
  const latitude = coordinate.latitude.toFixed(5);
  const longitude = coordinate.longitude.toFixed(5);
  return {
    category: 'landmark',
    center: coordinate,
    confidence: 1,
    id: `dropped-pin:${latitude}:${longitude}`,
    label: `${latitude}, ${longitude}`,
    name: 'Dropped pin',
  };
}

export function routeBounds(
  route: RouteAlternativeV2,
): [west: number, south: number, east: number, north: number] {
  return route.geometry.reduce<[number, number, number, number]>(
    (bounds, position) => [
      Math.min(bounds[0], position[0]),
      Math.min(bounds[1], position[1]),
      Math.max(bounds[2], position[0]),
      Math.max(bounds[3], position[1]),
    ],
    [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  );
}

// Authoritative metadata only: enforced direction describes which traffic flow is monitored, not
// which way the camera optically faces, and neither source publishes optical facing. Never infer
// either from a road name.
export function cameraDetailMessage(
  enforcement: readonly string[],
  direction: string | undefined,
): string {
  const enforcementLabel = enforcement
    .map((type) =>
      type === 'red-light' ? 'red light' : type === 'speed-on-green' ? 'speed on green' : type,
    )
    .join(' and ');
  const directionLine =
    direction === undefined
      ? 'Enforced direction: unspecified by this source.'
      : `Enforced direction: ${direction} traffic. This is the monitored traffic flow, not the camera's optical facing, which this source does not publish.`;
  return `${enforcementLabel.length > 0 ? enforcementLabel : 'Unspecified'} enforcement camera.\n${directionLine}`;
}

export function roadEventMessage(event: MapRoadEvent): string {
  if ('regionId' in event) {
    const end = event.endsAt === undefined ? '' : `\nEnds: ${event.endsAt.replace('T', ' ')}`;
    const source = event.regionId === 'ontario' ? 'Ontario 511' : 'DriveBC Open511';
    return `Official ${source} road information\n\n${event.description}\n\nStarts: ${event.startsAt.replace('T', ' ')}${end}`;
  }

  const confidence =
    event.confidence === 'official'
      ? 'Official City of Calgary construction information'
      : 'Unverified current incident information';
  const end =
    event.endsAtLocal === undefined ? '' : `\nEnds: ${event.endsAtLocal.replace('T', ' ')}`;
  return `${confidence}\n\n${event.description}\n\nStarts: ${event.startsAtLocal.replace('T', ' ')}${end}\nTime zone: America/Edmonton`;
}

/** Source and freshness line for the road-event overlay. Undefined when the overlay is off. */
export function roadEventStatusLabel({
  hasSnapshot,
  refreshDelayed,
  region,
  stale,
}: {
  hasSnapshot: boolean;
  refreshDelayed: boolean;
  region: RoadEventRegion | undefined;
  stale: boolean;
}): string | undefined {
  if (!hasSnapshot) return refreshDelayed ? 'Road events unavailable' : undefined;
  const source =
    region === 'ontario'
      ? 'Road events · Ontario 511 · Official'
      : region === 'kelowna-bc'
        ? 'Road events · DriveBC · Official'
        : 'Road events · City of Calgary · Incidents unverified';
  return `${source}${stale ? ' · Stale snapshot' : ''}${refreshDelayed ? ' · Refresh delayed' : ''}`;
}

/** Basemap and overlay data credits for what is currently drawn. */
export function mapAttributionLabel({
  hasTorontoCameras,
  mapRegion,
  roadEventRegion,
}: {
  hasTorontoCameras: boolean;
  mapRegion: MapRegion | undefined;
  roadEventRegion: RoadEventRegion | undefined;
}): string {
  return [
    '© OpenMapTiles · © OpenStreetMap',
    roadEventRegion === 'calgary' ? ' · © City of Calgary' : '',
    hasTorontoCameras ? ' · © City of Toronto' : '',
    roadEventRegion === 'ontario' ? ' · Ontario 511' : '',
    mapRegion === 'kelowna-bc' ? ' · DriveBC · RCMP' : '',
  ].join('');
}
