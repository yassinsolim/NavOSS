// Replays one synthetic drive as several simulated contributors against a local NavOSS API and
// shows road segments becoming published only once the contributor threshold is reached.
//
//   COMMUNITY_TRAFFIC_MODE=live VALHALLA_URL=http://127.0.0.1:8002/route PORT=3012 \
//     corepack pnpm --filter @navoss/api dev
//   corepack pnpm --filter @navoss/api traffic:replay
//
// Environment:
//   NAVOSS_API_URL                    API base URL (default http://127.0.0.1:3012)
//   TRAFFIC_REPLAY_ORIGIN             "lat,lon" (default downtown Calgary)
//   TRAFFIC_REPLAY_DESTINATION        "lat,lon" (default Calgary International Airport)
//   TRAFFIC_REPLAY_CONTRIBUTORS       simulated drivers (default: threshold + 1)
//   TRAFFIC_REPLAY_VALHALLA_ROUTE_URL take the drive from this Valhalla /route endpoint instead
//                                     of the API, for a local graph outside NavOSS coverage
//
// Each contributor is a distinct X-Forwarded-For address, which the API honours only from a
// loopback or private peer. The positions are synthetic; never point this at production.

const apiUrl = (process.env.NAVOSS_API_URL ?? 'http://127.0.0.1:3012').replace(/\/$/, '');
const parseCoordinate = (value, fallback) => {
  const [latitude, longitude] = (value ?? fallback).split(',').map(Number);
  return { latitude, longitude };
};
const origin = parseCoordinate(process.env.TRAFFIC_REPLAY_ORIGIN, '51.0447,-114.0719');
const destination = parseCoordinate(process.env.TRAFFIC_REPLAY_DESTINATION, '51.13157,-114.01055');
const valhallaRouteUrl = process.env.TRAFFIC_REPLAY_VALHALLA_ROUTE_URL;

const SAMPLE_SECONDS = 2;
const FLOW_GRID_DEGREES = 0.05;

