import { readFileSync } from 'node:fs';

import type { CommunityAssertion, Coordinate, TrafficProbeBatchRequest } from '@navoss/contracts';

import { CommunityReportError } from '../src/community-reports.js';
import type { Position } from '../src/traffic/geo.js';
import { createValhallaMapMatcher, type MapMatcher } from '../src/traffic/map-matcher.js';
import type { TrafficAttestation, TrafficService } from '../src/traffic/service.js';
import { DEFAULT_TRAFFIC_SETTINGS, type TrafficSettings } from '../src/traffic/settings.js';

interface DriveFixture {
  /** A synthetic 2.3 km drive along Landstrasse, one fix every 22 m, a few metres off the road. */
  batchPositions: Position[];
  route: {
    distanceMeters: number;
    durationSeconds: number;
    geometry: Position[];
    id: string;
    label: 'alternative' | 'fastest';
    steps: {
      distanceMeters: number;
      durationSeconds: number;
      geometry: Position[];
      instruction: string;
      maneuverType: string;
      roadName: string;
    }[];
  };
  /** What Valhalla 3.8.2 answered for the server-trimmed drive. */
  traceResponse: { matched_points: Record<string, unknown>[]; shape: string };
  /** What Valhalla 3.8.2 answered when walking `route.geometry`. */
  walkResponse: unknown;
}

export const DRIVE = JSON.parse(
  readFileSync(new URL('./fixtures/traffic-drive.json', import.meta.url), 'utf8'),
) as DriveFixture;

/** The drive is in Liechtenstein because that is the smallest graph Valhalla could be run on. */
export const FIXTURE_SETTINGS: TrafficSettings = {
  ...DEFAULT_TRAFFIC_SETTINGS,
  bounds: { east: 9.7, north: 47.3, south: 47, west: 9.4 },
  mode: 'live',
};

/** Explicit fixture-only replay coverage; no environment option can replace production polygons. */
export function isFixtureTrafficCoordinate({ latitude, longitude }: Coordinate): boolean {
  const { east, north, south, west } = FIXTURE_SETTINGS.bounds;
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

export const NOW = new Date('2026-11-12T18:00:30Z');
export const CAPTURED_AT = '2026-11-12T17:55:00Z';

/** Steady 40 km/h: one 22 m fix every two seconds. */
export const STEADY_GAPS = DRIVE.batchPositions.slice(1).map(() => 2);
/** The same road with a crawl in the middle: fixes 40 to 69 are five seconds apart, 16 km/h. */
export const JAMMED_GAPS = STEADY_GAPS.map((gap, index) => (index >= 40 && index < 70 ? 5 : gap));

export function driveBatch(
  credential: string,
  gaps: readonly number[] = STEADY_GAPS,
  capturedAt: string = CAPTURED_AT,
): TrafficProbeBatchRequest {
  let offset = 0;
  return {
    capturedAt,
    credential,
    points: DRIVE.batchPositions.map(([longitude, latitude], index) => {
      offset += index === 0 ? 0 : (gaps[index - 1] ?? 2);
      return [longitude, latitude, offset];
    }),
    schemaVersion: 1,
  };
}

export interface StubbedMatcher {
  failNext(status: number): void;
  matcher: MapMatcher;
  /** Request bodies Valhalla was sent, for asserting what leaves the process. */
  requests: { shape: unknown[]; shape_match: string }[];
}

/** The real Valhalla client with `fetch` replaced by the recorded responses. */
export function stubbedMatcher(): StubbedMatcher {
  const requests: StubbedMatcher['requests'] = [];
  let failure: number | undefined;
  return {
    failNext(status) {
      failure = status;
    },
    matcher: createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (_input, init) => {
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        ) as StubbedMatcher['requests'][number];
        requests.push(body);
        if (failure !== undefined) {
          const status = failure;
          failure = undefined;
          return Promise.resolve(new Response('{"error":"stub"}', { status }));
        }
        return Promise.resolve(
          Response.json(
            body.shape_match === 'edge_walk' ? DRIVE.walkResponse : DRIVE.traceResponse,
          ),
        );
      },
    }),
    requests,
  };
}

/** A schema-valid assertion naming a test device; `fakeAttestation` reads only the key id. */
export function assertionFor(device: string): CommunityAssertion {
  return {
    assertion: Buffer.from(`assertion-of-${device}`).toString('base64'),
    challenge: Buffer.alloc(32, 1).toString('base64url'),
    keyId: Buffer.from(device).toString('base64'),
  };
}

/**
 * Stands in for the App Attest installation service: the device name is the installation, and a
 * name starting with `unregistered` or `development` is refused the way the real service does.
 */
export function fakeAttestation(): TrafficAttestation {
  return {
    assertTrafficContributor(assertion) {
      const device = Buffer.from(assertion.keyId, 'base64').toString('utf8');
      if (device.startsWith('unregistered')) {
        return Promise.reject(new CommunityReportError('unknown-installation'));
      }
      if (device.startsWith('development')) {
        return Promise.reject(new CommunityReportError('development-not-allowed'));
      }
      return Promise.resolve({ installationId: `installation-${device}` });
    },
  };
}

export async function credentialFor(service: TrafficService, device: string): Promise<string> {
  const issued = await service.issueCredential(assertionFor(device));
  if (issued === undefined) throw new Error('no credential was issued');
  return issued.credential;
}
