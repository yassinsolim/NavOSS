#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiKey = process.env.GOOGLE_ROUTES_API_KEY;
if (apiKey === undefined || apiKey.length < 20) {
  throw new Error('GOOGLE_ROUTES_API_KEY is required.');
}

const benchmarkPath = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  process.env.ROUTE_QUALITY_CASES ?? 'apps/api/scripts/route-quality-calgary-50.json',
);
const navOSSPath = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  process.env.NAVOSS_ROUTE_QUALITY_RESULT ?? 'artifacts/route-quality-calgary-50-current.json',
);
const outputPath = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  process.env.GOOGLE_ROUTES_COMPARISON_OUTPUT ?? 'artifacts/google-routes-comparison-summary.json',
);
const benchmarkText = await readFile(benchmarkPath, 'utf8');
const benchmark = JSON.parse(benchmarkText);
const navOSS = JSON.parse(await readFile(navOSSPath, 'utf8'));
const benchmarkDefinitionHash = createHash('sha256').update(benchmarkText).digest('hex');

const anchors = benchmark.anchors;
const cases = benchmark.corridors.flatMap((corridor) => [
  {
    destination: anchors[corridor.destinationAnchorId].coordinate,
    id: `${corridor.originAnchorId}-to-${corridor.destinationAnchorId}`,
    origin: anchors[corridor.originAnchorId].coordinate,
  },
  {
    destination: anchors[corridor.originAnchorId].coordinate,
    id: `${corridor.destinationAnchorId}-to-${corridor.originAnchorId}`,
    origin: anchors[corridor.destinationAnchorId].coordinate,
  },
]);
const navOSSById = new Map(navOSS.results.map((result) => [result.id, result]));
if (
  navOSS.benchmarkId !== benchmark.benchmarkId ||
  navOSS.benchmarkDefinitionHash !== benchmarkDefinitionHash ||
  navOSS.total !== cases.length ||
  navOSSById.size !== cases.length
) {
  throw new Error('NavOSS result does not match the current benchmark definition.');
}

function seconds(duration) {
  if (typeof duration !== 'string' || !duration.endsWith('s')) return Number.NaN;
  return Number(duration.slice(0, -1));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function summary(values) {
  return {
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
  };
}

function signedSummary(values) {
  return {
    median: percentile(values, 0.5),
    p25: percentile(values, 0.25),
    p75: percentile(values, 0.75),
    navOSSHighCount: values.filter((value) => value > 0).length,
    navOSSLowCount: values.filter((value) => value < 0).length,
  };
}

const comparisons = [];
for (const routeCase of cases) {
  const navOSSResult = navOSSById.get(routeCase.id);
  if (navOSSResult === undefined) throw new Error(`Missing NavOSS result: ${routeCase.id}`);
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    body: JSON.stringify({
      computeAlternativeRoutes: false,
      destination: { location: { latLng: routeCase.destination } },
      origin: { location: { latLng: routeCase.origin } },
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      travelMode: 'DRIVE',
      units: 'METRIC',
    }),
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
      'x-goog-fieldmask': 'routes.distanceMeters,routes.duration,routes.staticDuration',
    },
    method: 'POST',
  });
  if (!response.ok) {
    const problem = await response.text();
    throw new Error(
      `Google Routes failed for ${routeCase.id}: ${String(response.status)} ${problem.slice(0, 200)}`,
    );
  }
  const route = (await response.json()).routes?.[0];
  const googleDuration = seconds(route?.duration);
  const googleStaticDuration = seconds(route?.staticDuration);
  const googleDistance = route?.distanceMeters;
  if (![googleDuration, googleStaticDuration, googleDistance].every(Number.isFinite)) {
    throw new Error(`Google Routes returned incomplete metrics for ${routeCase.id}`);
  }
  const navOSSDistance = navOSSResult.metrics.distanceKm * 1_000;
  const navOSSDuration = navOSSResult.metrics.durationMinutes * 60;
  comparisons.push({
    id: routeCase.id,
    distanceDeltaPercent: ((navOSSDistance - googleDistance) / googleDistance) * 100,
    staticDurationDeltaPercent:
      ((navOSSDuration - googleStaticDuration) / googleStaticDuration) * 100,
    trafficDurationDeltaPercent: ((navOSSDuration - googleDuration) / googleDuration) * 100,
    googleTrafficDelayPercent:
      ((googleDuration - googleStaticDuration) / googleStaticDuration) * 100,
  });
}

const absoluteDistanceDeltas = comparisons.map((result) => Math.abs(result.distanceDeltaPercent));
const absoluteStaticDurationDeltas = comparisons.map((result) =>
  Math.abs(result.staticDurationDeltaPercent),
);
const absoluteTrafficDurationDeltas = comparisons.map((result) =>
  Math.abs(result.trafficDurationDeltaPercent),
);
const result = {
  benchmarkDefinitionHash,
  benchmarkId: benchmark.benchmarkId,
  comparedAt: new Date().toISOString(),
  comparison: 'Google Routes API TRAFFIC_AWARE_OPTIMAL, not the Google Maps consumer app',
  count: comparisons.length,
  distanceAbsoluteDeltaPercent: summary(absoluteDistanceDeltas),
  distanceSignedDeltaPercent: signedSummary(comparisons.map((entry) => entry.distanceDeltaPercent)),
  freeFlowDurationAbsoluteDeltaPercent: summary(absoluteStaticDurationDeltas),
  freeFlowDurationSignedDeltaPercent: signedSummary(
    comparisons.map((entry) => entry.staticDurationDeltaPercent),
  ),
  trafficDurationAbsoluteDeltaPercent: summary(absoluteTrafficDurationDeltas),
  trafficDurationSignedDeltaPercent: signedSummary(
    comparisons.map((entry) => entry.trafficDurationDeltaPercent),
  ),
  googleTrafficDelayPercent: summary(comparisons.map((entry) => entry.googleTrafficDelayPercent)),
  distanceOutlierCount: comparisons.filter((entry) => Math.abs(entry.distanceDeltaPercent) > 15)
    .length,
  freeFlowDurationOutlierCount: comparisons.filter(
    (entry) => Math.abs(entry.staticDurationDeltaPercent) > 25,
  ).length,
  trafficDurationOutlierCount: comparisons.filter(
    (entry) => Math.abs(entry.trafficDurationDeltaPercent) > 25,
  ).length,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
