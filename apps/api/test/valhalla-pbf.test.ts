import {
  RouteAlternativeV2Schema,
  RouteResponseV2Schema,
  RouteRequestV2Schema,
  type RouteRequest,
} from '@navoss/contracts';
import protobuf from 'protobufjs/light.js';
import { describe, expect, it, vi } from 'vitest';

import descriptor from '../src/valhalla-proto-3.8.2.json' with { type: 'json' };
import {
  buildValhallaPbfRequest,
  normalizeValhallaPbfResponse,
  parseValhallaPbf,
  ValhallaDecodeError,
} from '../src/valhalla-pbf.js';
import { createValhallaRouteProvider, RouteProviderError } from '../src/route-provider.js';
import calgary from './fixtures/valhalla/calgary-deerfoot-glenmore.json' with { type: 'json' };
import stoney from './fixtures/valhalla/calgary-stoney-airport.json' with { type: 'json' };
import vancouver from './fixtures/valhalla/vancouver-highway-interchange.json' with { type: 'json' };
import local382 from './fixtures/valhalla/calgary-deerfoot-glenmore-local382.json' with { type: 'json' };
import directionsOnly from './fixtures/valhalla/calgary-directions-only.json' with { type: 'json' };
import legacy from './fixtures/valhalla/calgary-legacy-osrm.json' with { type: 'json' };
import waypointBreak from './fixtures/valhalla/calgary-waypoint-break.json' with { type: 'json' };
import waypointThrough from './fixtures/valhalla/calgary-waypoint-through.json' with { type: 'json' };
import roundabout from './fixtures/valhalla/calgary-roundabout.json' with { type: 'json' };
import roundabout382 from './fixtures/valhalla/calgary-roundabout-local382.json' with { type: 'json' };

const ApiType = protobuf.Root.fromJSON(descriptor.schema).lookupType('valhalla.Api');
const bytes = (response: unknown) =>
  ApiType.encode(
    ApiType.fromObject(response as Record<string, unknown>),
  ).finish() as Uint8Array<ArrayBuffer>;
const request: RouteRequest = calgary.request;

