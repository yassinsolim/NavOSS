import { describe, expect, it } from 'vitest';

import {
  AppConfigResponseSchema,
  compareRouteAlternatives,
  ContributionSubmissionRequestSchema,
  GeographicBoundsSchema,
  GooglePlaceQueryGrantResponseSchema,
  OfficialRoadEventResponseSchema,
  OfficialSafetyCameraResponseSchema,
  RoadEventResponseSchema,
  SafetyFacilityResponseSchema,
  SafetyCameraResponseSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SearchQuerySchema,
  SearchResponseSchema,
  TrafficCameraResponseSchema,
} from '../src/index.js';

describe('GeographicBoundsSchema', () => {
  it('rejects inverted bounds', () => {
    const result = GeographicBoundsSchema.safeParse({
      northEast: { latitude: 50.8, longitude: -114.2 },
      southWest: { latitude: 51.2, longitude: -113.8 },
    });

    expect(result.success).toBe(false);
  });
});

describe('ContributionSubmissionRequestSchema', () => {
  it('accepts bounded anonymous beta feedback without coordinates or identity', () => {
    const submission = ContributionSubmissionRequestSchema.parse({
      createdAt: '2026-07-30T23:00:00.000Z',
      description: 'The entrance pin is on the wrong side of the building.',
      draftId: '2026-07-30T23:00:00.000Z:abc123',
      locationLabel: 'Downtown Kelowna',
      type: 'place-correction',
    });

    expect(submission).not.toHaveProperty('coordinate');
    expect(submission).not.toHaveProperty('userId');
  });
});

