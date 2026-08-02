#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { resolveInputPath } from './resolve-input-path.mjs';

const apiUrl = process.env.NAVOSS_API_URL ?? 'http://127.0.0.1:3001';
const outputPath =
  process.env.ROUTE_QUALITY_OUTPUT === undefined
    ? undefined
    : resolve(process.env.INIT_CWD ?? process.cwd(), process.env.ROUTE_QUALITY_OUTPUT);
const casesPath =
  process.env.ROUTE_QUALITY_CASES === undefined
    ? new URL('./route-quality-cases.json', import.meta.url)
    : await resolveInputPath(process.env.ROUTE_QUALITY_CASES);
const casesText = await readFile(casesPath, 'utf8');
const casesPayload = JSON.parse(casesText);
const benchmarkDefinitionHash = createHash('sha256').update(casesText).digest('hex');

function expandCases(payload) {
  if (Array.isArray(payload)) return payload;
  const anchors = payload.anchors ?? {};
  return (payload.corridors ?? []).flatMap((corridor) => {
    const origin = anchors[corridor.originAnchorId]?.coordinate;
    const destination = anchors[corridor.destinationAnchorId]?.coordinate;
    if (origin === undefined || destination === undefined) {
      throw new Error(`Unknown benchmark anchor in corridor ${corridor.id}`);
    }
    const shared = {
      ...corridor,
      reciprocalGroup: corridor.id,
    };
    return [
      {
        ...shared,
        destination,
        id: `${corridor.originAnchorId}-to-${corridor.destinationAnchorId}`,
        origin,
      },
      {
        ...shared,
        destination: origin,
        id: `${corridor.destinationAnchorId}-to-${corridor.originAnchorId}`,
        origin: destination,
      },
    ];
  });
}

const cases = expandCases(casesPayload);
const benchmarkId = Array.isArray(casesPayload)
  ? 'regional-route-quality'
  : casesPayload.benchmarkId;
if (
  !Array.isArray(casesPayload) &&
  casesPayload.expectedCaseCount !== undefined &&
  cases.length !== casesPayload.expectedCaseCount
) {
  throw new Error(
    `Benchmark ${benchmarkId} expected ${String(casesPayload.expectedCaseCount)} cases; found ${String(cases.length)}`,
  );
}

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
  const straightLineDistanceKm = distanceMeters(routeCase.origin, routeCase.destination) / 1_000;
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
    circuity: route.distanceMeters / 1_000 / straightLineDistanceKm,
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
    straightLineDistanceKm,
    uniqueAlternatives: new Set(
      response.routes.map((alternative) =>
        createHash('sha256').update(JSON.stringify(alternative.geometry)).digest('hex'),
      ),
    ).size,
  };
  const failures = [];
  const warnings = [];

  if (metrics.alternatives < 1 || metrics.alternatives > 3) failures.push('alternative count');
  if (metrics.uniqueAlternatives !== metrics.alternatives) failures.push('duplicate alternatives');
  if (metrics.averageKph < 8 || metrics.averageKph > 110) failures.push('average speed');
  if (routeCase.distanceRangeKm === undefined) {
    if (metrics.circuity > (routeCase.maximumCircuity ?? 2.5)) failures.push('circuity');
  } else {
    const [minimumDistanceKm, maximumDistanceKm] = routeCase.distanceRangeKm;
    if (metrics.distanceKm < minimumDistanceKm || metrics.distanceKm > maximumDistanceKm) {
      failures.push('distance range');
    }
  }
  const maximumDurationMinutes = routeCase.maximumDurationMinutes ?? 90;
  if (metrics.durationMinutes < 1 || metrics.durationMinutes > maximumDurationMinutes) {
    failures.push('duration range');
  }
  if (metrics.geometryPoints < (routeCase.minimumGeometryPoints ?? 20)) {
    failures.push('geometry detail');
  }
  if (Math.abs(metrics.geometryRatio - 1) > 0.03) failures.push('geometry distance');
  if (latencyMs > 5_000) failures.push('latency');
  if (metrics.maximumSegmentMeters > (routeCase.maximumSegmentMeters ?? 2_000)) {
    failures.push('geometry gap');
  }
  if (metrics.originOffsetMeters > routeCase.maximumEndpointOffsetMeters) {
    failures.push('origin access');
  }
  if (metrics.destinationOffsetMeters > routeCase.maximumEndpointOffsetMeters) {
    failures.push('destination access');
  }
  if (metrics.spokenCoverage < 0.75) failures.push('spoken instruction coverage');
  if (Math.abs(metrics.stepRatio - 1) > 0.03) failures.push('step distance');
  if (response.source.traffic !== 'unavailable') failures.push('traffic posture');
  if (response.degraded !== false) failures.push('degraded route source');
  if (response.source.id !== 'valhalla-self-hosted') failures.push('route source');
  if (response.source.mode !== 'production') failures.push('route mode');
  if (metrics.alternatives < 2) warnings.push('no alternate route');
  if (metrics.circuity > (routeCase.reviewCircuity ?? 1.8)) warnings.push('high circuity');
  if (metrics.originOffsetMeters > 50) warnings.push('origin entrance review');
  if (metrics.destinationOffsetMeters > 50) warnings.push('destination entrance review');

  return {
    avoidHighways,
    failures,
    id: routeCase.id,
    lengthBand: routeCase.lengthBand,
    links: avoidHighways ? undefined : manualComparisonLinks(routeCase),
    metrics,
    primaryRoads: [...new Set(route.steps.map((step) => step.roadName).filter(Boolean))],
    reciprocalGroup: routeCase.reciprocalGroup,
    routeFingerprint: createHash('sha256').update(JSON.stringify(route.geometry)).digest('hex'),
    tags: routeCase.tags,
    warnings,
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

const reciprocalGroups = Map.groupBy(
  results.filter((result) => !result.avoidHighways && result.reciprocalGroup !== undefined),
  (result) => result.reciprocalGroup,
);
for (const reciprocalResults of reciprocalGroups.values()) {
  if (reciprocalResults.length !== 2) continue;
  const [first, second] = reciprocalResults;
  const distanceRatio =
    Math.max(first.metrics.distanceKm, second.metrics.distanceKm) /
    Math.min(first.metrics.distanceKm, second.metrics.distanceKm);
  const durationRatio =
    Math.max(first.metrics.durationMinutes, second.metrics.durationMinutes) /
    Math.min(first.metrics.durationMinutes, second.metrics.durationMinutes);
  if (distanceRatio > 1.35) {
    first.warnings.push('reciprocal distance asymmetry');
    second.warnings.push('reciprocal distance asymmetry');
  }
  if (durationRatio > 1.5) {
    first.warnings.push('reciprocal duration asymmetry');
    second.warnings.push('reciprocal duration asymmetry');
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
const benchmarkResults = results.map((result) => {
  const sanitized = { ...result, geometryHash: result.routeFingerprint };
  delete sanitized.links;
  delete sanitized.routeFingerprint;
  return sanitized;
});
const summary = {
  apiUrl,
  benchmarkDefinitionHash,
  benchmarkId,
  failed: failures.length,
  generatedAt: new Date().toISOString(),
  passed: results.length - failures.length,
  p95LatencyMs: latencies[percentileIndex],
  results: benchmarkResults,
  total: results.length,
};
console.log(JSON.stringify(summary, null, 2));
if (outputPath !== undefined) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