describe('real Valhalla lossless response fixtures', () => {
  it.each([
    ['Calgary Deerfoot/Glenmore', calgary],
    ['Calgary Stoney/airport', stoney],
    ['Metro Vancouver highway interchanges', vancouver],
    ['exact production 3.8.2 image', local382],
  ] as const)(
    'decodes %s into a valid route with actual lanes and posted-limit status',
    (_name, fixture) => {
      const routes = parseValhallaPbf(bytes(fixture.response));
      expect(routes[0]?.steps.some((step) => (step.lanes?.length ?? 0) > 0)).toBe(true);
      expect(routes[0]?.speedLimits?.length).toBe(routes[0]!.geometry.length - 1);
      expect(routes[0]?.speedLimits).toContainEqual({ status: 'unknown' });
      expect(
        routes[0]?.speedLimits?.every((limit) => limit.status !== 'known' || limit.kph > 0),
      ).toBe(true);
      expect(
        RouteResponseV2Schema.safeParse({
          degraded: false,
          generatedAt: fixture.capturedAt,
          routes,
          source: {
            attribution: 'Routing by Valhalla using OpenStreetMap data',
            id: 'valhalla-self-hosted',
            mode: 'production',
            traffic: 'unavailable',
          },
        }).success,
      ).toBe(true);
    },
  );

  it('keeps lane order, valid/active state and signposts associated with the maneuver, not a later intersection', () => {
    const route = parseValhallaPbf(bytes(calgary.response))[0]!;
    const exit = route.steps.find((step) => step.exitNumber === '248')!;
    expect(exit.lanes).toEqual([
      { indications: ['straight'], valid: false, active: false },
      { indications: ['straight'], valid: false, active: false },
      { indications: ['right'], valid: true, active: true, validIndication: 'right' },
    ]);
    expect(exit.signpostToward).toEqual(['Glenmore Trail']);
    expect(exit.maneuverModifier).toBe('slight right');
    expect(route.steps.find((step) => step.roadName === '19 Street NE')).not.toHaveProperty(
      'lanes',
    );
    expect(
      route.steps.find((step) => step.roadName === '16 Avenue NE')?.lanes?.[0]?.validIndication,
    ).toBe('left');
    const fork = route.steps.find((step) => step.exitNumber === '248B')!;
    expect(fork.lanes?.[0]).toEqual({
      indications: ['slight_left', 'slight_right'],
      valid: true,
      active: true,
      validIndication: 'slight_right',
    });
    expect(
      route.steps.find((step) => step.signpostBranch?.includes('Deerfoot Trail'))?.signpostToward,
    ).toEqual(['Fort Macleod']);
  });

  it('retains real Vancouver branch and toward text separately rather than splitting mixed OSRM destinations', () => {
    const route = parseValhallaPbf(bytes(vancouver.response))[0]!;
    const exit = route.steps.find((step) => step.exitNumber === '23B')!;
    expect(exit.signpostBranch).toEqual(['99 North']);
    expect(exit.signpostToward).toEqual(['Vancouver-YVR International Airport', 'Vancouver']);
    expect(exit.currentRoadName).toContain('Highway 99');
    expect(exit.lanes?.map((lane) => lane.active)).toEqual([false, false, true]);
    expect(exit.bearingBeforeDegrees).toBe(270);
    expect(exit.bearingAfterDegrees).toBe(279);
  });

  it('returns a valid base route when the real response has no trip/lanes/speed metadata', () => {
    const route = parseValhallaPbf(bytes(directionsOnly.response))[0]!;
    expect(RouteAlternativeV2Schema.safeParse(route).success).toBe(true);
    expect(route.steps.every((step) => step.lanes === undefined)).toBe(true);
    expect(route).not.toHaveProperty('speedLimits');
    expect(route).not.toHaveProperty('speedLimitsKph');
  });

  it('omits malformed optional fields without losing the decoded route', () => {
    const response = structuredClone(calgary.response);
    const exit = response.directions.routes[0]!.legs[0]!.maneuver.find(
      (maneuver) => 'sign' in maneuver && maneuver.sign?.exitNumbers?.[0]?.text === '248',
    )!;
    const pathIndex = 'beginPathIndex' in exit ? exit.beginPathIndex! : 0;
    const edge = response.trip.routes[0]!.legs[0]!.node[pathIndex - 1]!.edge!;
    const malformed = response as unknown as {
      trip: {
        routes: { legs: { node: { edge: { turnLanes: unknown; endHeading: unknown } }[] }[] }[];
      };
      directions: { routes: { legs: { maneuver: Record<string, unknown>[] }[] }[] };
    };
    malformed.trip.routes[0]!.legs[0]!.node[pathIndex - 1]!.edge.turnLanes = 'not lanes';
    malformed.trip.routes[0]!.legs[0]!.node[pathIndex - 1]!.edge.endHeading = 'not a bearing';
    const malformedExit = malformed.directions.routes[0]!.legs[0]!.maneuver.find(
      (maneuver) => maneuver.beginPathIndex === pathIndex,
    )!;
    malformedExit.roundaboutExitCount = 'third';
    malformedExit.sign = { exitNumbers: 'not sign elements' };
    expect(edge).toBeDefined();
    const route = normalizeValhallaPbfResponse(response)[0]!;
    const step = route.steps.find((candidate) => candidate.instruction === exit.textInstruction)!;
    expect(step).not.toHaveProperty('lanes');
    expect(step).not.toHaveProperty('bearingBeforeDegrees');
    expect(step).not.toHaveProperty('roundaboutExit');
    expect(step).not.toHaveProperty('exitNumber');
    expect(RouteAlternativeV2Schema.safeParse(route).success).toBe(true);
  });

  it('distinguishes unlimited limits from unknown without changing the legacy zero semantics', () => {
    const response = structuredClone(calgary.response);
    response.trip.routes[0]!.legs[0]!.shapeAttributes!.speedLimit[0] = 255;
    const route = parseValhallaPbf(bytes(response))[0]!;
    expect(route.speedLimits?.[0]).toEqual({ status: 'unlimited' });
    expect(route.speedLimitsKph?.[0]).toBe(0);
  });

  it('drops unaligned speed annotations instead of assigning a limit to the wrong segment', () => {
    const response = structuredClone(calgary.response);
    response.trip.routes[0]!.legs[0]!.shapeAttributes!.speedLimit.pop();
    const route = parseValhallaPbf(bytes(response))[0]!;
    expect(route).not.toHaveProperty('speedLimits');
    expect(route).not.toHaveProperty('speedLimitsKph');
  });

  it('keeps default break arrivals but suppresses intermediate arrival/departure for a real through waypoint', () => {
    const stopped = parseValhallaPbf(bytes(waypointBreak.response))[0]!;
    const through = parseValhallaPbf(bytes(waypointThrough.response))[0]!;
    expect(stopped.steps.filter((step) => step.maneuverType === 'arrive')).toHaveLength(2);
    expect(stopped.steps.filter((step) => step.maneuverType === 'depart')).toHaveLength(2);
    expect(through.steps.filter((step) => step.maneuverType === 'arrive')).toHaveLength(1);
    expect(through.steps.filter((step) => step.maneuverType === 'depart')).toHaveLength(1);
    for (const route of [stopped, through])
      expect(route.speedLimits?.length).toBe(route.geometry.length - 1);
  });

  it.each([
    [roundabout, 1],
    [roundabout382, 2],
  ] as const)(
    'preserves the actual roundabout exit number from its source graph',
    (fixture, exit) => {
      const route = parseValhallaPbf(bytes(fixture.response))[0]!;
      expect(route.steps.find((step) => step.maneuverType === 'roundabout')?.roundaboutExit).toBe(
        exit,
      );
    },
  );

  it('does not mistake departure side-of-street for a turn modifier', () => {
    const route = parseValhallaPbf(bytes(calgary.response))[0]!;
    expect(route.steps[0]?.maneuverType).toBe('depart');
    expect(route.steps[0]).not.toHaveProperty('maneuverModifier');
  });

  it('changes route identity when route guidance metadata changes', () => {
    const response = structuredClone(calgary.response);
    const activeLane = response.trip.routes[0]!.legs[0]!.node.flatMap(
      (node) => node.edge?.turnLanes ?? [],
    ).find((lane) => lane.state === 2)!;
    activeLane.state = 1;
    expect(parseValhallaPbf(bytes(response))[0]?.id).not.toBe(
      parseValhallaPbf(bytes(calgary.response))[0]?.id,
    );
  });

  it('rejects corrupt base geometry for the provider fallback, not as optional enrichment', () => {
    const response = structuredClone(calgary.response);
    response.directions.routes[0]!.legs[0]!.shape = 'invalid';
    expect(() => parseValhallaPbf(bytes(response))).toThrow(ValhallaDecodeError);
  });
});

