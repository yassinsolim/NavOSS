#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import { RouteResponseSchema, SearchResponseSchema } from '@navoss/contracts';

const apiUrl = process.env.NAVOSS_API_URL ?? 'http://127.0.0.1:3001';
const simulatorName = process.env.NAVOSS_SIMULATOR_NAME ?? 'NavOSS iPhone 15 Pro Max';
// The replay must drive to the place the app is navigating to. The Maestro flow that starts the
// trip (`.maestro/start-airport-simulation.yaml`) types `Airport` and taps the first row named
// `Calgary International Airport…`, so the same search text and the same rule pick it here.
// Searching for the full name instead returns other places of that name first (the airport
// grounds, a kilometre from the terminal), and the replay then drives away from the trip.
const searchText = process.env.NAVOSS_SIMULATION_SEARCH_TEXT ?? 'Airport';
const destinationName =
  process.env.NAVOSS_SIMULATION_DESTINATION ?? 'Calgary International Airport';
const speedMetersPerSecond = Number(process.env.NAVOSS_SIMULATION_SPEED_MPS ?? '25');
const intervalSeconds = Number(process.env.NAVOSS_SIMULATION_INTERVAL_SECONDS ?? '1');
const headDistanceMeters = Number(process.env.NAVOSS_SIMULATION_HEAD_METERS ?? '0');
// `--print-approach-origin` prints, instead of replaying, the point this far before the end of
// the route from the origin. The arrival phase puts the simulator there before it plans the
// trip, so the trip it starts is a real short final approach that is then driven in full: the
// position never jumps along the route faster than a vehicle could drive it.
const approachDistanceMeters = Number(process.env.NAVOSS_SIMULATION_APPROACH_METERS ?? '0');
const origin = {
  latitude: Number(process.env.NAVOSS_SIMULATION_ORIGIN_LATITUDE ?? '51.0447'),
  longitude: Number(process.env.NAVOSS_SIMULATION_ORIGIN_LONGITUDE ?? '-114.0719'),
};
const dryRun = process.argv.includes('--dry-run');
const printApproachOrigin = process.argv.includes('--print-approach-origin');

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

/** The point `approachMeters` before the end of the route, interpolated along its geometry. */
function routeApproachPoint(waypoints, approachMeters) {
  let remainingMeters = approachMeters;
  for (let index = waypoints.length - 1; index > 0; index -= 1) {
    const start = waypoints[index - 1];
    const end = waypoints[index];
    const lengthMeters = distanceMeters(start, end);
    if (lengthMeters >= remainingMeters) {
      const fraction = (lengthMeters - remainingMeters) / lengthMeters;
      return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
    }
    remainingMeters -= lengthMeters;
  }
  throw new Error(`The route is shorter than the ${String(approachMeters)} m approach.`);
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
if (printApproachOrigin) {
  requireFinitePositive(approachDistanceMeters, 'NAVOSS_SIMULATION_APPROACH_METERS');
}

const searchUrl = new URL('/v1/search', apiUrl);
const searchResponse = SearchResponseSchema.parse(
  await fetch(searchUrl, {
    body: JSON.stringify({ limit: 8, q: searchText }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }).then((response) => response.json()),
);
const destination = searchResponse.results.find((result) =>
  result.name.startsWith(destinationName),
);

if (destination === undefined) {
  throw new Error(`Searching "${searchText}" returned no place named ${destinationName}.`);
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
if (printApproachOrigin) {
  const [longitude, latitude] = routeApproachPoint(routeGeometryWaypoints, approachDistanceMeters);
  console.error(
    `Approach origin ${String(approachDistanceMeters)} m before ${destination.name} on a ` +
      `${String(Math.round(route.distanceMeters / 100) / 10)} km route.`,
  );
  console.log(`${latitude.toFixed(6)},${longitude.toFixed(6)}`);
  process.exit(0);
}
const waypoints = routeHeadWaypoints(routeGeometryWaypoints, headDistanceMeters);
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
