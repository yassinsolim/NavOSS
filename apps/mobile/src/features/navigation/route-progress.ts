import type { Coordinate, RouteAlternative } from '@navoss/contracts';

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function distanceMeters(
  coordinate: Coordinate,
  position: [longitude: number, latitude: number],
): number {
  const latitudeDelta = toRadians(position[1] - coordinate.latitude);
  const longitudeDelta = toRadians(position[0] - coordinate.longitude);
  const originLatitude = toRadians(coordinate.latitude);
  const destinationLatitude = toRadians(position[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

function remainingStepFraction(
  coordinate: Coordinate,
  geometry: RouteAlternative['geometry'],
): number {
  const latitudeScale = Math.cos(toRadians(coordinate.latitude));
  let closestDistanceSquared = Number.POSITIVE_INFINITY;
  let closestSegmentIndex = 0;
  let closestSegmentProgress = 0;
  const segmentLengths: number[] = [];

  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index];
    const end = geometry[index + 1];

    const startX = (start[0] - coordinate.longitude) * latitudeScale;
    const startY = start[1] - coordinate.latitude;
    const segmentX = (end[0] - start[0]) * latitudeScale;
    const segmentY = end[1] - start[1];
    const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
    const segmentProgress =
      segmentLengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared));
    const projectedX = startX + segmentX * segmentProgress;
    const projectedY = startY + segmentY * segmentProgress;
    const projectedDistanceSquared = projectedX ** 2 + projectedY ** 2;

    segmentLengths.push(
      distanceMeters({ latitude: start[1], longitude: start[0] }, [end[0], end[1]]),
    );
    if (projectedDistanceSquared < closestDistanceSquared) {
      closestDistanceSquared = projectedDistanceSquared;
      closestSegmentIndex = index;
      closestSegmentProgress = segmentProgress;
    }
  }

  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (totalLength === 0) {
    return 1;
  }

  const completedLength =
    segmentLengths.slice(0, closestSegmentIndex).reduce((sum, length) => sum + length, 0) +
    (segmentLengths[closestSegmentIndex] ?? 0) * closestSegmentProgress;
  return Math.max(0, Math.min(1, (totalLength - completedLength) / totalLength));
}

export function findNearestStepIndex(route: RouteAlternative, coordinate: Coordinate): number {
  let nearestStepIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  route.steps.forEach((step, stepIndex) => {
    step.geometry.forEach((position) => {
      const candidateDistance = distanceMeters(coordinate, position);
      if (candidateDistance < nearestDistance) {
        nearestDistance = candidateDistance;
        nearestStepIndex = stepIndex;
      }
    });
  });

  return nearestStepIndex;
}

export function getRemainingRouteSummary(
  route: RouteAlternative,
  stepIndex: number,
  coordinate?: Coordinate,
): { distanceMeters: number; durationSeconds: number } {
  const currentStepIndex = Math.max(0, Math.min(stepIndex, route.steps.length - 1));
  const currentStep = route.steps[currentStepIndex];
  const remainingFraction =
    coordinate === undefined ? 1 : remainingStepFraction(coordinate, currentStep.geometry);

  return route.steps.slice(currentStepIndex).reduce(
    (summary, step) => ({
      distanceMeters:
        summary.distanceMeters +
        step.distanceMeters * (step === currentStep ? remainingFraction : 1),
      durationSeconds:
        summary.durationSeconds +
        step.durationSeconds * (step === currentStep ? remainingFraction : 1),
    }),
    { distanceMeters: 0, durationSeconds: 0 },
  );
}

export function formatDuration(durationSeconds: number): string {
  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${String(hours)} hr`
    : `${String(hours)} hr ${String(remainingMinutes)} min`;
}

export function formatDistance(distanceMetersValue: number): string {
  if (distanceMetersValue < 1_000) {
    return `${String(Math.max(10, Math.round(distanceMetersValue / 10) * 10))} m`;
  }

  return `${(distanceMetersValue / 1_000).toFixed(1)} km`;
}

export function formatArrivalTime(durationSeconds: number, now: Date = new Date()): string {
  const arrival = new Date(now.getTime() + durationSeconds * 1_000);
  return arrival.toLocaleTimeString('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function routeViaLabel(route: RouteAlternative): string {
  const roadDistances = new Map<string, number>();

  route.steps.forEach((step) => {
    const roadName = step.roadName.trim();
    if (roadName.length === 0) {
      return;
    }

    roadDistances.set(roadName, (roadDistances.get(roadName) ?? 0) + step.distanceMeters);
  });

  const majorRoads = [...roadDistances.entries()]
    .filter(([, distance]) => distance >= 500)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([roadName]) => roadName);

  return majorRoads.length === 0 ? 'Direct route' : `via ${majorRoads.join(' / ')}`;
}
