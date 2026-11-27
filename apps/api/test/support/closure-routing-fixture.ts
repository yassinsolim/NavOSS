import { isDeepStrictEqual } from 'node:util';

import {
  RouteAlternativeSchema,
  RouteAlternativeV2Schema,
  RouteRequestV2Schema,
} from '@navoss/contracts';
import protobuf from 'protobufjs/light.js';
import { vi } from 'vitest';
import { z } from 'zod/v4';

import { createCalgaryConstructionRoadEventFeed } from '../../src/calgary-province-road-event-feed.js';
import { createDriveBcProvinceRoadEventFeed } from '../../src/drivebc-province-road-event-feed.js';
import { createProvincialRoadEventService } from '../../src/provincial-road-events.js';
import { createValhallaRouteProvider } from '../../src/route-provider.js';
import descriptor from '../../src/valhalla-proto-3.8.2.json' with { type: 'json' };
import official from '../fixtures/road-events/official-closures-2026-11-27.json' with { type: 'json' };
import recorded from '../fixtures/valhalla/official-closures-local382.json' with { type: 'json' };

const ApiType = protobuf.Root.fromJSON(descriptor.schema).lookupType('valhalla.Api');
const RecordedRequestSchema = z.object({
  action: z.enum(['route', 'locate', 'trace_attributes']),
  request: z.json(),
  status: z.number().int(),
});
export const ClosureRecordSchema = z.discriminatedUnion('encoding', [
  RecordedRequestSchema.extend({ encoding: z.literal('json'), response: z.json() }),
  RecordedRequestSchema.extend({ encoding: z.literal('pbf'), responseBase64: z.string() }),
]);
export type ClosureRecord = z.infer<typeof ClosureRecordSchema>;
const PlacementEventSchema = z.object({
  key: z.string(),
  sourceId: z.literal('calgary-construction-detours'),
  direction: z.literal('both'),
  roadNames: z.array(z.string()),
  geometryType: z.literal('point'),
  geometry: z.array(z.tuple([z.number(), z.number()])),
});
const PlacedClosureSchema = z.object({
  verifiedLine: z.boolean(),
  barriers: z.array(
    z.object({
      point: z.tuple([z.number(), z.number()]),
      headings: z.array(z.number()),
      exclusion: z.object({
        lat: z.number(),
        lon: z.number(),
        heading: z.number().optional(),
        heading_tolerance: z.number().optional(),
        radius: z.number().optional(),
        minimum_reachability: z.number().optional(),
        node_snap_tolerance: z.number().optional(),
        search_cutoff: z.number().optional(),
      }),
      fingerprint: z.object({ way_id: z.number(), shape: z.string(), names: z.array(z.string()) }),
    }),
  ),
});
const RecordedRoutePairSchema = z.object({
  request: RouteRequestV2Schema,
  before: z.array(RouteAlternativeV2Schema),
  after: z.array(RouteAlternativeV2Schema),
});
const PointSourceRowSchema = z
  .object({
    geography: z.object({
      type: z.literal('Point'),
      coordinates: z.tuple([z.number(), z.number()]),
    }),
    roads: z.array(
      z
        .object({
          name: z.string().optional(),
          from: z.string().optional(),
          direction: z.string().optional(),
          state: z.string().optional(),
        })
        .loose(),
    ),
  })
  .loose();
const FixtureSchema = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      now: z.number(),
      request: RouteRequestV2Schema,
      before: z.array(RouteAlternativeV2Schema),
      legacy: z.array(RouteAlternativeSchema),
      after: z.array(RouteAlternativeV2Schema),
      records: z.tuple([z.number(), z.number()]),
    }),
  ),
  mismatch: z.object({ event: PlacementEventSchema, result: z.string() }),
  boundaries: z.object({
    direction: z.object({
      event: PlacementEventSchema.extend({ direction: z.literal('east') }),
      placed: PlacedClosureSchema,
      routes: z.array(RecordedRoutePairSchema),
    }),
    endpoints: z.object({
      now: z.number(),
      cases: z.array(RecordedRoutePairSchema.extend({ name: z.string() })),
    }),
    pointOnly: RecordedRoutePairSchema.extend({ now: z.number(), row: PointSourceRowSchema }),
    cutSet: z.object({ status: z.number(), response: z.unknown() }),
  }),
  records: z.array(ClosureRecordSchema),
});
export const closureFixture = FixtureSchema.parse(recorded);
const RequestOptionsSchema = z
  .object({
    options: z
      .object({
        excludeLocations: z.array(z.unknown()).optional(),
        excludePolygons: z.array(z.unknown()).optional(),
      })
      .loose(),
  })
  .loose();
