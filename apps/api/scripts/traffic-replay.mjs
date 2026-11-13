// Replays one synthetic drive as several simulated installations against a local NavOSS API and
// shows road edges becoming published only after the contributor threshold is reached AND the
// publication epoch has closed, and that one installation counts once whatever network or
// credential it uploads with.
//
// The API must run with real storage and a real Valhalla, and must accept development keys:
//
//   PGHOST=127.0.0.1 PGPORT=5442 PGUSER=navoss PGPASSWORD=navoss PGDATABASE=navoss \
//     node apps/api/dist/migrate.js
//   PGHOST=127.0.0.1 PGPORT=5442 PGUSER=navoss PGPASSWORD=navoss PGDATABASE=navoss \
//     COMMUNITY_TRAFFIC_MODE=live COMMUNITY_ATTESTATION_MODE=allow-development \
//     APP_ATTEST_TEAM_ID=ABCDE12345 COMMUNITY_INSTALLATION_SECRET=$(openssl rand -hex 32) \
//     VALHALLA_URL=http://127.0.0.1:8002/route PORT=3012 node apps/api/dist/server.js
//   PGHOST=127.0.0.1 PGPORT=5442 PGUSER=navoss PGPASSWORD=navoss PGDATABASE=navoss \
//     APP_ATTEST_TEAM_ID=ABCDE12345 corepack pnpm --filter @navoss/api traffic:replay
//
// An installation gets no upload credential until it is a day old, so the script dates the
// development installations it just registered two days back, directly in the API's database (the
// PG* variables). They are still newcomers, so each uploads from its own network.
//
// It waits for two real epoch boundaries, so a run takes between five and ten minutes.
//
// Environment:
//   NAVOSS_API_URL                    API base URL (default http://127.0.0.1:3012)
//   APP_ATTEST_TEAM_ID                the API's team id (required; it is part of every assertion)
//   APP_ATTEST_BUNDLE_ID              the API's bundle id (default org.navoss.mobile)
//   TRAFFIC_REPLAY_ORIGIN             "lat,lon" (default downtown Calgary)
//   TRAFFIC_REPLAY_DESTINATION        "lat,lon" (default Calgary International Airport)
//   TRAFFIC_REPLAY_VALHALLA_ROUTE_URL take the drive from this Valhalla /route endpoint instead
//                                     of the API, for a local graph outside NavOSS coverage
//
// Each installation is a software development key, which a production server
// (COMMUNITY_ATTESTATION_MODE=enforce) refuses. The positions are synthetic; never point this at
// production.

import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

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
function buildBatches(fixes, rules, driveEndMs, credential) {
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
    // A long drive is squeezed into the last eight minutes so every batch still counts as current.
    const startMs = driveEndMs - Math.min(480, driveSeconds - points[0].second) * 1_000;
    return {
      capturedAt: new Date(Math.floor(startMs / 60_000) * 60_000).toISOString(),
      credential,
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

const teamId = process.env.APP_ATTEST_TEAM_ID;
if (teamId === undefined) {
  console.error('Set APP_ATTEST_TEAM_ID to the value the API was started with.');
  process.exit(1);
}
const rpIdHash = createHash('sha256')
  .update(`${teamId}.${process.env.APP_ATTEST_BUNDLE_ID ?? 'org.navoss.mobile'}`)
  .digest();

function cborBytes(bytes) {
  const head =
    bytes.length < 24
      ? Buffer.from([0x40 | bytes.length])
      : bytes.length < 0x100
        ? Buffer.from([0x58, bytes.length])
        : Buffer.from([0x59, bytes.length >> 8, bytes.length & 0xff]);
  return Buffer.concat([head, bytes]);
}

function cborText(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x60 | bytes.length]), bytes]);
}