function haversineMeters([fromLongitude, fromLatitude], [toLongitude, toLatitude]) {
  const radians = Math.PI / 180;
  const a =
    Math.sin(((toLatitude - fromLatitude) * radians) / 2) ** 2 +
    Math.cos(fromLatitude * radians) *
      Math.cos(toLatitude * radians) *
      Math.sin(((toLongitude - fromLongitude) * radians) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  return { body, status: response.status };
}

async function loadDriveGeometry() {
  if (valhallaRouteUrl !== undefined) {
    const { body, status } = await requestJson(valhallaRouteUrl, {
      body: JSON.stringify({
        costing: 'auto',
        format: 'osrm',
        locations: [origin, destination].map(({ latitude, longitude }) => ({
          lat: latitude,
          lon: longitude,
        })),
        shape_format: 'geojson',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (status !== 200) throw new Error(`Valhalla route failed with status ${String(status)}.`);
    return body.routes[0].geometry.coordinates;
  }
  const { body, status } = await requestJson(`${apiUrl}/v1/routes`, {
    body: JSON.stringify({ alternatives: 0, destination, origin }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (status !== 200) throw new Error(`API route failed with status ${String(status)}.`);
  return body.routes[0].geometry;
}

/** One fix every SAMPLE_SECONDS at a constant speed, nudged off the centreline like real GPS. */
function simulateDrive(geometry, speedKph, contributorIndex) {
  const stepMeters = (speedKph / 3.6) * SAMPLE_SECONDS;
  const fixes = [];
  let untilNextFix = 0;
  for (let index = 1; index < geometry.length; index += 1) {
    const from = geometry[index - 1];
    const to = geometry[index];
    const length = haversineMeters(from, to);
    let along = untilNextFix;
    while (along <= length && length > 0) {
      const share = along / length;
      const jitterDegrees = (((fixes.length * 7 + contributorIndex * 3) % 5) - 2) * 0.00001;
      fixes.push([
        from[0] + (to[0] - from[0]) * share + jitterDegrees,
        from[1] + (to[1] - from[1]) * share + jitterDegrees,
      ]);
      along += stepMeters;
    }
    untilNextFix = along - length;
  }
  return fixes;
}

/**
 * The client half of the privacy contract: drop everything within `trimMeters` of the trip's start
 * and end, then cut what is left into batches that each start their own clock at zero.
 */
function buildBatches(fixes, rules, driveEndMs) {
  const distances = [0];
  for (let index = 1; index < fixes.length; index += 1) {
    distances.push(distances[index - 1] + haversineMeters(fixes[index - 1], fixes[index]));
  }
  const total = distances.at(-1);
  const batches = [];
  let current = [];
  const flush = () => {
    if (current.length >= rules.minPoints) batches.push(current);
    current = [];
  };
  fixes.forEach((fix, index) => {
    if (distances[index] < rules.tripEndTrimMeters) return;
    if (distances[index] > total - rules.tripEndTrimMeters) return;
    current.push({ distance: distances[index], fix, second: index * SAMPLE_SECONDS });
    const first = current[0];
    const seconds = index * SAMPLE_SECONDS - first.second;
    const meters = distances[index] - first.distance;
    if (
      (seconds >= rules.batchTargetSeconds && meters >= rules.batchTargetMeters) ||
      current.length >= rules.maxPoints ||
      seconds >= rules.maxBatchSeconds - SAMPLE_SECONDS
    ) {
      flush();
    }
  });
  flush();
  const driveSeconds = (fixes.length - 1) * SAMPLE_SECONDS;
  return batches.map((points) => {
    // A long drive is squeezed into the last ten minutes so every batch still counts as current.
    const startMs = driveEndMs - Math.min(600, driveSeconds - points[0].second) * 1_000;
    return {
      capturedAt: new Date(Math.floor(startMs / 60_000) * 60_000).toISOString(),
      points: points.map(({ fix, second }) => [
        Number(fix[0].toFixed(5)),
        Number(fix[1].toFixed(5)),
        second - points[0].second,
      ]),
      schemaVersion: rules.schemaVersion,
    };
  });
}

function flowBounds(geometry) {
  const longitudes = geometry.map(([longitude]) => longitude);
  const latitudes = geometry.map(([, latitude]) => latitude);
  const floor = (value) => Math.floor(value / FLOW_GRID_DEGREES);
  const ceil = (value) => Math.ceil(value / FLOW_GRID_DEGREES);
  return [
    floor(Math.min(...longitudes)),
    floor(Math.min(...latitudes)),
    ceil(Math.max(...longitudes)),
    ceil(Math.max(...latitudes)),
  ]
    .map((cells) => (cells * FLOW_GRID_DEGREES).toFixed(2))
    .join(',');
}

const { body: status, status: statusCode } = await requestJson(`${apiUrl}/v1/traffic/status`);
if (statusCode !== 200 || status.probes.accepting !== true) {
  console.error(
    'The API is not accepting traffic batches. Start it with COMMUNITY_TRAFFIC_MODE=live.',
  );
  process.exit(1);
}
const threshold = status.publication.minimumContributors;
const contributors = Number(process.env.TRAFFIC_REPLAY_CONTRIBUTORS ?? threshold + 1);
const geometry = await loadDriveGeometry();
const bbox = flowBounds(geometry);
console.log(
  `Mode ${status.mode}; publication needs ${String(threshold)} independent contributors within ${String(status.publication.windowSeconds / 60)} min.`,
);

const publishedAfter = [];
for (let contributor = 0; contributor < contributors; contributor += 1) {
  const speedKph = 34 + contributor * 4;
  const batches = buildBatches(
    simulateDrive(geometry, speedKph, contributor),
    status.probes,
    Date.now(),
  );
  const outcomes = {};
  for (const batch of batches) {
    const { status: code } = await requestJson(`${apiUrl}${status.probes.endpoint}`, {
      body: JSON.stringify(batch),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${String(10 + contributor)}`,
      },
      method: 'POST',
    });
    outcomes[code] = (outcomes[code] ?? 0) + 1;
  }
  const flow = await requestJson(`${apiUrl}/v1/traffic/flow?bbox=${bbox}`);
  const published = flow.status === 200 ? flow.body.features.length : 0;
  publishedAfter.push(published);
  const levels = {};
  for (const feature of flow.body?.features ?? []) {
    levels[feature.properties.congestion] = (levels[feature.properties.congestion] ?? 0) + 1;
  }
  console.log(
    `Contributor ${String(contributor + 1)} at ${String(speedKph)} km/h: ${String(batches.length)} batches ${JSON.stringify(outcomes)} -> ${String(published)} published segments${published > 0 ? ` ${JSON.stringify(levels)}` : ''}${flow.status === 200 ? '' : ` (flow status ${String(flow.status)})`}`,
  );
}

const coverage = (await requestJson(`${apiUrl}/v1/traffic/status`)).body.coverage;
if (coverage !== undefined) console.log(`Service-wide coverage: ${JSON.stringify(coverage)}`);

const hiddenBelowThreshold = publishedAfter.slice(0, threshold - 1).every((count) => count === 0);
const publishedAtThreshold = (publishedAfter[threshold - 1] ?? 0) > 0;
if (!hiddenBelowThreshold || !publishedAtThreshold) {
  console.error(
    'FAILED: segments must stay hidden below the threshold and appear once it is reached.',
  );
  process.exit(1);
}
console.log(
  `OK: nothing was published for the first ${String(threshold - 1)} contributors; segments appeared with contributor ${String(threshold)}.`,
);
