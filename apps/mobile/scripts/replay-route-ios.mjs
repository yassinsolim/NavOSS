#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import { RouteResponseSchema, SearchResponseSchema } from '@navoss/contracts';

const apiUrl = process.env.NAVOSS_API_URL ?? 'http://127.0.0.1:3001';
const simulatorName = process.env.NAVOSS_SIMULATOR_NAME ?? 'NavOSS iPhone 15 Pro Max';
const destinationQuery =
  process.env.NAVOSS_SIMULATION_DESTINATION ?? 'Calgary International Airport';
const speedMetersPerSecond = Number(process.env.NAVOSS_SIMULATION_SPEED_MPS ?? '25');
const intervalSeconds = Number(process.env.NAVOSS_SIMULATION_INTERVAL_SECONDS ?? '1');
const headDistanceMeters = Number(process.env.NAVOSS_SIMULATION_HEAD_METERS ?? '0');
const tailDistanceMeters = Number(process.env.NAVOSS_SIMULATION_TAIL_METERS ?? '0');
const origin = {
  latitude: Number(process.env.NAVOSS_SIMULATION_ORIGIN_LATITUDE ?? '51.0447'),
  longitude: Number(process.env.NAVOSS_SIMULATION_ORIGIN_LONGITUDE ?? '-114.0719'),
};
const dryRun = process.argv.includes('--dry-run');

function requireFinitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
}

function requireFiniteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
}

function distanceMeters(origin, destination) {
  const latitudeDelta = ((destination[1] - origin[1]) * Math.PI) / 180;
  const longitudeDelta = ((destination[0] - origin[0]) * Math.PI) / 180;
  const originLatitude = (origin[1] * Math.PI) / 180;
  const destinationLatitude = (destination[1] * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 12_742_000 * Math.asin(Math.sqrt(haversine));
}

function routeWaypoints(geometry) {
  return geometry.filter((position, index) => {
    const previous = geometry[index - 1];
    return previous === undefined || position[0] !== previous[0] || position[1] !== previous[1];
  });
}

function routeTailWaypoints(waypoints, maximumDistanceMeters) {
  if (maximumDistanceMeters === 0) {
    return waypoints;
  }

  let accumulatedDistanceMeters = 0;
  let startIndex = waypoints.length - 1;

  while (startIndex > 0 && accumulatedDistanceMeters < maximumDistanceMeters) {
    accumulatedDistanceMeters += distanceMeters(waypoints[startIndex - 1], waypoints[startIndex]);
    startIndex -= 1;
  }

  return waypoints.slice(startIndex);
}

function routeHeadWaypoints(waypoints, maximumDistanceMeters) {
  if (maximumDistanceMeters === 0) {
    return waypoints;
  }

  let accumulatedDistanceMeters = 0;
  let endIndex = 0;

  while (endIndex < waypoints.length - 1 && accumulatedDistanceMeters < maximumDistanceMeters) {
    accumulatedDistanceMeters += distanceMeters(waypoints[endIndex], waypoints[endIndex + 1]);
    endIndex += 1;
  }

  return waypoints.slice(0, endIndex + 1);
}

function findSimulatorId() {
  const output = execFileSync('xcrun', ['simctl', 'list', '--json', 'devices', 'available'], {
    encoding: 'utf8',
  });
  const payload = JSON.parse(output);
  const simulator = Object.values(payload.devices)
    .flat()
    .find((device) => device.isAvailable && device.name === simulatorName);

  if (simulator === undefined) {
    throw new Error(`Simulator not found: ${simulatorName}`);
  }

  return simulator.udid;
}

requireFinitePositive(speedMetersPerSecond, 'NAVOSS_SIMULATION_SPEED_MPS');
requireFinitePositive(intervalSeconds, 'NAVOSS_SIMULATION_INTERVAL_SECONDS');
requireFiniteNonNegative(headDistanceMeters, 'NAVOSS_SIMULATION_HEAD_METERS');
requireFiniteNonNegative(tailDistanceMeters, 'NAVOSS_SIMULATION_TAIL_METERS');
if (headDistanceMeters > 0 && tailDistanceMeters > 0) {
  throw new Error('Only one route replay distance limit may be set.');
}

const searchUrl = new URL('/v1/search', apiUrl);
const searchResponse = SearchResponseSchema.parse(
  await fetch(searchUrl, {
    body: JSON.stringify({ limit: 8, q: destinationQuery }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }).then((response) => response.json()),
);
const destination =
  searchResponse.results.find((result) => result.name === destinationQuery) ??
  searchResponse.results[0];

if (destination === undefined) {
  throw new Error(`No destination matched: ${destinationQuery}`);
}

const routeResponse = RouteResponseSchema.parse(
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
const route = routeResponse.routes[0];
if (route === undefined) {
  throw new Error('The route response contained no route.');
}

const routeGeometryWaypoints = routeWaypoints(route.geometry);
const waypoints =
  tailDistanceMeters > 0
    ? routeTailWaypoints(routeGeometryWaypoints, tailDistanceMeters)
    : routeHeadWaypoints(routeGeometryWaypoints, headDistanceMeters);
if (waypoints.length < 2) {
  throw new Error('The route geometry contained fewer than two distinct waypoints.');
}
console.log(
  `Prepared ${String(waypoints.length)} route-geometry waypoints to ${destination.name} ` +
    `(${String(Math.round(route.durationSeconds / 60))} min, ` +
    `${String(Math.round(route.distanceMeters / 100) / 10)} km).`,
);

if (!dryRun) {
  const simulatorId = findSimulatorId();
  const waypointInput = `${waypoints
    .map(([longitude, latitude]) => `${String(latitude)},${String(longitude)}`)
    .join('\n')}\n`;
  execFileSync(
    'xcrun',
    [
      'simctl',
      'location',
      simulatorId,
      'start',
      `--speed=${String(speedMetersPerSecond)}`,
      `--interval=${String(intervalSeconds)}`,
      '-',
    ],
    { input: waypointInput, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  console.log(`Started route playback on ${simulatorName}.`);
}