describe('GooglePlaceQueryGrantResponseSchema', () => {
  it('accepts the bounded anonymous monthly grant state', () => {
    expect(
      GooglePlaceQueryGrantResponseSchema.parse({
        granted: true,
        limit: 8_000,
        period: '2026-07',
        remaining: 7_999,
        resetsAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toMatchObject({ granted: true, limit: 8_000, remaining: 7_999 });
  });
});

describe('SearchQuerySchema', () => {
  it('coerces bounded query values', () => {
    const result = SearchQuerySchema.parse({
      latitude: '51.0447',
      limit: '5',
      longitude: '-114.0719',
      q: '  Calgary Tower  ',
    });

    expect(result).toEqual({
      latitude: 51.0447,
      limit: 5,
      longitude: -114.0719,
      q: 'Calgary Tower',
    });
  });

  it('requires latitude and longitude together', () => {
    const result = SearchQuerySchema.safeParse({ latitude: '51.0447', q: 'library' });

    expect(result.success).toBe(false);
  });

  it('requires proximity when sorting search results by distance', () => {
    expect(SearchQuerySchema.safeParse({ q: 'restaurant', sort: 'distance' }).success).toBe(false);
    expect(
      SearchQuerySchema.safeParse({
        latitude: 51.0447,
        longitude: -114.0719,
        q: 'restaurant',
        sort: 'distance',
      }).success,
    ).toBe(true);
  });
});

describe('SearchResponseSchema', () => {
  it('makes fixture freshness explicit', () => {
    const result = SearchResponseSchema.safeParse({
      degraded: true,
      results: [],
      source: {
        datasetVersion: 'fixture-v1',
        freshness: 'static',
        id: 'calgary-alpha-fixtures',
        updatedAt: '2026-07-15T12:00:00Z',
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts optional open-data place details', () => {
    const result = SearchResponseSchema.safeParse({
      degraded: false,
      results: [
        {
          category: 'poi',
          center: { latitude: 51.04427, longitude: -114.06309 },
          confidence: 0.98,
          distanceMeters: 620,
          details: {
            address: '101 9 Avenue SW, Calgary, Alberta',
            openingHours: 'Mo-Su 10:00-21:00',
            phone: '+1 403 266 7171',
            website: 'https://www.calgarytower.com',
            wheelchair: 'yes',
          },
          id: 'nominatim:node:2359239747',
          label: 'Calgary Tower, 101 9 Avenue SW, Calgary, Alberta',
          name: 'Calgary Tower',
        },
      ],
      source: {
        datasetVersion: 'alberta-2026-07-20',
        freshness: 'fresh',
        id: 'nominatim-self-hosted',
        updatedAt: '2026-07-20T12:00:00Z',
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('SafetyCameraResponseSchema', () => {
  it('accepts official combined red-light and speed enforcement cameras', () => {
    const result = SafetyCameraResponseSchema.safeParse({
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
        datasetUrl:
          'https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx',
        updateFrequency: 'monthly',
        updatedAt: '2026-07-01T12:00:00Z',
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('OfficialRoadEventResponseSchema', () => {
  const response = {
    degraded: false,
    events: [
      {
        confidence: 'official',
        coordinate: { latitude: 43.63599, longitude: -79.668724 },
        description: 'Construction on Highway 401. One alternating lane.',
        direction: 'Eastbound',
        endsAt: '2026-08-24T05:00:00.000Z',
        id: 'ontario-511:1963:222249',
        isFullClosure: false,
        regionId: 'ontario',
        reportedAt: '2026-07-30T04:00:00.000Z',
        roadwayName: 'HWY 401',
        sourceId: 'ontario-511-events',
        startsAt: '2026-07-30T04:00:00.000Z',
        title: 'Construction on HWY 401',
        type: 'construction',
        updatedAt: '2026-07-30T20:00:00.000Z',
      },
    ],
    generatedAt: '2026-07-30T20:32:00.000Z',
    regionId: 'ontario',
    source: {
      apiDocumentationUrl: 'https://511on.ca/developers/doc',
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 Ontario.',
      confidence: 'official',
      licenseUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
      refreshIntervalSeconds: 300,
      sourceId: 'ontario-511-events',
      updatedAt: '2026-07-30T20:00:00.000Z',
    },
    stale: false,
  };

  it('accepts official Ontario 511 events with UTC source timestamps', () => {
    expect(OfficialRoadEventResponseSchema.safeParse(response).success).toBe(true);
  });

  it('accepts official DriveBC Open511 events in the Kelowna region', () => {
    expect(
      OfficialRoadEventResponseSchema.safeParse({
        degraded: false,
        events: [
          {
            confidence: 'official',
            coordinate: { latitude: 49.888, longitude: -119.496 },
            description: 'Utility work. Expect delays.',
            direction: 'Both directions',
            endsAt: '2026-08-02T06:00:00.000Z',
            id: 'drivebc-open511:kelowna-1',
            isFullClosure: false,
            regionId: 'kelowna-bc',
            reportedAt: '2026-07-30T18:00:00.000Z',
            roadwayName: 'Harvey Avenue',
            sourceId: 'drivebc-open511-events',
            startsAt: '2026-07-30T18:00:00.000Z',
            title: 'Construction on Harvey Avenue',
            type: 'construction',
            updatedAt: '2026-07-30T20:00:00.000Z',
          },
        ],
        generatedAt: '2026-07-30T20:32:00.000Z',
        regionId: 'kelowna-bc',
        source: {
          apiDocumentationUrl: 'https://api.open511.gov.bc.ca/help',
          attribution:
            'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
          confidence: 'official',
          dataUrl:
            'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&bbox=-119.65,49.70,-119.20,50.15&limit=500',
          licenseUrl:
            'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc',
          refreshIntervalSeconds: 300,
          sourceId: 'drivebc-open511-events',
          updatedAt: '2026-07-30T20:00:00.000Z',
        },
        stale: false,
      }).success,
    ).toBe(true);
  });

  it('rejects mixed Ontario and DriveBC region/source metadata', () => {
    expect(
      OfficialRoadEventResponseSchema.safeParse({
        ...response,
        regionId: 'kelowna-bc',
      }).success,
    ).toBe(false);
    expect(
      OfficialRoadEventResponseSchema.safeParse({
        ...response,
        events: [{ ...response.events[0], regionId: 'kelowna-bc' }],
      }).success,
    ).toBe(false);
  });

  it('rejects out-of-province events and inconsistent stale posture', () => {
    expect(
      OfficialRoadEventResponseSchema.safeParse({
        ...response,
        degraded: false,
        events: [
          {
            ...response.events[0],
            coordinate: { latitude: 51.04, longitude: -114.07 },
          },
        ],
        stale: true,
      }).success,
    ).toBe(false);
  });
});

describe('TrafficCameraResponseSchema', () => {
  it('accepts ordinary DriveBC traffic cameras and preserves orientation identity', () => {
    const result = TrafficCameraResponseSchema.safeParse({
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
        {
          cameraType: 'traffic',
          caption: 'Highway 97 in Lake Country by Wood Lake, looking south.',
          coordinate: { latitude: 50.057111, longitude: -119.407653 },
          enforcement: false,
          highway: '97',
          id: 'drivebc-highwaycam:533',
          imageUrl: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/533.jpg',
          name: 'Lake Country - S',
          orientation: 'S',
          pageUrl: 'https://images.drivebc.ca/bchighwaycam/pub/html/www/533.html',
          regionId: 'kelowna-bc',
          thumbnailUrl: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/tn/533.jpg',
        },
      ],
      degraded: false,
      generatedAt: '2026-07-30T20:32:00.000Z',
      source: {
        attribution:
          'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
        catalogueUrl:
          'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c',
        datasetId: '6b39a910-6c77-476f-ac96-7b4f18849b1c',
        dataUrl:
          'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv',
        licenseUrl: 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61',
        regionId: 'kelowna-bc',
        resourceId: 'a9d52d85-8402-4ce7-b2ac-a2779837c48a',
        sourceId: 'drivebc-highwaycams',
        updateFrequency: 'monthly',
        updatedAt: '2026-06-05T16:31:00.000Z',
      },
      stale: false,
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cameras).toHaveLength(2);
  });

  it('rejects enforcement relabelling and inconsistent stale posture', () => {
    expect(
      TrafficCameraResponseSchema.safeParse({
        cameras: [],
        degraded: false,
        generatedAt: '2026-07-30T20:32:00.000Z',
        source: {
          attribution:
            'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
          catalogueUrl:
            'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c',
          datasetId: '6b39a910-6c77-476f-ac96-7b4f18849b1c',
          dataUrl:
            'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv',
          licenseUrl: 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61',
          regionId: 'kelowna-bc',
          resourceId: 'a9d52d85-8402-4ce7-b2ac-a2779837c48a',
          sourceId: 'drivebc-highwaycams',
          updateFrequency: 'monthly',
        },
        stale: true,
      }).success,
    ).toBe(false);
  });
});

describe('SafetyFacilityResponseSchema', () => {
  it('accepts only fixed, official Kelowna RCMP facilities', () => {
    expect(
      SafetyFacilityResponseSchema.safeParse({
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
        generatedAt: '2026-07-30T20:32:00.000Z',
        source: {
          attribution: 'Royal Canadian Mounted Police',
          dateModified: '2024-12-19',
          regionId: 'kelowna-bc',
          sourceId: 'kelowna-rcmp-public-facilities',
          sourceUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects live-police or checkpoint semantics', () => {
    expect(
      SafetyFacilityResponseSchema.safeParse({
        facilities: [
          { kind: 'live-police', type: 'checkpoint' },
          { kind: 'live-police', type: 'patrol' },
        ],
        generatedAt: '2026-07-30T20:32:00.000Z',
        source: {
          attribution: 'Royal Canadian Mounted Police',
          dateModified: '2024-12-19',
          regionId: 'kelowna-bc',
          sourceId: 'kelowna-rcmp-public-facilities',
          sourceUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate or substituted facilities', () => {
    const main = {
      address: '1190 Richter St',
      coordinate: { latitude: 49.89385756349143, longitude: -119.48887718651372 },
      id: 'kelowna-rcmp:main-detachment',
      kind: 'facility',
      name: 'Main Detachment',
      pageUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
      phone: '250-762-3300',
      regionId: 'kelowna-bc',
      type: 'police-station',
    };
    expect(
      SafetyFacilityResponseSchema.safeParse({
        facilities: [main, main],
        generatedAt: '2026-07-30T20:32:00.000Z',
        source: {
          attribution: 'Royal Canadian Mounted Police',
          dateModified: '2024-12-19',
          regionId: 'kelowna-bc',
          sourceId: 'kelowna-rcmp-public-facilities',
          sourceUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
        },
      }).success,
    ).toBe(false);
  });
});

describe('RoadEventResponseSchema', () => {
  const sources = [
    {
      attribution: 'The City of Calgary',
      confidence: 'official',
      datasetId: 'w8zq-79bq',
      datasetUrl: 'https://data.calgary.ca/d/w8zq-79bq',
      licenseUrl: 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa',
      sourceId: 'calgary-construction-detours',
      updateFrequency: 'twice daily',
      updatedAt: '2026-07-30T11:00:39Z',
    },
    {
      attribution: 'The City of Calgary',
      confidence: 'unverified',
      datasetId: '4jah-h97u',
      datasetUrl: 'https://data.calgary.ca/d/4jah-h97u',
      licenseUrl: 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa',
      sourceId: 'calgary-current-incidents',
      updateFrequency: '10 minutes',
      updatedAt: '2026-07-30T20:31:01Z',
    },
  ];

  it('accepts source-labelled Calgary road events with local civil time', () => {
    expect(
      RoadEventResponseSchema.safeParse({
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
        generatedAt: '2026-07-30T20:32:00Z',
        sources,
        stale: false,
      }).success,
    ).toBe(true);
  });

  it('rejects hidden confidence changes and inconsistent stale posture', () => {
    const invalid = {
      degraded: false,
      events: [
        {
          confidence: 'official',
          coordinate: { latitude: 51.04, longitude: -114.07 },
          description: 'Unverified collision.',
          id: 'calgary-incident:test',
          sourceId: 'calgary-current-incidents',
          startsAtLocal: '2026-07-30T12:00:00.000',
          timeZone: 'America/Edmonton',
          title: 'Traffic incident',
          type: 'incident',
        },
      ],
      generatedAt: '2026-07-30T20:32:00Z',
      sources,
      stale: true,
    };

    expect(RoadEventResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects swapped source metadata and events outside Calgary coverage', () => {
    const invalidSources = [{ ...sources[0], confidence: 'unverified' }, sources[1]];
    const invalid = {
      degraded: false,
      events: [
        {
          confidence: 'official',
          coordinate: { latitude: 43.65, longitude: -79.38 },
          description: 'Lane closure.',
          id: 'calgary-construction:test',
          sourceId: 'calgary-construction-detours',
          startsAtLocal: '2026-07-30T12:00:00.000',
          timeZone: 'America/Edmonton',
          title: 'Construction',
          type: 'construction',
        },
      ],
      generatedAt: '2026-07-30T20:32:00Z',
      sources: invalidSources,
      stale: false,
    };

    expect(RoadEventResponseSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('route contracts', () => {
  it('ranks routes by duration first and distance second', () => {
    const routes = [
      { distanceMeters: 9_000, durationSeconds: 600 },
      { distanceMeters: 8_000, durationSeconds: 600 },
      { distanceMeters: 12_000, durationSeconds: 540 },
    ];

    expect([...routes].sort(compareRouteAlternatives)).toEqual([
      { distanceMeters: 12_000, durationSeconds: 540 },
      { distanceMeters: 8_000, durationSeconds: 600 },
      { distanceMeters: 9_000, durationSeconds: 600 },
    ]);
  });

  it('keeps the true fastest route first when ETAs display the same minute', () => {
    const routes = [
      { distanceMeters: 12_000, durationSeconds: 540 },
      { distanceMeters: 6_000, durationSeconds: 559 },
      { distanceMeters: 5_000, durationSeconds: 600 },
    ];

    expect([...routes].sort(compareRouteAlternatives)).toEqual([
      { distanceMeters: 12_000, durationSeconds: 540 },
      { distanceMeters: 6_000, durationSeconds: 559 },
      { distanceMeters: 5_000, durationSeconds: 600 },
    ]);
  });

  it('applies safe driving defaults to a route request', () => {
    const request = RouteRequestSchema.parse({
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
    });

    expect(request).toEqual({
      alternatives: 1,
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    });
  });

  it('accepts ordered intermediate stops and rejects duplicate consecutive locations', () => {
    const request = RouteRequestSchema.parse({
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      waypoints: [
        { latitude: 51.05, longitude: -114.08 },
        { latitude: 51.08, longitude: -114.04 },
      ],
    });

    expect(request.waypoints).toEqual([
      { latitude: 51.05, longitude: -114.08 },
      { latitude: 51.08, longitude: -114.04 },
    ]);
    expect(
      RouteRequestSchema.safeParse({
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
        waypoints: [{ latitude: 51.0447, longitude: -114.0719 }],
      }).success,
    ).toBe(false);
  });

  it('accepts normalized route geometry and guidance', () => {
    const result = RouteResponseSchema.safeParse({
      degraded: true,
      generatedAt: '2026-07-15T12:00:00Z',
      routes: [
        {
          distanceMeters: 19660.564,
          durationSeconds: 1215.354,
          geometry: [
            [-114.071903, 51.044666],
            [-114.01055, 51.13157],
          ],
          id: 'route-1',
          label: 'fastest',
          speedLimitsKph: [50],
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
        },
      ],
      source: {
        attribution: 'Routing by Valhalla using OpenStreetMap data',
        id: 'valhalla-development',
        mode: 'development',
        traffic: 'unavailable',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects speed limits that do not align with route geometry segments', () => {
    const result = RouteResponseSchema.safeParse({
      degraded: true,
      generatedAt: '2026-07-15T12:00:00Z',
      routes: [
        {
          distanceMeters: 1_000,
          durationSeconds: 120,
          geometry: [
            [-114.08, 51.04],
            [-114.07, 51.05],
            [-114.06, 51.06],
          ],
          id: 'route-speed-limits',
          label: 'fastest',
          speedLimitsKph: [50],
          steps: [
            {
              distanceMeters: 1_000,
              durationSeconds: 120,
              geometry: [
                [-114.08, 51.04],
                [-114.06, 51.06],
              ],
              instruction: 'Continue north.',
              maneuverType: 'continue',
              roadName: 'Test Road',
            },
          ],
        },
      ],
      source: {
        attribution: 'Routing by Valhalla using OpenStreetMap data',
        id: 'valhalla-development',
        mode: 'development',
        traffic: 'unavailable',
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts self-hosted production routing metadata', () => {
    const result = RouteResponseSchema.safeParse({
      degraded: false,
      generatedAt: '2026-07-23T12:00:00Z',
      routes: [
        {
          distanceMeters: 1_000,
          durationSeconds: 120,
          geometry: [
            [-114.0719, 51.0447],
            [-114.0631, 51.0443],
          ],
          id: 'route-production',
          label: 'fastest',
          steps: [
            {
              distanceMeters: 1_000,
              durationSeconds: 120,
              geometry: [
                [-114.0719, 51.0447],
                [-114.0631, 51.0443],
              ],
              instruction: 'Continue east.',
              maneuverType: 'continue',
              roadName: '9 Avenue SW',
            },
          ],
        },
      ],
      source: {
        attribution: 'Routing by Valhalla using OpenStreetMap data',
        id: 'valhalla-self-hosted',
        mode: 'production',
        traffic: 'unavailable',
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts licensed live-traffic routing metadata and delay', () => {
    const result = RouteResponseSchema.safeParse({
      degraded: false,
      generatedAt: '2026-07-23T22:00:00Z',
      routes: [
        {
          distanceMeters: 20_000,
          durationSeconds: 1_800,
          geometry: [
            [-114.08, 51.04],
            [-114.01, 51.13],
          ],
          id: 'mapbox-traffic-1',
          label: 'fastest',
          steps: [
            {
              distanceMeters: 20_000,
              durationSeconds: 1_800,
              geometry: [
                [-114.08, 51.04],
                [-114.01, 51.13],
              ],
              instruction: 'Continue north.',
              maneuverType: 'continue',
              roadName: 'Deerfoot Trail',
            },
          ],
          traffic: {
            delaySeconds: 300,
            typicalDurationSeconds: 1_500,
          },
        },
      ],
      source: {
        attribution: 'Routing and traffic by Mapbox',
        id: 'mapbox-traffic',
        mode: 'production',
        traffic: 'live',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a route whose origin and destination are identical', () => {
    const result = RouteRequestSchema.safeParse({
      destination: { latitude: 51.0447, longitude: -114.0719 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
    });

    expect(result.success).toBe(false);
  });
});

describe('AppConfigResponseSchema', () => {
  it('accepts the technical-alpha feature posture', () => {
    const result = AppConfigResponseSchema.safeParse({
      apiVersion: 'v1',
      attribution: [
        { label: 'OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
      ],
      coverage: {
        displayName: 'Calgary and Kelowna service areas',
        id: 'calgary-kelowna-service-areas',
        modes: ['driving'],
        serviceAreas: [
          {
            bounds: {
              northEast: { latitude: 51.212, longitude: -113.859 },
              southWest: { latitude: 50.842, longitude: -114.316 },
            },
            displayName: 'Calgary, Alberta',
            id: 'calgary-ab',
          },
          {
            bounds: {
              northEast: { latitude: 50.15, longitude: -119.2 },
              southWest: { latitude: 49.7, longitude: -119.65 },
            },
            displayName: 'Kelowna, British Columbia',
            id: 'kelowna-bc',
          },
        ],
      },
      endpoints: {
        cameras: '/v1/cameras',
        events: '/v1/events',
        routes: '/v1/routes',
        search: '/v1/search',
      },
      features: {
        communityReports: false,
        liveTraffic: false,
        officialSafetyCameras: true,
        productionSearch: false,
      },
      generatedAt: '2026-07-15T12:00:00Z',
      minimumAppVersion: '0.0.0',
      style: { id: 'navoss-alpha', version: 'fixture-v1' },
    });

    expect(result.success).toBe(true);
  });
});

describe('OfficialSafetyCameraResponseSchema', () => {
  it('accepts a direction-unknown Toronto red-light camera with explicit provenance', () => {
    const result = OfficialSafetyCameraResponseSchema.safeParse({
      cameras: [
        {
          coordinate: { latitude: 43.646383, longitude: -79.384099 },
          enforcement: ['red-light'],
          id: 'toronto-rlc:6098',
          jurisdiction: 'City of Toronto',
          location: 'University Ave and Wellington St W',
          regionId: 'toronto-on',
        },
      ],
      generatedAt: '2026-07-27T12:00:00Z',
      source: {
        attribution: 'City of Toronto',
        datasetId: '9fcff3e1-3737-43cf-b410-05acd615e27b',
        datasetUrl: 'https://open.toronto.ca/dataset/red-light-cameras/',
        licenseUrl: 'https://open.toronto.ca/open-data-licence/',
        regionId: 'toronto-on',
        updateFrequency: 'daily',
        updatedAt: '2026-07-25T05:03:56.000Z',
      },
    });

    expect(result.success).toBe(true);
  });
});
