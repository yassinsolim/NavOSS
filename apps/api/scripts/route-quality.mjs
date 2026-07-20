#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const apiUrl = process.env.NAVOSS_API_URL ?? 'http://127.0.0.1:3001';
const cases = JSON.parse(
  await readFile(new URL('./route-quality-cases.json', import.meta.url), 'utf8'),
);

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceMeters(origin, destination) {
  const latitudeDelta = toRadians(destination.latitude - origin.latitude);
  const longitudeDelta = toRadians(destination.longitude - origin.longitude);
  const originLatitude = toRadians(origin.latitude);
  const destinationLatitude = toRadians(destination.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 12_742_000 * Math.asin(Math.sqrt(haversine));
}

function positionCoordinate([longitude, latitude]) {
  return { latitude, longitude };
}

function manualComparisonLinks(routeCase) {
  const origin = `${String(routeCase.origin.latitude)},${String(routeCase.origin.longitude)}`;
  const destination = `${String(routeCase.destination.latitude)},${String(routeCase.destination.longitude)}`;
  return {
    appleMaps: `https://maps.apple.com/?saddr=${origin}&daddr=${destination}&dirflg=d`,
    googleMaps:
      `https://www.google.com/maps/dir/?api=1&origin=${origin}` +
      `&destination=${destination}&travelmode=driving`,
  };
}

function analyze(routeCase, route, response, latencyMs, avoidHighways) {
  const geometryDistanceMeters = route.geometry
    .slice(1)
    .reduce(
      (total, position, index) =>
        total +
        distanceMeters(positionCoordinate(route.geometry[index]), positionCoordinate(position)),
      0,
    );
  const stepDistanceMeters = route.steps.reduce((total, step) => total + step.distanceMeters, 0);
  const spokenStepCount = route.steps.filter((step) => step.spokenInstruction !== undefined).length;
  const maximumSegmentMeters = route.geometry
    .slice(1)
    .reduce(
      (maximum, position, index) =>
        Math.max(
          maximum,
          distanceMeters(positionCoordinate(route.geometry[index]), positionCoordinate(position)),
        ),
      0,
    );
  const metrics = {
    alternatives: response.routes.length,
    averageKph: (route.distanceMeters / route.durationSeconds) * 3.6,
    destinationOffsetMeters: distanceMeters(
      positionCoordinate(route.geometry.at(-1)),
      routeCase.destination,
    ),
    distanceKm: route.distanceMeters / 1_000,
    durationMinutes: route.durationSeconds / 60,
    geometryPoints: route.geometry.length,
    geometryRatio: geometryDistanceMeters / route.distanceMeters,
    latencyMs,
    maximumSegmentMeters,
    originOffsetMeters: distanceMeters(positionCoordinate(route.geometry[0]), routeCase.origin),
    spokenCoverage: spokenStepCount / route.steps.length,
    stepRatio: stepDistanceMeters / route.distanceMeters,
    steps: route.steps.length,
  };
  const failures = [];
  const [minimumDistanceKm, maximumDistanceKm] = routeCase.distanceRangeKm;

  if (metrics.alternatives < 1 || metrics.alternatives > 3) failures.push('alternative count');
  if (metrics.averageKph < 8 || metrics.averageKph > 110) failures.push('average speed');
  if (metrics.distanceKm < minimumDistanceKm || metrics.distanceKm > maximumDistanceKm) {
    failures.push('distance range');
  }
  if (metrics.durationMinutes < 3 || metrics.durationMinutes > 90) failures.push('duration range');
  if (metrics.geometryPoints < 20) failures.push('geometry detail');
  if (Math.abs(metrics.geometryRatio - 1) > 0.03) failures.push('geometry distance');
  if (latencyMs > 5_000) failures.push('latency');
  if (metrics.maximumSegmentMeters > 2_000) failures.push('geometry gap');
  if (metrics.originOffsetMeters > routeCase.maximumEndpointOffsetMeters) {
    failures.push('origin access');
  }
  if (metrics.destinationOffsetMeters > routeCase.maximumEndpointOffsetMeters) {
    failures.push('destination access');
  }
  if (metrics.spokenCoverage < 0.75) failures.push('spoken instruction coverage');
  if (Math.abs(metrics.stepRatio - 1) > 0.03) failures.push('step distance');
  if (response.source.traffic !== 'unavailable') failures.push('traffic posture');

  return {
    avoidHighways,
    failures,
    id: routeCase.id,
    links: avoidHighways ? undefined : manualComparisonLinks(routeCase),
    metrics,
    routeFingerprint: JSON.stringify(route.geometry),
  };
}

async function runCase(routeCase, avoidHighways) {
  const startedAt = performance.now();
  const response = await fetch(new URL('/v1/routes', apiUrl), {
    body: JSON.stringify({
      alternatives: 1,
      destination: routeCase.destination,
      origin: routeCase.origin,
      preferences: {
        avoidFerries: false,
        avoidHighways,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    return {
      avoidHighways,
      failures: [`HTTP ${String(response.status)}`],
      id: routeCase.id,
      metrics: { latencyMs },
    };
  }

  const payload = await response.json();
  const route = payload.routes[0];
  if (route === undefined) {
    return {
      avoidHighways,
      failures: ['missing route'],
      id: routeCase.id,
      metrics: { latencyMs },
    };
  }

  return analyze(routeCase, route, payload, latencyMs, avoidHighways);
}

const results = [];
for (const routeCase of cases) {
  const defaultResult = await runCase(routeCase, false);
  results.push(defaultResult);

  if (routeCase.testAvoidHighways === true) {
    const avoidanceResult = await runCase(routeCase, true);
    if (
      defaultResult.routeFingerprint !== undefined &&
      defaultResult.routeFingerprint === avoidanceResult.routeFingerprint
    ) {
      avoidanceResult.failures.push('avoid-highways route unchanged');
    }
    results.push(avoidanceResult);
  }
}

for (const result of results) {
  const mode = result.avoidHighways ? 'avoid-highways' : 'default';
  const verdict = result.failures.length === 0 ? 'PASS' : `FAIL: ${result.failures.join(', ')}`;
  const metrics = result.metrics;
  console.log(
    `${verdict.padEnd(28)} ${result.id.padEnd(32)} ${mode.padEnd(15)} ` +
      `${(metrics.distanceKm ?? 0).toFixed(1)} km  ` +
      `${(metrics.durationMinutes ?? 0).toFixed(1)} min  ${String(metrics.latencyMs)} ms`,
  );
}

const failures = results.filter((result) => result.failures.length > 0);
const latencies = results
  .map((result) => result.metrics.latencyMs)
  .filter((value) => Number.isFinite(value))
  .sort((left, right) => left - right);
const percentileIndex = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
console.log(
  JSON.stringify(
    {
      failed: failures.length,
      manualComparisons: results
        .filter((result) => result.links !== undefined)
        .map(({ id, links, metrics }) => ({ id, links, metrics })),
      passed: results.length - failures.length,
      p95LatencyMs: latencies[percentileIndex],
      total: results.length,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  process.exitCode = 1;
}
