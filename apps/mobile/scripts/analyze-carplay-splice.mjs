#!/usr/bin/env node

// Demonstrates the defect behind issue #13 on real geometry, and that the shipped lookback bound
// removes it.
//
// Deliberately not a sweep. A bound of W rejects every candidate more than W behind, so asking
// "does bound W prevent splices past W" is a tautology, and a table of such columns looks like
// evidence while measuring nothing. Two earlier versions of this file made exactly that mistake.
// The constant itself is derived in CarPlayTrip.swift from the interpolation contract and is
// bracketed by Swift tests; this script's only job is to show the unbounded search is genuinely
// harmful on a real out-and-back, and that the bound fixes it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Real Calgary out-and-back captured from valhalla1.openstreetmap.de on 2026-08-29 by routing
// 51.0447,-114.0719 -> 51.0665,-114.0870 and back, so the two carriageways are genuinely parallel.
const geometry = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../test/fixtures/calgary-out-and-back.json'), 'utf8'),
);
// Must match navOSSMaximumSegmentLookbackMeters in CarPlayTrip.swift.
const shippedLookbackMeters = 250;
const earthRadiusMeters = 6_371_000;
const metersPerDegreeLatitude = 111_320;
const samplesPerSegment = 4;
const seeds = [7, 11, 23, 31];
// The puck trails the snapshot by interpolation. Two seconds at highway speed is the worst case the
// renderer can produce, so lag is drawn up to that rather than assumed to be zero: with the puck
// sitting exactly on the progress point, the backward search is never exercised at all.
const maximumLagMeters = 100;
const lateralNoiseMeters = 8;

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
const routeLengthMeters = cumulativeLengths.at(-1);

// Derive the turnaround from the geometry rather than from how the fixture was concatenated. The
// route's outbound leg ends at the point furthest from the origin along the road; hardcoding the
// A->B vertex count mislabelled eight segments, because that leg already doubles back into its
// destination.
const turnaroundIndex = geometry.reduce(
  (furthest, coordinate, index) =>
    coordinateDistance(geometry[0], coordinate) >
    coordinateDistance(geometry[0], geometry[furthest])
      ? index
      : furthest,
  0,
);

function legOf(segmentIndex) {
  return segmentIndex < turnaroundIndex ? 'outbound' : 'return';
}

function projectedAlongRoute(index, fraction) {
  return cumulativeLengths[index] + fraction * segmentLengths[index];
}

function positionAt(alongRouteMeters) {
  const clamped = Math.min(Math.max(alongRouteMeters, 0), routeLengthMeters);
  let index = 0;
  while (index < segmentLengths.length - 1 && cumulativeLengths[index + 1] < clamped) index += 1;
  const fraction =
    segmentLengths[index] === 0 ? 0 : (clamped - cumulativeLengths[index]) / segmentLengths[index];
  const start = geometry[index];
  const end = geometry[index + 1];
  return {
    coordinate: [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ],
    index,
  };
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

// Mulberry32 plus Box-Muller: deterministic and independent of host or Node version.
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
  return (
    Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random()))) * Math.cos(2 * Math.PI * random())
  );
}

function cases() {
  const generated = [];
  for (const seed of seeds) {
    const random = randomGenerator(seed);
    for (let index = 1; index < geometry.length - 1; index += 1) {
      for (let sample = 0; sample < samplesPerSegment; sample += 1) {
        const completedLength = projectedAlongRoute(index, random());
        // The puck trails the progress point, which is the only condition under which a backward
        // search runs at all.
        const puck = positionAt(completedLength - random() * maximumLagMeters);
        const longitudeScale =
          metersPerDegreeLatitude * Math.cos((puck.coordinate[0] * Math.PI) / 180);
        generated.push({
          completedLength,
          coordinate: [
            puck.coordinate[0] + (gaussian(random) * lateralNoiseMeters) / metersPerDegreeLatitude,
            puck.coordinate[1] + (gaussian(random) * lateralNoiseMeters) / longitudeScale,
          ],
          leg: legOf(puck.index),
        });
      }
    }
  }
  return generated;
}

// A wrong-leg match is harmful when the two carriageways are far apart along the route. Near the
// turnaround they coincide, so either answer draws the same road.
function wrongLegMatches(samples, maximumLookbackMeters) {
  let count = 0;
  let worstLookbackMeters = 0;
  for (const sample of samples) {
    const match = nearestSegment(sample.coordinate, sample.completedLength, maximumLookbackMeters);
    if (match === undefined) continue;
    if (legOf(match.index) !== sample.leg && match.lookback > 2 * maximumLagMeters) {
      count += 1;
      worstLookbackMeters = Math.max(worstLookbackMeters, match.lookback);
    }
  }
  return { count, worstLookbackMeters };
}

const samples = cases();
const unbounded = wrongLegMatches(samples, Number.POSITIVE_INFINITY);
const bounded = wrongLegMatches(samples, shippedLookbackMeters);

console.log(`route: ${geometry.length} vertices, ${(routeLengthMeters / 1000).toFixed(2)} km`);
console.log(`turnaround derived at vertex ${turnaroundIndex}`);
console.log(`samples: ${samples.length} (lagging puck, ${lateralNoiseMeters} m lateral noise)`);
console.log(
  `unbounded search: ${unbounded.count} wrong-carriageway matches, ` +
    `worst ${Math.round(unbounded.worstLookbackMeters)} m behind`,
);
console.log(`${shippedLookbackMeters} m bound: ${bounded.count} wrong-carriageway matches`);

if (turnaroundIndex <= 0 || turnaroundIndex >= geometry.length - 1) {
  throw new Error('Turnaround derivation failed; the fixture may not be an out-and-back.');
}
if (unbounded.count === 0) {
  throw new Error('Control did not reproduce the defect; the harness proves nothing.');
}
// The bound does not eliminate wrong-carriageway matches and this script does not pretend it
// does. Where the two carriageways run within the lookback of each other along the route, a puck
// with lateral noise is genuinely ambiguous from position alone, and resolving that would need
// heading. What the bound removes is the catastrophic case: a splice kilometres back. Require a
// large reduction and report the residual rather than asserting zero.
if (bounded.count * 10 > unbounded.count) {
  throw new Error(
    `The bound reduced wrong-carriageway matches only from ${unbounded.count} to ${bounded.count}.`,
  );
}
console.log(
  `PASS: bound cuts wrong-carriageway matches ${unbounded.count} -> ${bounded.count}; ` +
    `residual is near-turnaround ambiguity, bounded to ${shippedLookbackMeters} m rather than ` +
    `${Math.round(unbounded.worstLookbackMeters)} m.`,
);