describe('lossless Valhalla provider failure policy', () => {
  it('requests the required options and returns a real interchange route in one upstream call', async () => {
    const fetchImplementation = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.headers).toEqual({ 'Content-Type': 'application/x-protobuf' });
      expect(init?.body).toBeInstanceOf(Uint8Array);
      return Promise.resolve(new Response(bytes(local382.response)));
    });
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    const routes = await provider.getEnrichedRoutes!({
      ...request,
      originHeadingDegrees: 25,
      originHorizontalAccuracyMeters: 8,
      waypoints: [{ latitude: 51.065, longitude: -114.08 }],
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const sent = ApiType.toObject(
      ApiType.decode(fetchImplementation.mock.calls[0]![1]!.body as Uint8Array),
    );
    expect(sent).toMatchObject({
      options: {
        format: 3,
        costingType: 10,
        language: 'en-US',
        units: 0,
        turnLanes: true,
        roundaboutExits: true,
        pbfFieldSelector: { directions: true, trip: true, options: false },
        filterAttributes: ['shape_attributes.speed_limit'],
        locations: [
          { ll: { lat: 51.0626, lng: -114.0201 }, heading: 25, headingTolerance: 45, radius: 16 },
          { ll: { lat: 51.065, lng: -114.08 } },
          { ll: { lat: 50.9932, lng: -114.0943 } },
        ],
      },
    });
    expect(routes[0]?.steps.find((step) => step.exitNumber === '248')?.lanes?.length).toBe(3);
    expect(provider.isEnrichmentDegraded?.()).toBe(false);
  });

  it.each(['transport', 'HTTP error', 'Valhalla error status'] as const)(
    'does not retry a %s failure',
    async (kind) => {
      const fetchImplementation = vi.fn(() =>
        kind === 'transport'
          ? Promise.reject(new Error('transport failure'))
          : Promise.resolve(
              kind === 'HTTP error'
                ? new Response('unavailable', { status: 503 })
                : new Response(bytes({ info: { errors: [{ code: 442 }] } })),
            ),
      );
      const onDecodeFailure = vi.fn();
      const provider = createValhallaRouteProvider({
        endpoint: 'http://valhalla.test/route',
        fetchImplementation,
        onDecodeFailure,
      });
      await expect(provider.getEnrichedRoutes!(request)).rejects.toBeInstanceOf(RouteProviderError);
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(onDecodeFailure).not.toHaveBeenCalled();
      expect(provider.isEnrichmentDegraded?.()).toBe(false);
    },
  );

  it('does not retry a response-body transport failure after headers arrived', async () => {
    const response = new Response('unreadable body');
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new TypeError('body transport failed'));
    const fetchImplementation = vi.fn(() => Promise.resolve(response));
    const onDecodeFailure = vi.fn();
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
      onDecodeFailure,
    });
    await expect(provider.getEnrichedRoutes!(request)).rejects.toBeInstanceOf(RouteProviderError);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(onDecodeFailure).not.toHaveBeenCalled();
  });

  it('preserves a through waypoint in the single legacy-format decode fallback', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([255])))
      .mockResolvedValueOnce(new Response(JSON.stringify(legacy.response)));
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    await provider.getEnrichedRoutes!(RouteRequestV2Schema.parse(waypointThrough.request));
    expect(JSON.parse(fetchImplementation.mock.calls[1]![1].body).locations[1].type).toBe(
      'through',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('makes exactly one legacy fallback on a received but undecodable base route and logs only the error name', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([255])))
      .mockResolvedValueOnce(new Response(JSON.stringify(legacy.response)))
      .mockResolvedValueOnce(new Response(bytes(local382.response)));
    const onDecodeFailure = vi.fn();
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
      onDecodeFailure,
    });
    const routes = await provider.getEnrichedRoutes!(request);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(typeof fetchImplementation.mock.calls[1]![1].body).toBe('string');
    expect(routes[0]?.steps.every((step) => step.lanes === undefined)).toBe(true);
    expect(provider.isEnrichmentDegraded?.()).toBe(true);
    expect(onDecodeFailure).toHaveBeenCalledExactlyOnceWith('ValhallaDecodeError');
    await provider.getEnrichedRoutes!(request);
    expect(provider.isEnrichmentDegraded?.()).toBe(false);
  });

  it('keeps the legacy request format unchanged even after successful v2 enrichment', async () => {
    const fetchImplementation = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Promise.resolve(
        new Response(
          typeof init?.body === 'string'
            ? JSON.stringify(legacy.response)
            : bytes(local382.response),
        ),
      ),
    );
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    await provider.getEnrichedRoutes!(request);
    const routes = await provider.getRoutes(request);
    expect(JSON.parse(fetchImplementation.mock.calls[1]![1]!.body as string)).toMatchObject({
      format: 'osrm',
      turn_lanes: true,
      shape_format: 'geojson',
    });
    expect(
      routes[0]?.steps.every((step) => !('lanes' in step) && !('currentRoadName' in step)),
    ).toBe(true);
  });

  it('correlates heading/radius only to the first location and preserves zero-valued costing preferences', () => {
    const sent = ApiType.toObject(
      ApiType.decode(
        buildValhallaPbfRequest({
          ...request,
          alternatives: 2,
          originHeadingDegrees: 359.9,
          preferences: {
            avoidFerries: true,
            avoidHighways: true,
            avoidTolls: true,
            avoidUnpaved: true,
          },
        }),
      ),
    );
    expect(sent.options.locations[0].heading).toBe(0);
    expect(sent.options.locations[1]).not.toHaveProperty('heading');
    expect(sent.options.costings['10'].options).toEqual({
      excludeUnpaved: true,
      useFerry: 0,
      useHighways: 0,
      useTolls: 0,
    });
    expect(sent.options).not.toHaveProperty('dateTime');
  });
});
