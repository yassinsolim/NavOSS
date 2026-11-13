import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import {
  ReadinessResponseSchema,
  RouteResponseSchema,
  RouteResponseV2Schema,
  type RouteAlternativeV2,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import protobuf from 'protobufjs/light.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { buildApp } from '../src/app.js';
import { createValhallaRouteProvider } from '../src/route-provider.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import descriptor from '../src/valhalla-proto-3.8.2.json' with { type: 'json' };
import local382 from './fixtures/valhalla/calgary-deerfoot-glenmore-local382.json' with { type: 'json' };
import legacy from './fixtures/valhalla/calgary-legacy-osrm.json' with { type: 'json' };
import waypointBreak from './fixtures/valhalla/calgary-waypoint-break.json' with { type: 'json' };
import waypointThrough from './fixtures/valhalla/calgary-waypoint-through.json' with { type: 'json' };
const ApiType = protobuf.Root.fromJSON(descriptor.schema).lookupType('valhalla.Api');
const fixtureBytes = ApiType.encode(
  ApiType.fromObject(local382.response),
).finish() as Uint8Array<ArrayBuffer>;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe('versioned route HTTP compatibility', () => {
  it('serves lanes at v2 while v1 remains strict-build-70-compatible after using the same provider', async () => {
    const fetchImplementation = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Promise.resolve(
        new Response(
          typeof init?.body === 'string' ? JSON.stringify(legacy.response) : fixtureBytes,
        ),
      ),
    );
    const app = await buildApp({
      searchProvider: createFixtureSearchProvider(),
      routeProvider: createValhallaRouteProvider({
        endpoint: 'http://valhalla.test/route',
        fetchImplementation,
      }),
    });
    apps.push(app);
    const enriched = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: local382.request,
    });
    expect(enriched.statusCode).toBe(200);
    const v2 = RouteResponseV2Schema.parse(enriched.json());
    expect(v2.routes[0]?.steps.find((step) => step.exitNumber === '248')?.lanes?.length).toBe(3);
    expect(v2.routes[0]?.speedLimits?.some((limit) => limit.status === 'unknown')).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const compatible = await app.inject({
      method: 'POST',
      url: '/v1/routes',
      payload: local382.request,
    });
    expect(compatible.statusCode).toBe(200);
    expect(() => RouteResponseSchema.parse(compatible.json())).not.toThrow();
    const v1 = compatible.json<{
      routes: {
        steps: Record<string, unknown>[];
      }[];
    }>();
    expect(
      fixtureValue(v1.routes[0]).steps.every(
        (step) => !('lanes' in step) && !('currentRoadName' in step) && !('signpost' in step),
      ),
    ).toBe(true);
  });
  it('surfaces a decoded-base fallback as degraded-but-ready without exposing the route or error cause', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([255])))
      .mockResolvedValueOnce(new Response(JSON.stringify(legacy.response)));
    const onDecodeFailure = vi.fn();
    const app = await buildApp({
      searchProvider: createFixtureSearchProvider(),
      routeProvider: createValhallaRouteProvider({
        endpoint: 'http://valhalla.test/route',
        fetchImplementation,
        onDecodeFailure,
      }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: local382.request,
    });
    expect(response.statusCode).toBe(200);
    const route = fixtureValue(RouteResponseV2Schema.parse(response.json()).routes[0]);
    expect(route.steps.every((step) => step.lanes === undefined)).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(onDecodeFailure).toHaveBeenCalledExactlyOnceWith('ValhallaDecodeError');
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    const body = ReadinessResponseSchema.parse(ready.json());
    expect(body.checks.routingProvider).toEqual({
      status: 'ready',
      detail:
        'Routing is ready via the legacy format; extended guidance is degraded after a protobuf decoding failure.',
    });
    expect(ready.body).not.toContain(String(local382.request.origin.latitude));
  });
});
describe('v2 waypoint and post-routing seams', () => {
  it('uses a through waypoint without an arrival and keeps omitted types as breaks', async () => {
    const throughBytes = ApiType.encode(
      ApiType.fromObject(waypointThrough.response),
    ).finish() as Uint8Array<ArrayBuffer>;
    const breakBytes = ApiType.encode(
      ApiType.fromObject(waypointBreak.response),
    ).finish() as Uint8Array<ArrayBuffer>;
    const fetchImplementation = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = z
        .object({
          options: z.object({ locations: z.array(z.object({ type: z.number().optional() })) }),
        })
        .parse(ApiType.toObject(ApiType.decode(fixtureValue(init).body as Uint8Array)));
      return Promise.resolve(
        new Response(request.options.locations[1]?.type === 1 ? throughBytes : breakBytes),
      );
    });
    const app = await buildApp({
      searchProvider: createFixtureSearchProvider(),
      routeProvider: createValhallaRouteProvider({
        endpoint: 'http://valhalla.test/route',
        fetchImplementation,
      }),
    });
    apps.push(app);
    const through = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: waypointThrough.request,
    });
    expect(through.statusCode).toBe(200);
    expect(
      RouteResponseV2Schema.parse(through.json()).routes[0]?.steps.filter(
        (step) => step.maneuverType === 'arrive',
      ),
    ).toHaveLength(1);
    const stopped = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: waypointBreak.request,
    });
    expect(stopped.statusCode).toBe(200);
    expect(
      RouteResponseV2Schema.parse(stopped.json()).routes[0]?.steps.filter(
        (step) => step.maneuverType === 'arrive',
      ),
    ).toHaveLength(2);
    const legacyTyped = await app.inject({
      method: 'POST',
      url: '/v1/routes',
      payload: waypointThrough.request,
    });
    expect(legacyTyped.statusCode).toBe(400);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('runs an injected post-routing enricher on v2 only', async () => {
    const enrichRoutes = vi.fn((routes: RouteAlternativeV2[]) => routes);
    const fetchImplementation = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Promise.resolve(
        new Response(
          typeof init?.body === 'string' ? JSON.stringify(legacy.response) : fixtureBytes,
        ),
      ),
    );
    const app = await buildApp({
      enrichRoutes,
      searchProvider: createFixtureSearchProvider(),
      routeProvider: createValhallaRouteProvider({
        endpoint: 'http://valhalla.test/route',
        fetchImplementation,
      }),
    });
    apps.push(app);
    expect(
      (await app.inject({ method: 'POST', url: '/v2/routes', payload: local382.request }))
        .statusCode,
    ).toBe(200);
    expect(enrichRoutes).toHaveBeenCalledOnce();
    expect(
      (await app.inject({ method: 'POST', url: '/v1/routes', payload: local382.request }))
        .statusCode,
    ).toBe(200);
    expect(enrichRoutes).toHaveBeenCalledOnce();
  });
});
