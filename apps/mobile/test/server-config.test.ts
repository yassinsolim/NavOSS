import {
  AppConfigResponseSchema,
  isCoordinateServed,
  SERVICE_AREAS,
  serverAreaForCoordinate,
  serverConfigFromPayload,
} from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import borderPoints from '../../../packages/contracts/test/fixtures/coverage-border-points.json' with { type: 'json' };
import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { fetchAppConfig } from '../src/lib/api.js';
import newServerV1 from './fixtures/server-config/new-server.v1-config.json' with { type: 'json' };
import newServerV2 from './fixtures/server-config/new-server.v2-config.json' with { type: 'json' };
import productionV1 from './fixtures/server-config/production-2026-11.v1-config.json' with { type: 'json' };
import productionV2 from './fixtures/server-config/production-2026-11.v2-config.json' with { type: 'json' };

const CALGARY_TOWER = { latitude: 51.04427, longitude: -114.06309 };
const KELOWNA = { latitude: 49.8879, longitude: -119.496 };
const EDMONTON = { latitude: 53.5461, longitude: -113.4938 };
const VANCOUVER = { latitude: 49.2827, longitude: -123.1207 };
const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

describe('server config from the deployed production API (pre-#79 image)', () => {
  it('is the payload the strict current contract rejects, which the phone must still accept', () => {
    expect(AppConfigResponseSchema.safeParse(productionV2.response).success).toBe(false);
    expect(() => serverConfigFromPayload(productionV2.response)).not.toThrow();
  });

  it('declares Calgary and Kelowna, v1 routes and no live traffic or community reports', () => {
    const config = serverConfigFromPayload(productionV2.response);
    expect(config.capabilities).toEqual({
      communityReports: false,
      liveTraffic: false,
      officialSafetyCameras: true,
      productionSearch: true,
      routesV2: false,
    });
    expect(config.coverage.displayName).toBe('Calgary and Kelowna service areas');
    expect(config.coverage.areas.map((area) => area.id)).toEqual(['calgary-ab', 'kelowna-bc']);
  });

  it('offers search and directions only where that server serves them', () => {
    const { coverage } = serverConfigFromPayload(productionV2.response);
    expect(serverAreaForCoordinate(coverage, CALGARY_TOWER)?.id).toBe('calgary-ab');
    expect(serverAreaForCoordinate(coverage, KELOWNA)?.id).toBe('kelowna-bc');
    // The provinces this build bundles are not what this server declared.
    expect(isCoordinateServed(coverage, EDMONTON)).toBe(false);
    expect(isCoordinateServed(coverage, VANCOUVER)).toBe(false);
  });

  it('reads the older /v1/config the same way: Calgary only', () => {
    const config = serverConfigFromPayload(productionV1.response);
    expect(config.capabilities.routesV2).toBe(false);
    expect(config.coverage.displayName).toBe('Calgary, Alberta');
    expect(isCoordinateServed(config.coverage, CALGARY_TOWER)).toBe(true);
    expect(isCoordinateServed(config.coverage, KELOWNA)).toBe(false);
  });
});

describe('server config from the new server (this branch, #79)', () => {
  it('satisfies the strict contract and declares /v2/routes with Alberta and British Columbia', () => {
    expect(AppConfigResponseSchema.safeParse(newServerV2.response).success).toBe(true);
    const config = serverConfigFromPayload(newServerV2.response);
    expect(config.capabilities).toMatchObject({
      communityReports: false,
      liveTraffic: false,
      routesV2: true,
    });
    expect(config.coverage.displayName).toBe('Alberta and British Columbia');
    expect(isCoordinateServed(config.coverage, EDMONTON)).toBe(true);
    expect(isCoordinateServed(config.coverage, VANCOUVER)).toBe(true);
  });

  it.each(borderPoints.cases)(
    '$id follows the polygons the server sent',
    ({ coordinate, serviceAreaId }) => {
      const { coverage } = serverConfigFromPayload(newServerV2.response);
      expect(serverAreaForCoordinate(coverage, coordinate)?.id ?? null).toBe(serviceAreaId);
    },
  );

  it('keeps its /v1/config at the Calgary rectangle', () => {
    const config = serverConfigFromPayload(newServerV1.response);
    expect(config.coverage.areas).toHaveLength(1);
    expect(isCoordinateServed(config.coverage, EDMONTON)).toBe(false);
  });
});

