import { RouteRequestV2Schema } from '@navoss/contracts';
import protobuf from 'protobufjs/light.js';
import { describe, expect, it, vi } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import {
  createValhallaRouteProvider,
  RouteProviderError,
  type RouteProviderRequestOptions,
} from '../src/route-provider.js';
import { buildValhallaPbfRequest } from '../src/valhalla-pbf.js';
import descriptor from '../src/valhalla-proto-3.8.2.json' with { type: 'json' };
import before from './fixtures/valhalla/request-before-closures.json' with { type: 'json' };
import local382 from './fixtures/valhalla/calgary-deerfoot-glenmore-local382.json' with { type: 'json' };
import legacy from './fixtures/valhalla/calgary-legacy-osrm.json' with { type: 'json' };

const ApiType = protobuf.Root.fromJSON(descriptor.schema).lookupType('valhalla.Api');
const request = RouteRequestV2Schema.parse(before.request);
const options: RouteProviderRequestOptions = {
  excludeLocations: [
    {
      lat: 51.09237,
      lon: -114.2139,
      heading: 130,
      heading_tolerance: 5,
      minimum_reachability: 0,
      node_snap_tolerance: 0,
      radius: 0,
      search_cutoff: 1,
    },
  ],
  excludePolygons: [
    [
      [-114.214, 51.092],
      [-114.213, 51.092],
      [-114.213, 51.093],
      [-114.214, 51.092],
    ],
  ],
};
const fixtureBytes = ApiType.encode(
  ApiType.fromObject(local382.response),
).finish() as Uint8Array<ArrayBuffer>;

describe('server-only Valhalla exclusion options', () => {
  it('keeps a request without exclusions byte-identical to the captured origin/main encoder', () => {
    expect(Buffer.from(buildValhallaPbfRequest(request)).toString('base64')).toBe(
      before.requestBase64,
    );
    expect(Buffer.from(buildValhallaPbfRequest(request, {})).toString('base64')).toBe(
      before.requestBase64,
    );
  });

  it('retains directed locations, explicit zero tolerances and longitude-first polygons on the wire', () => {
    const sent = ApiType.toObject(ApiType.decode(buildValhallaPbfRequest(request, options)));
    expect(sent).toHaveProperty('options.excludeLocations', [
      {
        ll: { lat: 51.09237, lng: -114.2139 },
        heading: 130,
        headingTolerance: 5,
        minimumReachability: 0,
        nodeSnapTolerance: 0,
        radius: 0,
        searchCutoff: 1,
      },
    ]);
    expect(sent).toHaveProperty('options.excludePolygons.0.coords', [
      { lng: -114.214, lat: 51.092 },
      { lng: -114.213, lat: 51.092 },
      { lng: -114.213, lat: 51.093 },
      { lng: -114.214, lat: 51.092 },
    ]);
    expect(sent).toHaveProperty('options.locations.0.heading', 0);
    expect(sent).toHaveProperty('options.locations.1.type', 1);
    expect(sent).toHaveProperty('options.pbfFieldSelector', {
      directions: true,
      options: false,
      trip: true,
    });
  });

  it('carries exactly the same exclusions into the one permitted legacy decode fallback', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) =>
      Promise.resolve(
        new Response(
          typeof init?.body === 'string' ? JSON.stringify(legacy.response) : new Uint8Array([255]),
        ),
      ),
    );
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    const routes = await provider.getEnrichedRoutes?.(request, options);
    expect(routes?.length).toBeGreaterThan(0);
    expect(provider.isEnrichmentDegraded?.()).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const fallback = JSON.parse(
      fixtureValue(fixtureValue(fetchImplementation.mock.calls[1])[1]).body as string,
    ) as Record<string, unknown>;
    expect(fallback.exclude_locations).toEqual(options.excludeLocations);
    expect(fallback.exclude_polygons).toEqual(options.excludePolygons);
  });

  it('does not add a legacy retry after an excluded upstream transport failure', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.reject(new Error('offline')));
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    await expect(provider.getEnrichedRoutes?.(request, options)).rejects.toBeInstanceOf(
      RouteProviderError,
    );
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('preserves exclusions and a caller deadline in an otherwise successful enriched request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(fixtureBytes)),
    );
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    const controller = new AbortController();
    const routes = await provider.getEnrichedRoutes?.(request, {
      ...options,
      signal: controller.signal,
    });
    expect(routes?.length).toBeGreaterThan(0);
    const init = fixtureValue(fixtureValue(fetchImplementation.mock.calls[0])[1]);
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
    const sent = ApiType.toObject(ApiType.decode(init.body as Uint8Array));
    expect(sent).toHaveProperty('options.excludeLocations.0.ll.lng', -114.2139);
  });

  it('matches public closure geometry only against the same self-hosted graph, without redirects', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify([]))),
    );
    const provider = createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    });
    await provider.getClosureGraph?.('locate', { locations: options.excludeLocations });
    expect(String(fixtureValue(fetchImplementation.mock.calls[0])[0])).toBe(
      'http://valhalla.test/locate',
    );
    expect(fixtureValue(fixtureValue(fetchImplementation.mock.calls[0])[1]).redirect).toBe('error');
    expect(createValhallaRouteProvider().getClosureGraph).toBeUndefined();
  });
});