interface ReplayOptions {
  records?: readonly ClosureRecord[];
  failure?: 'http' | 'no-route' | 'ignored' | 'timeout';
}

export function recordedClosureProvider(options: ReplayOptions = {}) {
  const records = options.records ?? closureFixture.records;
  const calls: { action: string; request: unknown; excluded: boolean }[] = [];
  const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
    const url =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const action = url.pathname.slice(1);
    if (init === undefined) throw new Error('Missing recorded request options.');
    const body = init.body;
    const binary = body instanceof Uint8Array;
    if (!binary && typeof body !== 'string') throw new Error('Missing recorded request body.');
    const request: unknown = binary
      ? ApiType.toObject(ApiType.decode(body), { longs: Number })
      : JSON.parse(body);
    const parsedOptions = binary ? RequestOptionsSchema.parse(request).options : undefined;
    const excluded =
      (parsedOptions?.excludeLocations?.length ?? 0) > 0 ||
      (parsedOptions?.excludePolygons?.length ?? 0) > 0;
    calls.push({ action, request, excluded });
    if (excluded && options.failure === 'http')
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    if (excluded && options.failure === 'no-route') {
      const bytes = ApiType.encode(
        ApiType.fromObject({ info: { errors: [{ code: 442 }] } }),
      ).finish() as Uint8Array<ArrayBuffer>;
      return Promise.resolve(new Response(bytes, { status: 400 }));
    }
    if (excluded && options.failure === 'timeout') {
      const { promise, reject } = Promise.withResolvers<Response>();
      const signal = init.signal;
      if (signal === undefined || signal === null)
        throw new Error('Expected the closure deadline.');
      const abort = () => {
        reject(new Error('Aborted recorded provider request.'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return promise;
    }
    let matchingRequest = request;
    if (excluded && options.failure === 'ignored') {
      const parsed = RequestOptionsSchema.parse(request);
      const ordinary = { ...parsed.options };
      delete ordinary.excludeLocations;
      delete ordinary.excludePolygons;
      matchingRequest = { ...parsed, options: ordinary };
    }
    const record = records.find(
      (candidate) =>
        candidate.action === action &&
        candidate.encoding === (binary ? 'pbf' : 'json') &&
        isDeepStrictEqual(candidate.request, matchingRequest),
    );
    if (record === undefined) throw new Error('Unrecorded public graph request.');
    if (record.encoding === 'pbf') {
      return Promise.resolve(
        new Response(Buffer.from(record.responseBase64, 'base64'), { status: record.status }),
      );
    }
    const json = JSON.stringify(record.response);
    return Promise.resolve(new Response(json, { status: record.status }));
  });
  return {
    provider: createValhallaRouteProvider({
      endpoint: 'http://valhalla.test/route',
      fetchImplementation,
    }),
    calls,
    fetchImplementation,
  };
}

interface SourceOptions {
  cityRows?: readonly unknown[];
  bcRows?: readonly unknown[];
}
export function recordedClosureSources(clock: () => number, options: SourceOptions = {}) {
  const cityFetch = vi.fn<typeof fetch>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          url.includes('/api/views/')
            ? { rowsUpdatedAt: official.calgaryConstruction.rowsUpdatedAt }
            : (options.cityRows ?? official.calgaryConstruction.rows),
        ),
      ),
    );
  });
  const bcFetch = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          events: options.bcRows ?? official.driveBc.rows,
        }),
      ),
    ),
  );
  const service = createProvincialRoadEventService(
    {
      alberta: [createCalgaryConstructionRoadEventFeed({ clock, fetchImplementation: cityFetch })],
      'british-columbia': [
        createDriveBcProvinceRoadEventFeed({ clock, fetchImplementation: bcFetch }),
      ],
      ontario: [],
    },
    clock,
  );
  return { service, cityFetch, bcFetch };
}