describe('server config leniency', () => {
  it('uses bundled province polygons only for provinces the server declares without one', () => {
    const payload = structuredClone(newServerV2.response) as Record<string, unknown> & {
      coverage: { serviceAreas: Record<string, unknown>[] };
    };
    for (const area of payload.coverage.serviceAreas) delete area.boundary;
    const { coverage } = serverConfigFromPayload(payload);
    expect(coverage.areas.map((area) => area.boundary)).toEqual(
      ['alberta', 'british-columbia'].map(
        (id) => fixtureValue(SERVICE_AREAS.find((area) => area.id === id)).boundary,
      ),
    );
    // The BC rectangle reaches Seattle; the province polygon does not.
    expect(isCoordinateServed(coverage, SEATTLE)).toBe(false);
  });

  it('survives a future server that adds fields, endpoints, features and coverage kinds', () => {
    const future = structuredClone(newServerV2.response) as Record<string, unknown> & {
      coverage: Record<string, unknown> & { serviceAreas: Record<string, unknown>[] };
      endpoints: Record<string, unknown>;
      features: Record<string, unknown>;
    };
    future.apiVersion = 'v3';
    future.offline = { manifest: '/v1/offline/manifest' };
    future.endpoints = {
      ...future.endpoints,
      communityReports: '/v2/community/reports',
      offlineManifest: '/v1/offline/manifest',
      routes: '/v3/routes',
      trafficFlow: '/v2/traffic/flow',
    };
    future.features = { ...future.features, laneGuidance: true, offlineBundles: 'beta' };
    future.coverage = {
      ...future.coverage,
      modes: ['driving', 'cycling'],
      regions: [{ id: 'yukon', kind: 'planned' }],
      serviceAreas: [
        ...future.coverage.serviceAreas.map((area) => ({ ...area, timeZone: 'America/Edmonton' })),
        { geometryRef: '/v3/coverage/saskatchewan', id: 'saskatchewan' },
      ],
    };

    const config = serverConfigFromPayload(future);
    expect(config.apiVersion).toBe('v3');
    // Not v1: try /v2/routes and fall back on 404, rather than assuming the newest path.
    expect(config.capabilities.routesV2).toBe(true);
    expect(config.capabilities.liveTraffic).toBe(false);
    // An area this build cannot read is left out, never guessed into coverage.
    expect(config.coverage.areas.map((area) => area.id)).toEqual(['alberta', 'british-columbia']);
    expect(isCoordinateServed(config.coverage, CALGARY_TOWER)).toBe(true);
  });

  it('treats absent or malformed capabilities as not available', () => {
    const payload = structuredClone(productionV2.response) as Record<string, unknown>;
    delete payload.endpoints;
    payload.features = 'unknown';
    const config = serverConfigFromPayload(payload);
    expect(config.capabilities).toEqual({
      communityReports: false,
      liveTraffic: false,
      officialSafetyCameras: false,
      productionSearch: false,
      routesV2: true,
    });
  });

  it('drops a malformed area instead of widening coverage, and refuses no coverage at all', () => {
    const payload = structuredClone(productionV2.response) as Record<string, unknown> & {
      coverage: { serviceAreas: Record<string, unknown>[] };
    };
    fixtureValue(payload.coverage.serviceAreas[1]).boundary = { type: 'MultiPolygon' };
    expect(serverConfigFromPayload(payload).coverage.areas.map((area) => area.id)).toEqual([
      'calgary-ab',
    ]);
    payload.coverage.serviceAreas = [];
    expect(() => serverConfigFromPayload(payload)).toThrow();
  });

  it('does not block requests before any config has arrived', () => {
    expect(isCoordinateServed(undefined, EDMONTON)).toBe(true);
  });
});

describe('fetchAppConfig', () => {
  it('reads production /v2/config', async () => {
    const urls: string[] = [];
    const config = await fetchAppConfig({
      baseUrl: 'https://api.example.test/',
      fetchImplementation: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(productionV2.response));
      },
    });
    expect(urls).toEqual(['https://api.example.test/v2/config']);
    expect(config.capabilities.routesV2).toBe(false);
  });

  it('falls back to /v1/config on a server that has no /v2/config', async () => {
    const urls: string[] = [];
    const config = await fetchAppConfig({
      baseUrl: 'https://api.example.test',
      fetchImplementation: async (input) => {
        urls.push(String(input));
        return String(input).endsWith('/v2/config')
          ? new Response('<html>Not Found</html>', { status: 404 })
          : new Response(JSON.stringify(productionV1.response));
      },
    });
    expect(urls).toEqual([
      'https://api.example.test/v2/config',
      'https://api.example.test/v1/config',
    ]);
    expect(config.coverage.displayName).toBe('Calgary, Alberta');
  });
});