async function post(path, body, headers = {}) {
  return requestJson(`${apiUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
}

async function challenge() {
  const { body, status } = await post('/v2/community/challenges');
  if (status !== 200) throw new Error(`Challenge failed with status ${String(status)}.`);
  return body.challenge;
}

/** A software stand-in for an App Attest key: what a simulator build registers. */
async function registerInstallation() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const keyId = createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
      ]),
    )
    .digest('base64');
  const { status } = await post('/v2/community/installations', {
    challenge: await challenge(),
    keyId,
    kind: 'development',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  });
  if (status !== 201) {
    throw new Error(
      `Registration failed with status ${String(status)}. Start the API with COMMUNITY_ATTESTATION_MODE=allow-development.`,
    );
  }
  return { counter: 0, keyId, privateKey };
}

/** One fresh assertion for the `traffic-credential` operation, exchanged for a credential. */
async function requestCredential(installation) {
  const value = await challenge();
  installation.counter += 1;
  const authenticatorData = Buffer.alloc(37);
  rpIdHash.copy(authenticatorData, 0);
  authenticatorData.writeUInt8(0x40, 32);
  authenticatorData.writeUInt32BE(installation.counter, 33);
  const clientDataHash = createHash('sha256')
    .update(`navoss-community-v1\ntraffic-credential\n${value}`)
    .digest();
  const nonce = createHash('sha256').update(authenticatorData).update(clientDataHash).digest();
  const signature = sign('sha256', nonce, { dsaEncoding: 'der', key: installation.privateKey });
  const assertion = Buffer.concat([
    Buffer.from([0xa2]),
    cborText('signature'),
    cborBytes(signature),
    cborText('authenticatorData'),
    cborBytes(authenticatorData),
  ]).toString('base64');
  const { body, status } = await post('/v2/traffic/credentials', {
    assertion: { assertion, challenge: value, keyId: installation.keyId },
  });
  if (status !== 200) throw new Error(`Credential request failed with status ${String(status)}.`);
  return body.credential;
}

const { body: status, status: statusCode } = await requestJson(`${apiUrl}/v2/traffic/status`);
if (statusCode !== 200 || status.mode !== 'live' || status.probes.accepting !== true) {
  console.error(
    'The API is not publishing community traffic. Start it as described at the top of this script.',
  );
  process.exit(1);
}
const threshold = status.publication.minimumContributors;
const epochMs = status.publication.epochSeconds * 1_000;
const geometry = await loadDriveGeometry();
const bbox = flowBounds(geometry);
console.log(
  `Mode ${status.mode}; an edge is published once ${String(threshold)} installations drove it within ${String(status.publication.cohortSeconds / 60)} min, at the next ${String(status.publication.epochSeconds / 60)}-minute boundary.`,
);

async function upload(installation, label, speedKph, network) {
  const credential = await requestCredential(installation);
  const batches = buildBatches(
    simulateDrive(geometry, speedKph, network),
    status.probes,
    Date.now(),
    credential,
  );
  const outcomes = {};
  for (const batch of batches) {
    const { status: code } = await post(status.probes.endpoint, batch, {
      'x-forwarded-for': `198.51.${String(100 + network)}.10`,
    });
    outcomes[code] = (outcomes[code] ?? 0) + 1;
  }
  console.log(
    `${label} at ${String(speedKph)} km/h from network ${String(network)}: ${String(batches.length)} batches ${JSON.stringify(outcomes)}`,
  );
}

async function published(when) {
  const flow = await requestJson(`${apiUrl}/v2/traffic/flow?bbox=${bbox}`);
  if (flow.status !== 200) throw new Error(`Flow failed with status ${String(flow.status)}.`);
  const levels = {};
  for (const feature of flow.body.features) {
    levels[feature.properties.congestion] = (levels[feature.properties.congestion] ?? 0) + 1;
  }
  console.log(
    `  ${when}: ${String(flow.body.features.length)} published edges${flow.body.features.length > 0 ? ` ${JSON.stringify(levels)}` : ''} (snapshot ${flow.body.generatedAt})`,
  );
  return flow.body.features.length;
}

async function nextEpoch() {
  const waitMs = epochMs - (Date.now() % epochMs) + 5_000;
  console.log(`  waiting ${String(Math.round(waitMs / 1_000))} s for the epoch boundary...`);
  await sleep(waitMs);
}

// A boundary in the middle of the uploads would split one cohort across two checks.
if (epochMs - (Date.now() % epochMs) < 60_000) await nextEpoch();

const installations = [];
const registeredFrom = new Date(Date.now() - 60_000);
for (let index = 0; index < threshold; index += 1) {
  installations.push(await registerInstallation());
}
{
  // Development keys only (trust `untrusted`), registered by this run: as if two days ago.
  const database = new pg.Pool({ max: 1 });
  try {
    const aged = await database.query(
      `UPDATE community_installations SET registered_at = registered_at - interval '2 days'
       WHERE trust = 'untrusted' AND registered_at >= $1`,
      [registeredFrom],
    );
    if (aged.rowCount !== threshold) {
      throw new Error(
        `Expected to age ${String(threshold)} installations, aged ${String(aged.rowCount)}.`,
      );
    }
  } finally {
    await database.end();
  }
}
const checks = [];

// Threshold minus one installations, plus the last of them again from other networks.
for (let index = 0; index < threshold - 1; index += 1) {
  await upload(installations[index], `Installation ${String(index + 1)}`, 34 + index * 4, index);
}
for (const network of [20, 21, 22]) {
  await upload(
    installations[threshold - 2],
    `Installation ${String(threshold - 1)} again`,
    20,
    network,
  );
}
await nextEpoch();
checks.push((await published(`${String(threshold - 1)} installations, epoch closed`)) === 0);

await upload(
  installations[threshold - 1],
  `Installation ${String(threshold)}`,
  34 + threshold * 4,
  threshold,
);
checks.push((await published(`${String(threshold)} installations, epoch still open`)) === 0);
await nextEpoch();
checks.push((await published(`${String(threshold)} installations, epoch closed`)) > 0);

if (checks.includes(false)) {
  console.error(
    'FAILED: edges must stay hidden below the threshold and until the epoch closes, then appear.',
  );
  process.exit(1);
}
console.log(
  `OK: nothing was published for ${String(threshold - 1)} installations however often one of them uploaded, nor before the epoch closed; edges appeared at the boundary after installation ${String(threshold)}.`,
);
