#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Real Calgary out-and-back captured from valhalla1.openstreetmap.de on 2026-08-29 by routing
// 51.0447,-114.0719 -> 51.0665,-114.0870 and then back. Keeping the geometry checked in makes
// the control and bound reproducible without a live routing service.
const geometry = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../test/fixtures/calgary-out-and-back.json'), 'utf8'),
);
const earthRadiusMeters = 6_371_000;
const metersPerDegreeLatitude = 111_320;
const noiseLevelsMeters = [4, 8];
const samplesPerSegment = 4;
const seeds = [7, 11, 23, 31];
const windowsMeters = [50, 100, 150, 200, 250, 300, 350, 400, 500, Number.POSITIVE_INFINITY];

function coordinateDistance(start, end) {
  const latitudeDelta = ((end[0] - start[0]) * Math.PI) / 180;
  const longitudeDelta = ((end[1] - start[1]) * Math.PI) / 180;
  const startLatitude = (start[0] * Math.PI) / 180;
  const endLatitude = (end[0] * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

// Mirrors navOSSCarPlaySegmentProjection, including its coordinate-relative longitude scale.
function segmentProjection(coordinate, start, end) {
  const longitudeScale = metersPerDegreeLatitude * Math.cos((coordinate[0] * Math.PI) / 180);
  const startX = (start[1] - coordinate[1]) * longitudeScale;
  const startY = (start[0] - coordinate[0]) * metersPerDegreeLatitude;
  const endX = (end[1] - coordinate[1]) * longitudeScale;
  const endY = (end[0] - coordinate[0]) * metersPerDegreeLatitude;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  const fraction =
    squaredLength === 0
      ? 0
      : Math.min(1, Math.max(0, -(startX * deltaX + startY * deltaY) / squaredLength));
  return {
    distanceMeters: Math.hypot(startX + fraction * deltaX, startY + fraction * deltaY),
    fraction,
  };
}

const segmentLengths = geometry
  .slice(0, -1)
  .map((coordinate, index) => coordinateDistance(coordinate, geometry[index + 1]));
const cumulativeLengths = [0];
for (const length of segmentLengths) {
  cumulativeLengths.push(cumulativeLengths.at(-1) + length);
}

function projectedAlongRoute(index, fraction) {
  return cumulativeLengths[index] + fraction * segmentLengths[index];
}

function nearestSegment(coordinate, completedLength, maximumLookbackMeters) {
  let best;
  for (let index = 0; index < geometry.length - 1; index += 1) {
    const projection = segmentProjection(coordinate, geometry[index], geometry[index + 1]);
    const lookback = completedLength - projectedAlongRoute(index, projection.fraction);
    if (lookback > maximumLookbackMeters) continue;
    if (best === undefined || projection.distanceMeters < best.distanceMeters) {
      best = { index, lookback, ...projection };
    }
  }
  return best;
}

// Mulberry32 plus Box-Muller: small, deterministic, and independent of host or Node version.
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function casesFor(seed, noiseMeters) {
  const random = randomGenerator(seed);
  const cases = [];
  for (let index = 1; index < geometry.length - 1; index += 1) {
    for (let sample = 0; sample < samplesPerSegment; sample += 1) {
      const fraction = random();
      const start = geometry[index];
      const end = geometry[index + 1];
      const coordinate = [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ];
      const longitudeScale = metersPerDegreeLatitude * Math.cos((coordinate[0] * Math.PI) / 180);
      cases.push({
        completedLength: projectedAlongRoute(index, fraction),
        coordinate: [
          coordinate[0] + (gaussian(random) * noiseMeters) / metersPerDegreeLatitude,
          coordinate[1] + (gaussian(random) * noiseMeters) / longitudeScale,
        ],
      });
    }
  }
  return cases;
}

function evaluate(cases, windowMeters) {
  let degradedLegitimateMatches = 0;
  let resurrections = 0;
  let worstResurrection;
  for (const sample of cases) {
    const global = nearestSegment(
      sample.coordinate,
      sample.completedLength,
      Number.POSITIVE_INFINITY,
    );
    const bounded = nearestSegment(sample.coordinate, sample.completedLength, windowMeters);
    if (global === undefined || bounded === undefined)
      throw new Error('Route search returned no candidate.');
    if (bounded.lookback > 250) {
      resurrections += 1;
      if (worstResurrection === undefined || bounded.lookback > worstResurrection.lookback) {
        worstResurrection = bounded;
      }
    }
    if (global.lookback <= 250 && bounded.distanceMeters - global.distanceMeters > 1) {
      degradedLegitimateMatches += 1;
    }
  }
  return { degradedLegitimateMatches, resurrections, worstResurrection };
}

const runs = [];
for (const seed of seeds) {
  for (const noiseMeters of noiseLevelsMeters) {
    const cases = casesFor(seed, noiseMeters);
    runs.push({ cases, noiseMeters, seed });
  }
}

console.log(
  `route: ${geometry.length} vertices, ${(cumulativeLengths.at(-1) / 1000).toFixed(2)} km`,
);
console.log('cells are resurrections/legitimate-matches-degraded-by-more-than-1m');
console.log(
  `${'seed'.padStart(5)} ${'noise'.padStart(6)} | ${windowsMeters
    .map((window) => (Number.isFinite(window) ? `${window}m` : 'global').padStart(8))
    .join(' | ')}`,
);
for (const run of runs) {
  const cells = windowsMeters.map((window) => {
    const result = evaluate(run.cases, window);
    return `${result.resurrections}/${result.degradedLegitimateMatches}`.padStart(8);
  });
  console.log(
    `${String(run.seed).padStart(5)} ${`${run.noiseMeters}m`.padStart(6)} | ${cells.join(' | ')}`,
  );
}

const allCases = runs.flatMap((run) => run.cases);
const globalResult = evaluate(allCases, Number.POSITIVE_INFINITY);
const selectedResult = evaluate(allCases, 250);
const tightResult = evaluate(allCases, 50);
const looseResult = evaluate(allCases, 400);
console.log(
  `control: ${globalResult.resurrections}/${allCases.length} resurrections, worst ${Math.round(
    globalResult.worstResurrection?.lookback ?? 0,
  )} m behind`,
);

if (globalResult.resurrections === 0) throw new Error('Control did not reproduce the defect.');
if (selectedResult.resurrections !== 0 || selectedResult.degradedLegitimateMatches !== 0) {
  throw new Error('250 m is not in the measured safe band.');
}
if (tightResult.degradedLegitimateMatches === 0) {
  throw new Error('Tight-bound control did not degrade a legitimate match.');
}
if (looseResult.resurrections === 0) {
  throw new Error('Loose-bound control did not resurrect a travelled leg.');
}
console.log('PASS: control fires; 250 m is clean; both unsafe sides fail.');
