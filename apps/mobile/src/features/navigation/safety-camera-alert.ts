import type { Coordinate, RouteAlternative, SafetyCamera } from '@navoss/contracts';

const EARTH_RADIUS_METERS = 6_371_000;
const MAXIMUM_ALERT_DISTANCE_METERS = 450;
const MAXIMUM_DIRECTION_DELTA_DEGREES = 60;
const MAXIMUM_ROUTE_OFFSET_METERS = 45;
const METERS_PER_DEGREE_LATITUDE = (Math.PI * EARTH_RADIUS_METERS) / 180;

const DIRECTION_BEARINGS: Record<SafetyCamera['direction'], number> = {
  eastbound: 90,
  northbound: 0,
  southbound: 180,
  westbound: 270,
};

interface RouteSegment {
  courseDegrees: number;
  cumulativeDistanceMeters: number;
  end: RouteAlternative['geometry'][number];
  lengthMeters: number;
  start: RouteAlternative['geometry'][number];
}

export interface UpcomingSafetyCamera {
  camera: SafetyCamera;
  distanceAheadMeters: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function distanceMeters(
  origin: RouteAlternative['geometry'][number],
  destination: RouteAlternative['geometry'][number],
): number {
  const latitudeDelta = toRadians(destination[1] - origin[1]);
  const longitudeDelta = toRadians(destination[0] - origin[0]);
  const originLatitude = toRadians(origin[1]);
  const destinationLatitude = toRadians(destination[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

function courseDegrees(
  origin: RouteAlternative['geometry'][number],
  destination: RouteAlternative['geometry'][number],
): number {
  const latitudeDelta = destination[1] - origin[1];
  const meanLatitude = toRadians((origin[1] + destination[1]) / 2);
  const longitudeDelta = (destination[0] - origin[0]) * Math.cos(meanLatitude);
  const degrees = (Math.atan2(longitudeDelta, latitudeDelta) * 180) / Math.PI;
  return degrees >= 0 ? degrees : degrees + 360;
}

function courseDifferenceDegrees(first: number, second: number): number {
  const difference = Math.abs(first - second) % 360;
  return Math.min(difference, 360 - difference);
}

function routeSegments(route: RouteAlternative): RouteSegment[] {
  const segments: RouteSegment[] = [];
  let cumulativeDistanceMeters = 0;

  for (let index = 0; index < route.geometry.length - 1; index += 1) {
    const start = route.geometry[index];
    const end = route.geometry[index + 1];
    const lengthMeters = distanceMeters(start, end);
    if (lengthMeters === 0) {
      continue;
    }

    segments.push({
      courseDegrees: courseDegrees(start, end),
      cumulativeDistanceMeters,
      end,
      lengthMeters,
      start,
    });
    cumulativeDistanceMeters += lengthMeters;
  }

  return segments;
}

function projectCoordinate(coordinate: Coordinate, segment: RouteSegment) {
  const longitudeScale = Math.cos(toRadians(coordinate.latitude));
  const startX =
    (segment.start[0] - coordinate.longitude) * METERS_PER_DEGREE_LATITUDE * longitudeScale;
  const startY = (segment.start[1] - coordinate.latitude) * METERS_PER_DEGREE_LATITUDE;
  const segmentX =
    (segment.end[0] - segment.start[0]) * METERS_PER_DEGREE_LATITUDE * longitudeScale;
  const segmentY = (segment.end[1] - segment.start[1]) * METERS_PER_DEGREE_LATITUDE;
  const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
  const segmentProgress =
    segmentLengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared));

  return {
    distanceAlongRouteMeters:
      segment.cumulativeDistanceMeters + segment.lengthMeters * segmentProgress,
    distanceFromRouteMeters: Math.hypot(
      startX + segmentX * segmentProgress,
      startY + segmentY * segmentProgress,
    ),
  };
}

export function findUpcomingSafetyCamera(
  cameras: readonly SafetyCamera[],
  route: RouteAlternative,
  routeProgress: number,
  announcedCameraIds: ReadonlySet<string>,
): UpcomingSafetyCamera | undefined {
  const segments = routeSegments(route);
  const totalDistanceMeters = segments.reduce((total, segment) => total + segment.lengthMeters, 0);
  if (totalDistanceMeters === 0) {
    return undefined;
  }

  const currentDistanceAlongRouteMeters =
    Math.max(0, Math.min(1, routeProgress)) * totalDistanceMeters;
  let upcomingCamera: UpcomingSafetyCamera | undefined;

  for (const camera of cameras) {
    if (announcedCameraIds.has(camera.id)) {
      continue;
    }

    for (const segment of segments) {
      const projection = projectCoordinate(camera.coordinate, segment);
      const distanceAheadMeters =
        projection.distanceAlongRouteMeters - currentDistanceAlongRouteMeters;
      if (
        projection.distanceFromRouteMeters > MAXIMUM_ROUTE_OFFSET_METERS ||
        distanceAheadMeters <= 0 ||
        distanceAheadMeters > MAXIMUM_ALERT_DISTANCE_METERS ||
        courseDifferenceDegrees(DIRECTION_BEARINGS[camera.direction], segment.courseDegrees) >
          MAXIMUM_DIRECTION_DELTA_DEGREES
      ) {
        continue;
      }

      if (
        upcomingCamera === undefined ||
        distanceAheadMeters < upcomingCamera.distanceAheadMeters
      ) {
        upcomingCamera = { camera, distanceAheadMeters };
      }
    }
  }

  return upcomingCamera;
}
