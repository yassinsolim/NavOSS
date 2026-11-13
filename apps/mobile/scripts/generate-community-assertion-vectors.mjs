#!/usr/bin/env node
// Generates the shared App Attest client-data vectors from the TypeScript contract helper, so the
// Swift client is tested against the server's own canonicalisation rather than a copy of it.
//
//   corepack pnpm --filter @navoss/contracts build
//   node apps/mobile/scripts/generate-community-assertion-vectors.mjs
//
// `test/community-assertion-vectors.test.ts` fails when the committed fixture drifts from what
// this script produces.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { communityAssertionClientData } from '@navoss/contracts';

export const vectorsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'modules',
  'navoss-navigation',
  'ios',
  'Tests',
  'Fixtures',
  'community-client-data-vectors.json',
);

const reportTypes = [
  'collision',
  'road-closure',
  'slow-traffic',
  'construction',
  'pothole',
  'object-on-road',
  'road-hazard',
  'stalled-vehicle',
];

/** Deterministic PRNG (mulberry32) so regenerating never changes the fixture. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function challengeFrom(next) {
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(next() * 256);
  return bytes.toString('base64url');
}

function uuidFrom(next) {
  const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function buildVectors() {
  const next = random(0x6e61766f);
  const operations = [];
  // Degree formatting edge cases: exact binary ties (x + k/128 is exactly representable, so
  // toFixed(6) must round the seventh digit 5 up where printf would round half to even),
  // negative zero, values just either side of a rounding boundary, and integral degrees.
  const edgeCoordinates = [
    { latitude: 51.0078125, longitude: -114.0078125 },
    { latitude: 51.0234375, longitude: -114.0234375 },
    { latitude: 0.0078125, longitude: -0.0078125 },
    { latitude: -0, longitude: 0 },
    { latitude: 51.0447005, longitude: -114.0719995 },
    { latitude: 51.04470049999999, longitude: -114.07199949999999 },
    { latitude: 51, longitude: -114 },
    { latitude: 49.9999999, longitude: -120.0000001 },
    { latitude: 0.0000004, longitude: -0.0000004 },
    { latitude: 0.0000005, longitude: -0.0000005 },
    { latitude: 89.9999995, longitude: -179.9999995 },
    { latitude: 51.123456789, longitude: -114.987654321 },
  ];
  edgeCoordinates.forEach((coordinate, index) => {
    operations.push({
      coordinate,
      heading: index % 3 === 0 ? undefined : (index * 47) % 360,
      kind: 'submit-report',
      type: reportTypes[index % reportTypes.length],
    });
  });
  for (const heading of [0, 1, 90, 180, 359, undefined]) {
    operations.push({
      coordinate: { latitude: 51.0447, longitude: -114.0719 },
      heading,
      kind: 'submit-report',
      type: 'pothole',
    });
  }
  for (let index = 0; index < 64; index += 1) {
    const coordinate = {
      latitude: 48.2 + next() * 11.9,
      longitude: -139.1 + next() * 29.2,
    };
    operations.push(
      index % 2 === 0
        ? {
            coordinate,
            heading: next() < 0.3 ? undefined : Math.floor(next() * 360),
            kind: 'submit-report',
            type: reportTypes[index % reportTypes.length],
          }
        : {
            kind: 'vote',
            observedAt: coordinate,
            reportId: uuidFrom(next),
            vote: next() < 0.5 ? 'present' : 'not-present',
          },
    );
  }
  for (const observedAt of edgeCoordinates) {
    operations.push({ kind: 'vote', observedAt, reportId: uuidFrom(next), vote: 'not-present' });
  }
  operations.push({ kind: 'delete-report', reportId: uuidFrom(next) });
  operations.push({ kind: 'delete-installation' });
  operations.push({ kind: 'traffic-credential' });

  return operations.map((operation) => {
    const challenge = challengeFrom(next);
    const clientData = communityAssertionClientData(challenge, operation);
    return {
      challenge,
      clientData,
      // JSON cannot carry -0, so its sign travels separately.
      negativeZero: Object.values(operation.coordinate ?? operation.observedAt ?? {}).map((value) =>
        Object.is(value, -0),
      ),
      operation,
      sha256: createHash('sha256').update(clientData, 'utf8').digest('hex'),
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(vectorsPath, `${JSON.stringify(buildVectors(), null, 2)}\n`);
  console.log(`Wrote ${vectorsPath}`);
}
