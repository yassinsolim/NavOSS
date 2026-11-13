import { TrafficProbeBatchRequestSchema, type TrafficProbeBatchRequest } from '@navoss/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import borderPoints from '../../../packages/contracts/test/fixtures/coverage-border-points.json' with { type: 'json' };
import { isSupportedSearchCoordinate } from '../src/search-provider.js';
import { findProbeRejection } from '../src/traffic/probe-validation.js';
import { createTrafficService, type TrafficService } from '../src/traffic/service.js';
import { DEFAULT_TRAFFIC_SETTINGS } from '../src/traffic/settings.js';
import { assertionFor, fakeAttestation } from './traffic-fixture.js';

const now = new Date('2026-11-13T00:05:30Z');
const services: TrafficService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function batchAt(
  coordinate: { latitude: number; longitude: number },
  credential: string,
): TrafficProbeBatchRequest {
  return TrafficProbeBatchRequestSchema.parse({
    capturedAt: '2026-11-13T00:05:00Z',
    credential,
    schemaVersion: 1,
    points: Array.from({ length: 10 }, (_, index) => [
      coordinate.longitude,
      coordinate.latitude,
      index * 2,
    ]),
  });
}

describe('reports and traffic use the shared AB/BC jurisdiction boundary', () => {
  it.each(borderPoints.cases)(
    '$id has the same report/search and default probe eligibility',
    ({ coordinate, serviceAreaId }) => {
      const supported = serviceAreaId !== null;
      expect(isSupportedSearchCoordinate(coordinate)).toBe(supported);
      expect(
        findProbeRejection(
          batchAt(coordinate, 'c'.repeat(64)),
          now.getTime(),
          DEFAULT_TRAFFIC_SETTINGS,
        ),
      ).toBe(supported ? undefined : 'outside_coverage');
    },
  );

  it.each(borderPoints.cases)(
    '$id is checked by credentialed service ingest before trimming/matching',
    async ({ coordinate, serviceAreaId }) => {
      const matchTrace = vi.fn(() => Promise.resolve(undefined));
      const service = createTrafficService({
        attestation: fakeAttestation(),
        clock: () => now,
        settings: { ...DEFAULT_TRAFFIC_SETTINGS, mode: 'live' },
        mapMatcher: { matchTrace, walkRoute: () => Promise.resolve(undefined) },
      });
      services.push(service);
      const credential = await service.issueCredential(assertionFor('coverage-device'));
      if (credential === undefined) throw new Error('Expected fixture credential');
      const result = await service.ingest(batchAt(coordinate, credential.credential));
      expect(result).toEqual(
        serviceAreaId === null
          ? { status: 'rejected', reason: 'outside_coverage' }
          : { status: 'accepted' },
      );
      // Stationary fixture batches have no retained path; never publish fabricated flow.
      expect(matchTrace).not.toHaveBeenCalled();
    },
  );
});
