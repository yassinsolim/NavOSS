import {
  AppConfigResponseSchema,
  LegacyAppConfigResponseSchema,
  ContributionSubmissionResponseSchema,
  GooglePlaceQueryGrantResponseSchema,
  HealthResponseSchema,
  OfficialRoadEventResponseSchema,
  OfficialSafetyCameraResponseSchema,
  ProblemDetailsSchema,
  ReadinessResponseSchema,
  RoadEventResponseSchema,
  RouteResponseSchema,
  SafetyFacilityResponseSchema,
  SafetyCameraResponseSchema,
  SearchResponseSchema,
  TrafficCameraResponseSchema,
  type RouteAlternative,
  type SafetyCameraResponse,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { CalgaryRoadEventProviderError } from '../src/calgary-road-event-provider.js';
import { DriveBcRoadEventProviderError } from '../src/drivebc-road-event-provider.js';
import { DriveBcTrafficCameraProviderError } from '../src/drivebc-traffic-camera-provider.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { OntarioRoadEventProviderError } from '../src/ontario-road-event-provider.js';
import { KelownaSafetyFacilityProviderError } from '../src/kelowna-safety-facility-provider.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import { CameraProviderError } from '../src/safety-camera-provider.js';
import { TorontoCameraProviderError } from '../src/toronto-safety-camera-provider.js';

const FIXED_DATE = new Date('2026-07-15T12:00:00Z');
const apps: FastifyInstance[] = [];

async function createTestApp(
  options: Parameters<typeof buildApp>[0] = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    clock: () => FIXED_DATE,
    searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
    ...options,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('provider lifecycle', () => {
  it('registers poller cleanup before the Fastify instance starts listening', async () => {
    const stopCalgary = vi.fn();
    const stopDriveBcCameras = vi.fn();
    const stopDriveBcEvents = vi.fn();
    const stopOntario = vi.fn();
    const app = await buildApp({
      driveBcEventProvider: {
        getRoadEvents: () => Promise.reject(new Error('not requested')),
        stop: stopDriveBcEvents,
      },
      driveBcTrafficCameraProvider: {
        getCameras: () => Promise.reject(new Error('not requested')),
        stop: stopDriveBcCameras,
      },
      eventProvider: {
        getRoadEvents: () => Promise.reject(new Error('not requested')),
        stop: stopCalgary,
      },
      ontarioEventProvider: {
        getRoadEvents: () => Promise.reject(new Error('not requested')),
        stop: stopOntario,
      },
      searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    await app.close();

    expect(stopCalgary).toHaveBeenCalledOnce();
    expect(stopDriveBcCameras).toHaveBeenCalledOnce();
    expect(stopDriveBcEvents).toHaveBeenCalledOnce();
    expect(stopOntario).toHaveBeenCalledOnce();
  });
});

describe('system routes', () => {
  it('reports liveness with a contract-valid timestamp', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      service: 'navoss-api',
      status: 'ok',
      timestamp: '2026-07-15T12:00:00.000Z',
      version: '0.0.0',
    });
  });

  it('fails readiness when no search dataset is loaded', async () => {
    const app = await createTestApp({ searchFixtures: [] });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = ReadinessResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe('not_ready');
  });

  it('reports production provider readiness', async () => {
    const app = await createTestApp({
      productionSearch: true,
      routeProvider: {
        getRoutes: () => Promise.resolve([]),
        isReady: () => Promise.resolve(true),
      },
      searchProvider: {
        isReady: () => Promise.resolve(true),
        search: (query) => createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES).search(query),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = ReadinessResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.checks.routingProvider?.status).toBe('ready');
    expect(body.checks.searchProvider?.status).toBe('ready');
  });

  it('fails readiness when a production provider is unavailable', async () => {
    const app = await createTestApp({
      productionSearch: true,
      searchProvider: {
        isReady: () => Promise.resolve(false),
        search: (query) => createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES).search(query),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = ReadinessResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(body.checks.searchProvider?.status).toBe('not_ready');
  });
});

describe('client configuration', () => {
  it('preserves the strict legacy Calgary contract for existing builds', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/config' });
    const body = LegacyAppConfigResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.coverage.id).toBe('calgary-ab');
    expect(body.coverage.displayName).toBe('Calgary, Alberta');
  });

  it('returns regional service areas to updated clients', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/v2/config' });
    const body = AppConfigResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.coverage.id).toBe('calgary-kelowna-service-areas');
    expect(body.coverage.displayName).toBe('Calgary and Kelowna service areas');
    expect(body.coverage.serviceAreas.map(({ id }) => id)).toEqual(['calgary-ab', 'kelowna-bc']);
    expect(body.features).toEqual({
      communityReports: false,
      liveTraffic: false,
      officialSafetyCameras: true,
      productionSearch: false,
    });
    expect(body.endpoints.cameras).toBe('/v1/cameras');
    expect(body.attribution).toContainEqual({
      label: 'The City of Calgary',
      url: 'https://data.calgary.ca/',
    });
  });

  it('reports production search only when explicitly configured', async () => {
    const app = await createTestApp({ productionSearch: true });
    const response = await app.inject({ method: 'GET', url: '/v2/config' });
    const body = AppConfigResponseSchema.parse(response.json());

    expect(body.features.productionSearch).toBe(true);
  });

  it('reports live traffic only for a configured live route provider', async () => {
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => Promise.resolve([]),
        source: {
          attribution: 'Routing and traffic by Mapbox',
          degraded: false,
          id: 'mapbox-traffic',
          mode: 'production',
          traffic: 'live',
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v2/config' });
    const body = AppConfigResponseSchema.parse(response.json());

    expect(body.features.liveTraffic).toBe(true);
  });
});

describe('Google place query grants', () => {
  it('returns the anonymous monthly budget reservation', async () => {
    const app = await createTestApp({
      googlePlaceQueryBudget: {
        reserve: () =>
          Promise.resolve({
            granted: true,
            limit: 8_000,
            period: '2026-07',
            remaining: 7_999,
            resetsAt: '2026-08-01T00:00:00.000Z',
          }),
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/google-place-query-grants' });

    expect(response.statusCode).toBe(200);
    expect(GooglePlaceQueryGrantResponseSchema.parse(response.json())).toEqual({
      granted: true,
      limit: 8_000,
      period: '2026-07',
      remaining: 7_999,
      resetsAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('fails closed when the durable budget is unavailable', async () => {
    const app = await createTestApp({
      googlePlaceQueryBudget: {
        reserve: () => Promise.reject(new Error('database unavailable')),
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/google-place-query-grants' });

    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(response.json()).detail).toContain('could not be reserved');
  });
});

describe('anonymous beta contributions', () => {
  it('accepts a bounded contribution without identity or coordinates', async () => {
    const app = await createTestApp({
      contributionProvider: {
        submit: (submission) => {
          expect(submission).not.toHaveProperty('coordinate');
          expect(submission).not.toHaveProperty('userId');
          return Promise.resolve({
            acceptedAt: '2026-07-15T12:00:00.000Z',
            status: 'accepted',
            submissionId: 'fbe6f7cf-8176-499d-8f73-0fcf858d85f0',
          });
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        createdAt: '2026-07-15T11:55:00.000Z',
        description: 'The entrance marker is on the wrong side.',
        draftId: 'draft-1',
        locationLabel: 'Downtown Kelowna',
        type: 'place-correction',
      },
      url: '/v1/contributions',
    });

    expect(response.statusCode).toBe(202);
    expect(ContributionSubmissionResponseSchema.parse(response.json()).status).toBe('accepted');
  });

  it('rejects precise coordinates and unexpected identity fields', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      payload: {
        coordinate: { latitude: 49.888, longitude: -119.496 },
        createdAt: '2026-07-15T11:55:00.000Z',
        description: 'The entrance marker is on the wrong side.',
        draftId: 'draft-1',
        type: 'place-correction',
        userId: 'unexpected',
      },
      url: '/v1/contributions',
    });

    expect(response.statusCode).toBe(400);
  });

  it('rate limits submission abuse before writing to the provider', async () => {
    const app = await createTestApp({
      contributionProvider: {
        submit: () => Promise.reject(new Error('provider must not be called')),
      },
      contributionRateLimiter: { consume: () => false },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        createdAt: '2026-07-15T11:55:00.000Z',
        description: 'The entrance marker is on the wrong side.',
        draftId: 'draft-1',
        type: 'place-correction',
      },
      url: '/v1/contributions',
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('3600');
    expect(ProblemDetailsSchema.parse(response.json()).code).toBe('rate_limited');
  });

  it('uses the trusted proxy client address for contribution limits', async () => {
    const sourceAddresses: string[] = [];
    const app = await createTestApp({
      contributionProvider: {
        submit: () =>
          Promise.resolve({
            acceptedAt: '2026-07-15T12:00:00.000Z',
            status: 'accepted',
            submissionId: 'fbe6f7cf-8176-499d-8f73-0fcf858d85f0',
          }),
      },
      contributionRateLimiter: {
        consume: (sourceAddress) => {
          sourceAddresses.push(sourceAddress);
          return true;
        },
      },
    });
    const payload = {
      createdAt: '2026-07-15T11:55:00.000Z',
      description: 'The entrance marker is on the wrong side.',
      draftId: 'draft-1',
      type: 'place-correction',
    };

    await app.inject({
      headers: { 'x-forwarded-for': '198.51.100.1' },
      method: 'POST',
      payload,
      url: '/v1/contributions',
    });
    await app.inject({
      headers: { 'x-forwarded-for': '198.51.100.2' },
      method: 'POST',
      payload: { ...payload, draftId: 'draft-2' },
      url: '/v1/contributions',
    });

    expect(sourceAddresses).toEqual(['198.51.100.1', '198.51.100.2']);
  });
});

describe('Calgary road events', () => {
  const roadEventResponse = RoadEventResponseSchema.parse({
    degraded: false,
    events: [
      {
        confidence: 'official',
        coordinate: { latitude: 51.167619, longitude: -114.146788 },
        description: 'Eastbound right lane closure.',
        endsAtLocal: '2026-09-30T15:00:00.000',
        id: 'calgary-construction:test',
        sourceId: 'calgary-construction-detours',
        startsAtLocal: '2026-06-15T09:00:00.000',
        timeZone: 'America/Edmonton',
        title: 'Symons Valley Parkway and Kincora Gate NW',
        type: 'construction',
      },
    ],
    generatedAt: '2026-07-15T12:00:00Z',
    sources: [
      {
        attribution: 'The City of Calgary',
        confidence: 'official',
        datasetId: 'w8zq-79bq',
        datasetUrl: 'https://data.calgary.ca/d/w8zq-79bq',
        licenseUrl: 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa',
        sourceId: 'calgary-construction-detours',
        updateFrequency: 'twice daily',
        updatedAt: '2026-07-15T11:00:00Z',
      },
      {
        attribution: 'The City of Calgary',
        confidence: 'unverified',
        datasetId: '4jah-h97u',
        datasetUrl: 'https://data.calgary.ca/d/4jah-h97u',
        licenseUrl: 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa',
        sourceId: 'calgary-current-incidents',
        updateFrequency: '10 minutes',
        updatedAt: '2026-07-15T11:50:00Z',
      },
    ],
    stale: false,
  });

  it('returns contract-valid Calgary road events', async () => {
    const app = await createTestApp({
      eventProvider: { getRoadEvents: () => Promise.resolve(roadEventResponse) },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/events' });

    expect(response.statusCode).toBe(200);
    expect(RoadEventResponseSchema.parse(response.json())).toEqual(roadEventResponse);
  });

  it('returns a stable problem when Calgary road data is unavailable', async () => {
    const app = await createTestApp({
      eventProvider: {
        getRoadEvents: () => Promise.reject(new CalgaryRoadEventProviderError('offline')),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/events' });

    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Road data unavailable',
    });
  });
});

describe('Ontario road events', () => {
  const roadEventResponse = OfficialRoadEventResponseSchema.parse({
    degraded: false,
    events: [
      {
        confidence: 'official',
        coordinate: { latitude: 43.63599, longitude: -79.668724 },
        description: 'Construction on HWY 401 Eastbound. One alternating lane.',
        direction: 'Eastbound',
        endsAt: '2026-08-24T05:00:00.000Z',
        id: 'ontario-511:1963:222249',
        isFullClosure: false,
        regionId: 'ontario',
        reportedAt: '2026-07-15T10:00:00.000Z',
        roadwayName: 'HWY 401',
        sourceId: 'ontario-511-events',
        startsAt: '2026-07-15T10:00:00.000Z',
        title: 'Construction on HWY 401',
        type: 'construction',
        updatedAt: '2026-07-15T11:50:00.000Z',
      },
    ],
    generatedAt: '2026-07-15T12:00:00.000Z',
    regionId: 'ontario',
    source: {
      apiDocumentationUrl: 'https://511on.ca/developers/doc',
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 Ontario.',
      confidence: 'official',
      licenseUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
      refreshIntervalSeconds: 300,
      sourceId: 'ontario-511-events',
      updatedAt: '2026-07-15T11:50:00.000Z',
    },
    stale: false,
  });

  it('returns contract-valid official Ontario events', async () => {
    const app = await createTestApp({
      ontarioEventProvider: { getRoadEvents: () => Promise.resolve(roadEventResponse) },
    });
    const response = await app.inject({ method: 'GET', url: '/v2/events?region=ontario' });

    expect(response.statusCode).toBe(200);
    expect(OfficialRoadEventResponseSchema.parse(response.json())).toEqual(roadEventResponse);
  });

  it('rejects missing or unsupported regions', async () => {
    const app = await createTestApp();

    expect((await app.inject({ method: 'GET', url: '/v2/events' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v2/events?region=calgary-ab' })).statusCode,
    ).toBe(400);
  });

  it('returns a stable problem when Ontario road data is unavailable', async () => {
    const app = await createTestApp({
      ontarioEventProvider: {
        getRoadEvents: () => Promise.reject(new OntarioRoadEventProviderError('offline')),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v2/events?region=ontario' });

    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Road data unavailable',
    });
  });

  it('dispatches Kelowna events to DriveBC without changing Ontario', async () => {
    const kelownaResponse = OfficialRoadEventResponseSchema.parse({
      degraded: false,
      events: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
      regionId: 'kelowna-bc',
      source: {
        apiDocumentationUrl: 'https://api.open511.gov.bc.ca/help',
        attribution:
          'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
        confidence: 'official',
        dataUrl:
          'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&bbox=-119.65,49.70,-119.20,50.15&limit=500',
        licenseUrl: 'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc',
        refreshIntervalSeconds: 300,
        sourceId: 'drivebc-open511-events',
      },
      stale: false,
    });
    const app = await createTestApp({
      driveBcEventProvider: { getRoadEvents: () => Promise.resolve(kelownaResponse) },
      ontarioEventProvider: { getRoadEvents: () => Promise.resolve(roadEventResponse) },
    });

    const kelowna = await app.inject({ method: 'GET', url: '/v2/events?region=kelowna-bc' });
    const ontario = await app.inject({ method: 'GET', url: '/v2/events?region=ontario' });

    expect(OfficialRoadEventResponseSchema.parse(kelowna.json())).toEqual(kelownaResponse);
    expect(OfficialRoadEventResponseSchema.parse(ontario.json())).toEqual(roadEventResponse);
  });

  it('returns a stable problem when DriveBC road data is unavailable', async () => {
    const app = await createTestApp({
      driveBcEventProvider: {
        getRoadEvents: () => Promise.reject(new DriveBcRoadEventProviderError('offline')),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v2/events?region=kelowna-bc' });

    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Road data unavailable',
    });
  });
});

describe('Kelowna regional context', () => {
  const trafficCameraResponse = TrafficCameraResponseSchema.parse({
    cameras: [
      {
        cameraType: 'traffic',
        caption: 'Highway 97 in Lake Country by Wood Lake, looking north.',
        coordinate: { latitude: 50.057111, longitude: -119.407653 },
        enforcement: false,
        highway: '97',
        id: 'drivebc-highwaycam:532',
        imageUrl: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/532.jpg',
        name: 'Lake Country - N',
        orientation: 'N',
        pageUrl: 'https://images.drivebc.ca/bchighwaycam/pub/html/www/532.html',
        regionId: 'kelowna-bc',
        thumbnailUrl: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/tn/532.jpg',
      },
    ],
    degraded: false,
    generatedAt: '2026-07-15T12:00:00.000Z',
    source: {
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
      catalogueUrl: 'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c',
      datasetId: '6b39a910-6c77-476f-ac96-7b4f18849b1c',
      dataUrl:
        'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv',
      licenseUrl: 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61',
      regionId: 'kelowna-bc',
      resourceId: 'a9d52d85-8402-4ce7-b2ac-a2779837c48a',
      sourceId: 'drivebc-highwaycams',
      updateFrequency: 'monthly',
    },
    stale: false,
  });
  const facilityResponse = SafetyFacilityResponseSchema.parse({
    facilities: [
      {
        address: '1190 Richter St',
        coordinate: { latitude: 49.89385756349143, longitude: -119.48887718651372 },
        id: 'kelowna-rcmp:main-detachment',
        kind: 'facility',
        name: 'Main Detachment',
        pageUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
        phone: '250-762-3300',
        regionId: 'kelowna-bc',
        type: 'police-station',
      },
      {
        address: '115 McIntosh Rd',
        coordinate: { latitude: 49.891982880689184, longitude: -119.38777082090141 },
        id: 'kelowna-rcmp:rutland-community-police-office',
        kind: 'facility',
        name: 'Rutland Community Police Office',
        pageUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
        phone: '250-765-6355',
        regionId: 'kelowna-bc',
        type: 'police-station',
      },
    ],
    generatedAt: '2026-07-15T12:00:00.000Z',
    source: {
      attribution: 'Royal Canadian Mounted Police',
      dateModified: '2024-12-19',
      regionId: 'kelowna-bc',
      sourceId: 'kelowna-rcmp-public-facilities',
      sourceUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
    },
  });

  it('returns ordinary traffic cameras separately from enforcement cameras', async () => {
    const app = await createTestApp({
      driveBcTrafficCameraProvider: {
        getCameras: () => Promise.resolve(trafficCameraResponse),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/traffic-cameras?region=kelowna-bc',
    });

    expect(response.statusCode).toBe(200);
    expect(TrafficCameraResponseSchema.parse(response.json())).toEqual(trafficCameraResponse);
  });

  it('returns only fixed official public safety facilities', async () => {
    const app = await createTestApp({
      kelownaSafetyFacilityProvider: {
        getFacilities: () => Promise.resolve(facilityResponse),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/safety-facilities?region=kelowna-bc',
    });

    expect(response.statusCode).toBe(200);
    expect(SafetyFacilityResponseSchema.parse(response.json())).toEqual(facilityResponse);
  });

  it('returns stable 503 problems for unavailable Kelowna context providers', async () => {
    const app = await createTestApp({
      driveBcTrafficCameraProvider: {
        getCameras: () => Promise.reject(new DriveBcTrafficCameraProviderError('offline')),
      },
      kelownaSafetyFacilityProvider: {
        getFacilities: () => Promise.reject(new KelownaSafetyFacilityProviderError('offline')),
      },
    });

    const cameras = await app.inject({
      method: 'GET',
      url: '/v2/traffic-cameras?region=kelowna-bc',
    });
    const facilities = await app.inject({
      method: 'GET',
      url: '/v2/safety-facilities?region=kelowna-bc',
    });

    expect(cameras.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(cameras.json())).toMatchObject({
      status: 503,
      title: 'Traffic camera data unavailable',
    });
    expect(facilities.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(facilities.json())).toMatchObject({
      status: 503,
      title: 'Safety facility data unavailable',
    });
  });
});

describe('safety cameras', () => {
  const cameraResponse: SafetyCameraResponse = {
    cameras: [
      {
        community: 'BELTLINE',
        coordinate: { latitude: 51.0412867, longitude: -114.0584045 },
        direction: 'northbound',
        enforcement: ['red-light', 'speed-on-green'],
        id: 'calgary-isc:51.0412867:-114.0584045',
        location: 'Macleod Trail and 12 Avenue S.E.',
        quadrant: 'SE',
        ward: 11,
      },
    ],
    source: {
      attribution: 'The City of Calgary',
      datasetId: 'dv2f-necx',
      datasetUrl: 'https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx',
      updateFrequency: 'monthly',
      updatedAt: '2026-07-01T08:33:43.000Z',
    },
  };

  it('returns normalized official camera locations and provenance', async () => {
    const app = await createTestApp({
      cameraProvider: { getCameras: () => Promise.resolve(cameraResponse) },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/cameras' });
    const body = SafetyCameraResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.cameras[0]?.direction).toBe('northbound');
    expect(body.source.datasetId).toBe('dv2f-necx');
  });

  it('returns additive Toronto red-light cameras without changing the Calgary endpoint', async () => {
    const torontoResponse = OfficialSafetyCameraResponseSchema.parse({
      cameras: [
        {
          coordinate: { latitude: 43.646383, longitude: -79.384099 },
          enforcement: ['red-light'],
          id: 'toronto-rlc:6098',
          jurisdiction: 'City of Toronto',
          location: 'University Ave And Wellington St W',
          regionId: 'toronto-on',
        },
      ],
      generatedAt: '2026-07-15T12:00:00Z',
      source: {
        attribution: 'City of Toronto',
        datasetId: '9fcff3e1-3737-43cf-b410-05acd615e27b',
        datasetUrl: 'https://open.toronto.ca/dataset/red-light-cameras/',
        licenseUrl: 'https://open.toronto.ca/open-data-licence/',
        regionId: 'toronto-on',
        updateFrequency: 'daily',
        updatedAt: '2026-07-15T05:03:56Z',
      },
    });
    const app = await createTestApp({
      torontoCameraProvider: { getCameras: () => Promise.resolve(torontoResponse) },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/cameras?region=toronto-on',
    });

    expect(response.statusCode).toBe(200);
    expect(OfficialSafetyCameraResponseSchema.parse(response.json())).toEqual(torontoResponse);
  });

  it('returns a stable problem when Toronto camera data is unavailable', async () => {
    const app = await createTestApp({
      torontoCameraProvider: {
        getCameras: () => Promise.reject(new TorontoCameraProviderError('offline')),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/cameras?region=toronto-on',
    });

    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Camera data unavailable',
    });
  });

  it('returns a stable problem when official camera data is unavailable', async () => {
    const app = await createTestApp({
      cameraProvider: {
        getCameras: () => Promise.reject(new CameraProviderError('offline')),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/cameras' });
    const body = ProblemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(body).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Camera data unavailable',
    });
  });
});

describe('search', () => {
  it('returns deterministic fixture results and provenance', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      payload: {
        latitude: 51.0447,
        longitude: -114.0719,
        q: 'tower',
      },
      url: '/v1/search',
    });
    const body = SearchResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.results[0]?.id).toBe('landmark:calgary-tower');
    expect(body.source).toEqual({
      datasetVersion: 'fixture-v1',
      freshness: 'static',
      id: 'calgary-alpha-fixtures',
      updatedAt: '2026-07-15T12:00:00Z',
    });
    expect(body.degraded).toBe(true);
  });

  it('returns a stable problem document for invalid input', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'POST', payload: { q: 'x' }, url: '/v1/search' });
    const body = ProblemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(body).toMatchObject({
      code: 'invalid_request',
      detail: 'The request does not match the API contract.',
      status: 400,
      title: 'Invalid request',
    });
  });

  it('rejects nearby category searches outside corridor coverage', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      payload: {
        category: 'restaurant',
        latitude: 43.6532,
        longitude: -79.3832,
        q: 'restaurant',
        sort: 'distance',
      },
      url: '/v1/search',
    });

    expect(response.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      code: 'invalid_request',
      detail:
        'Nearby categories are currently available only in the Calgary and Kelowna service areas.',
      status: 400,
      title: 'Search outside coverage',
    });
  });

  it('rejects mountain coordinates between the two supported service areas', async () => {
    let searchCalls = 0;
    let routeCalls = 0;
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => {
          routeCalls += 1;
          return Promise.resolve([]);
        },
      },
      searchProvider: {
        search: () => {
          searchCalls += 1;
          return Promise.reject(new Error('search must not run'));
        },
      },
    });
    const searchResponse = await app.inject({
      method: 'POST',
      payload: {
        category: 'restaurant',
        latitude: 50.5,
        longitude: -117,
        q: 'restaurant',
      },
      url: '/v1/search',
    });
    const routeResponse = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 50.5, longitude: -117 },
        origin: { latitude: 49.888, longitude: -119.496 },
      },
      url: '/v1/routes',
    });

    expect(searchResponse.statusCode).toBe(400);
    expect(routeResponse.statusCode).toBe(400);
    expect(searchCalls).toBe(0);
    expect(routeCalls).toBe(0);
  });

  it('rejects locationless nearby categories but permits locationless typed search', async () => {
    const app = await createTestApp();
    const categoryResponse = await app.inject({
      method: 'POST',
      payload: { category: 'restaurant', q: 'restaurant' },
      url: '/v1/search',
    });
    const typedResponse = await app.inject({
      method: 'POST',
      payload: { q: 'Kelowna City Park' },
      url: '/v1/search',
    });

    expect(categoryResponse.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(categoryResponse.json()).title).toBe(
      'Nearby search needs a location',
    );
    expect(typedResponse.statusCode).toBe(200);
  });
});

describe('routes', () => {
  const route: RouteAlternative = {
    distanceMeters: 19_660.564,
    durationSeconds: 1_215.354,
    geometry: [
      [-114.071903, 51.044666],
      [-114.01055, 51.13157],
    ],
    id: 'route-1',
    label: 'fastest',
    steps: [
      {
        distanceMeters: 57.692,
        durationSeconds: 18.881,
        geometry: [
          [-114.071903, 51.044666],
          [-114.072726, 51.044691],
        ],
        instruction: 'Drive west.',
        maneuverType: 'depart',
        roadName: '',
        spokenInstruction: 'Drive west. Then turn right.',
      },
    ],
  };

  it('rejects destinations outside supported service areas before routing', async () => {
    let providerCalls = 0;
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => {
          providerCalls += 1;
          return Promise.resolve([route]);
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 43.6532, longitude: -79.3832 },
        origin: { latitude: 49.888, longitude: -119.496 },
      },
      url: '/v1/routes',
    });

    expect(response.statusCode).toBe(400);
    expect(providerCalls).toBe(0);
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      code: 'invalid_request',
      detail:
        'Driving routes are currently available only between supported Calgary and Kelowna area locations.',
      title: 'Route outside coverage',
    });
  });

  it('returns normalized route alternatives from the injected provider', async () => {
    const app = await createTestApp({
      routeProvider: { getRoutes: () => Promise.resolve([route]) },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
      },
      url: '/v1/routes',
    });
    const body = RouteResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.routes[0]).toEqual(route);
    expect(body.source.id).toBe('valhalla-development');
  });

  it('reports configured self-hosted routing as production', async () => {
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => Promise.resolve([route]),
        source: {
          attribution: 'Routing by Valhalla using OpenStreetMap data',
          degraded: false,
          id: 'valhalla-self-hosted',
          mode: 'production',
          traffic: 'unavailable',
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
      },
      url: '/v1/routes',
    });
    const body = RouteResponseSchema.parse(response.json());

    expect(body.degraded).toBe(false);
    expect(body.source).toMatchObject({
      id: 'valhalla-self-hosted',
      mode: 'production',
    });
  });

  it('returns live traffic delay and provider attribution', async () => {
    const trafficRoute: RouteAlternative = {
      ...route,
      durationSeconds: 1_515.354,
      traffic: {
        delaySeconds: 300,
        typicalDurationSeconds: 1_215.354,
      },
    };
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => Promise.resolve([trafficRoute]),
        source: {
          attribution: 'Routing and traffic by Mapbox',
          degraded: false,
          id: 'mapbox-traffic',
          mode: 'production',
          traffic: 'live',
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
      },
      url: '/v1/routes',
    });
    const body = RouteResponseSchema.parse(response.json());

    expect(body.routes[0]?.traffic).toEqual({
      delaySeconds: 300,
      typicalDurationSeconds: 1_215.354,
    });
    expect(body.source).toEqual({
      attribution: 'Routing and traffic by Mapbox',
      id: 'mapbox-traffic',
      mode: 'production',
      traffic: 'live',
    });
  });

  it('returns a stable problem when the route provider is unavailable', async () => {
    const { RouteProviderError } = await import('../src/route-provider.js');
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => Promise.reject(new RouteProviderError('offline')),
      },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
      },
      url: '/v1/routes',
    });
    const body = ProblemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(body).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Routing unavailable',
    });
  });
});

describe('OpenAPI', () => {
  it('publishes the typed routes without documenting itself', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json<{ openapi: string; paths: Record<string, unknown> }>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths).toHaveProperty('/health');
    expect(document.paths).toHaveProperty('/ready');
    expect(document.paths).toHaveProperty('/v1/config');
    expect(document.paths).toHaveProperty('/v2/config');
    expect(document.paths).toHaveProperty('/v1/contributions');
    expect(document.paths).toHaveProperty('/v1/google-place-query-grants');
    expect(document.paths).toHaveProperty('/v1/cameras');
    expect(document.paths).toHaveProperty('/v1/routes');
    expect(document.paths).toHaveProperty('/v1/search');
    expect(document.paths).toHaveProperty('/v2/cameras');
    expect(document.paths).toHaveProperty('/v2/events');
    expect(document.paths).toHaveProperty('/v2/safety-facilities');
    expect(document.paths).toHaveProperty('/v2/traffic-cameras');
    expect(document.paths).not.toHaveProperty('/openapi.json');
  });
});
