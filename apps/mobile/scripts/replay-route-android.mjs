#!/usr/bin/env node
// Drives an Android emulator along a planned route with `adb emu geo fix`, one fix a second, so
// the app's own location provider (not the in-app simulated drive) feeds navigation. Plans the
// same route the app does for a destination picked by search text, from the emulator's start.
// Coordinates are never printed.
//
//   NAVOSS_ADB_SERIAL=emulator-5584 node scripts/replay-route-android.mjs [--place-origin]
//
// NAVOSS_SIMULATION_HEAD_METERS stops after that much of the route; NAVOSS_SIMULATION_DETOUR_METERS
// then keeps driving straight on for that distance (a wrong turn), to exercise rerouting.

import { execFileSync } from 'node:child_process';

import { RouteResponseSchema, SearchResponseSchema } from '@navoss/contracts';

const apiUrl = process.env.NAVOSS_API_URL ?? 'https://navoss-api.yassin.app';
const serial = process.env.NAVOSS_ADB_SERIAL ?? 'emulator-5554';
const searchText = process.env.NAVOSS_SIMULATION_SEARCH_TEXT ?? 'Airport';
const destinationName =
  process.env.NAVOSS_SIMULATION_DESTINATION ?? 'Calgary International Airport';
const speed = Number(process.env.NAVOSS_SIMULATION_SPEED_MPS ?? '20');
const headMeters = Number(process.env.NAVOSS_SIMULATION_HEAD_METERS ?? '0');
const detourMeters = Number(process.env.NAVOSS_SIMULATION_DETOUR_METERS ?? '0');
const origin = {
  latitude: Number(process.env.NAVOSS_SIMULATION_ORIGIN_LATITUDE ?? '51.0447'),
  longitude: Number(process.env.NAVOSS_SIMULATION_ORIGIN_LONGITUDE ?? '-114.0719'),
};

const radians = (degrees) => (degrees * Math.PI) / 180;

function meters(a, b) {
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

function geoFix([longitude, latitude]) {
  execFileSync('adb', ['-s', serial, 'emu', 'geo', 'fix', String(longitude), String(latitude)], {
    stdio: 'ignore',
  });
}

if (process.argv.includes('--place-origin')) {
  geoFix([origin.longitude, origin.latitude]);
  console.log('Placed the emulator at the replay origin.');
  process.exit(0);
}

const search = SearchResponseSchema.parse(
  await fetch(new URL('/v1/search', apiUrl), {
    body: JSON.stringify({ limit: 8, q: searchText }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }).then((response) => response.json()),
);
const destination = search.results.find((result) => result.name.startsWith(destinationName));
if (destination === undefined) throw new Error(`No place named ${destinationName}.`);
await new Promise((resolve) => setTimeout(resolve, 1_000));
const routes = RouteResponseSchema.parse(
  await fetch(new URL('/v1/routes', apiUrl), {
    body: JSON.stringify({
      alternatives: 1,
      destination: destination.center,
      origin,
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }).then((response) => response.json()),
);
const route = routes.routes[0];
if (route === undefined) throw new Error('No route.');

// Positions one second apart along the geometry at `speed`.
const points = route.geometry.filter(
  (point, index) =>
    index === 0 ||
    point[0] !== route.geometry[index - 1][0] ||
    point[1] !== route.geometry[index - 1][1],
);
const fixes = [points[0]];
let travelled = 0;
let carried = 0;
for (let index = 1; index < points.length; index += 1) {
  const [a, b] = [points[index - 1], points[index]];
  const length = meters(a, b);
  let along = speed - carried;
  while (along <= length) {
    if (headMeters > 0 && travelled + along > headMeters) break;
    const t = along / length;
    fixes.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    along += speed;
  }
  if (headMeters > 0 && travelled + along > headMeters) break;
  carried = length - (along - speed);
  travelled += length;
}
if (headMeters === 0) fixes.push(points.at(-1));
if (detourMeters > 0 && fixes.length >= 2) {
  const [a, b] = fixes.slice(-2);
  const step = meters(a, b) || 1;
  const [dx, dy] = [(b[0] - a[0]) / step, (b[1] - a[1]) / step];
  // Turn 90° right off the route and keep going.
  for (let d = speed; d <= detourMeters; d += speed) fixes.push([b[0] + dy * d, b[1] - dx * d]);
}
console.log(
  `Replaying ${String(fixes.length)} fixes (${String(Math.round(route.distanceMeters / 100) / 10)} km route` +
    `${headMeters > 0 ? `, first ${String(headMeters)} m` : ''}${detourMeters > 0 ? `, then ${String(detourMeters)} m off route` : ''}).`,
);
for (const fix of fixes) {
  const started = Date.now();
  geoFix(fix);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1_000 - (Date.now() - started))));
}
console.log('Replay finished.');
