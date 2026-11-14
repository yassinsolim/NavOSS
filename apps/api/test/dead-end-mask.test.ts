import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TrafficProbeBatchRequest } from '@navoss/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEAD_END_MASK_FORMAT,
  DEAD_END_MASK_FORMAT_VERSION,
  DeadEndMaskError,
  deadEndMaskPayloadDigest,
  encodeDeltas,
  parseDeadEndMask,
  type DeadEndMask,
  type DeadEndMaskFile,
  type DeadEndMaskWays,
} from '../src/traffic/dead-end-mask.js';
import type { Position } from '../src/traffic/geo.js';
import { createValhallaMapMatcher } from '../src/traffic/map-matcher.js';
import { trimBatchEnds } from '../src/traffic/probe-validation.js';
import { isAggregatedRoad } from '../src/traffic/segments.js';
import { loadConfiguredDeadEndMask } from '../src/traffic/settings.js';
import { requestUrl } from './traffic-fixture.js';

const GRAPH = 'a'.repeat(64);

function maskFile(
  ways: Partial<DeadEndMaskWays> = {},
  overrides: Partial<DeadEndMaskFile> = {},
): DeadEndMaskFile {
  const complete: DeadEndMaskWays = {
    eligible: encodeDeltas(ways.eligible ?? []),
    excluded: encodeDeltas(ways.excluded ?? []),
    unknown: encodeDeltas(ways.unknown ?? []),
    mixed: ways.mixed ?? [],
  };
  return {
    format: DEAD_END_MASK_FORMAT,
    formatVersion: DEAD_END_MASK_FORMAT_VERSION,
    graph: { dataDate: '2026-11-11', graphId: GRAPH, routingEngineVersion: '3.8.2' },
    inputs: {
      extractPolicyVersion: 1,
      osmTimestamp: '2026-11-11T21:22:47Z',
      pbf: 'alberta-british-columbia-261111.osm.pbf',
      pbfSha256: 'b'.repeat(64),
    },
    rules: {
      core: 'test',
      publishableClasses: ['secondary'],
      terminalClasses: ['secondary'],
      terminalMeters: 400,
    },
    summary: {},
    ways: complete,
    payloadSha256: deadEndMaskPayloadDigest(complete),
    ...overrides,
  };
}

/** Mixed-way entry from positions (degrees) and one status letter per interval. */
function mixedWay(wayId: number, positions: readonly Position[], letters: string) {
  const flat = positions.flatMap(([longitude, latitude]) => [
    Math.round(longitude * 1e6),
    Math.round(latitude * 1e6),
  ]);
  const deltas = flat.map((value, index) => (index < 2 ? value : value - (flat[index - 2] ?? 0)));
  return [wayId, letters, deltas] as [number, string, number[]];
}

const WAY: Position[] = [
  [-114.1, 51],
  [-114.099, 51],
  [-114.098, 51.0005],
  [-114.097, 51.0005],
  [-114.096, 51.001],
];

describe('dead-end mask', () => {
  it('answers uniform ways, and unknown for a way it does not list', () => {
    const mask = parseDeadEndMask(
      JSON.stringify(maskFile({ eligible: [5, 9], excluded: [7], unknown: [11] })),
      { graphId: GRAPH },
    );
    const line = WAY.slice(0, 2);
    expect(mask.status({ forward: true, wayId: 5 }, line)).toBe('eligible');
    expect(mask.status({ forward: false, wayId: 9 }, line)).toBe('eligible');
    expect(mask.status({ forward: true, wayId: 7 }, line)).toBe('excluded');
    expect(mask.status({ forward: true, wayId: 11 }, line)).toBe('unknown');
    expect(mask.status({ forward: true, wayId: 6 }, line)).toBe('unknown');
  });

  it('never publishes the excluded part of a way that crosses the boundary', () => {
    // Intervals 0-1 are on the main network; 2-3 lie past the single junction.
    const mask = parseDeadEndMask(
      JSON.stringify(maskFile({ mixed: [mixedWay(42, WAY, 'eexx')] })),
      { graphId: GRAPH },
    );
    const way = { forward: true, wayId: 42 };
    expect(mask.status(way, WAY.slice(0, 3))).toBe('eligible');
    expect(mask.status(way, WAY.slice(2))).toBe('excluded');
    // A graph edge spanning the boundary, in either direction, is refused.
    expect(mask.status(way, WAY.slice(1, 4))).toBe('excluded');
    expect(mask.status({ forward: false, wayId: 42 }, [...WAY].reverse())).toBe('excluded');
    expect(mask.status({ forward: false, wayId: 42 }, WAY.slice(0, 3).reverse())).toBe('eligible');
    // Valhalla rounds seven-decimal OSM nodes to six; one unit either way still matches.
    expect(
      mask.status(way, [
        [-114.100001, 51],
        [-114.098999, 51.000001],
      ]),
    ).toBe('eligible');
    // Geometry that is not this way's (another graph, a moved node) is unknown, not eligible.
    expect(
      mask.status(way, [
        [-114.1, 51],
        [-114.0995, 51],
      ]),
    ).toBe('unknown');
    // Driving direction matters for placing the edge: the forward line read backwards does not fit.
    expect(mask.status({ forward: false, wayId: 42 }, WAY.slice(0, 3))).toBe('unknown');
    expect(mask.status(way, WAY.slice(0, 1))).toBe('unknown');
  });

  it('takes the worst status where a way passes the same nodes twice', () => {
    const loop: Position[] = [...WAY.slice(0, 3), WAY[1] ?? [0, 0], WAY[0] ?? [0, 0]];
    const mask = parseDeadEndMask(
      JSON.stringify(maskFile({ mixed: [mixedWay(8, loop, 'eeex')] })),
      { graphId: GRAPH },
    );
    expect(mask.status({ forward: true, wayId: 8 }, [WAY[1] ?? [0, 0], WAY[0] ?? [0, 0]])).toBe(
      'excluded',
    );
  });

  it('refuses malformed, stale, other-version and other-graph masks', () => {
    const valid = maskFile({ eligible: [5] });
    const refuse = (text: string, message: RegExp, graphId = GRAPH) => {
      expect(() => parseDeadEndMask(text, { graphId })).toThrow(DeadEndMaskError);
      expect(() => parseDeadEndMask(text, { graphId })).toThrow(message);
    };
    refuse('{"format":', /not valid JSON/);
    refuse(JSON.stringify({ ...valid, format: 'something-else' }), /not a NavOSS/);
    refuse(JSON.stringify({ ...valid, formatVersion: 2 }), /format version 2/);
    refuse(
      JSON.stringify(valid),
      /built for graph a+, not the configured graph c+/,
      'c'.repeat(64),
    );
    // Edited content no longer matches the digest it was built with.
    refuse(
      JSON.stringify({ ...valid, ways: { ...valid.ways, eligible: [5, 1] } }),
      /does not match its digest/,
    );
    refuse(
      JSON.stringify({ ...valid, rules: { ...valid.rules, terminalMeters: 399 } }),
      /failed validation/,
    );
    refuse(JSON.stringify({ ...valid, extra: true }), /failed validation/);
    refuse(JSON.stringify(maskFile({ eligible: [5], excluded: [5] })), /lists a way twice/);
    refuse(JSON.stringify(maskFile({ eligible: [9, 5] })), /strictly ascending/);
    refuse(JSON.stringify(maskFile({ eligible: [5], mixed: [mixedWay(5, WAY, 'eexx')] })), /twice/);
    refuse(JSON.stringify(maskFile({ mixed: [mixedWay(3, WAY, 'eex')] })), /interval count/);
  });
});

describe('dead-end mask configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'navoss-dead-end-mask-'));
  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });
  const path = join(directory, 'mask.json');
  writeFileSync(path, JSON.stringify(maskFile({ eligible: [5] })));
  const stale = join(directory, 'stale.json');
  writeFileSync(stale, JSON.stringify(maskFile({ eligible: [5] }, { formatVersion: 0 as 1 })));

  it('is not read while traffic is off, even when misconfigured', () => {
    expect(
      loadConfiguredDeadEndMask('off', { COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: '/missing.json' }),
    ).toBeUndefined();
  });

  it('is optional for collection, which publishes nothing', () => {
    expect(loadConfiguredDeadEndMask('collect', {})).toBeUndefined();
    expect(
      loadConfiguredDeadEndMask('collect', {
        COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: path,
        COMMUNITY_TRAFFIC_GRAPH_ID: GRAPH,
      })?.identity.graphId,
    ).toBe(GRAPH);
    expect(() =>
      loadConfiguredDeadEndMask('collect', { COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: path }),
    ).toThrow(/requires COMMUNITY_TRAFFIC_GRAPH_ID/);
  });

  it('is required for live, with no permissive fallback', () => {
    expect(() => loadConfiguredDeadEndMask('live', {})).toThrow(/live requires/);
    expect(() =>
      loadConfiguredDeadEndMask('live', { COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: path }),
    ).toThrow(/live requires/);
    expect(() => loadConfiguredDeadEndMask('live', { COMMUNITY_TRAFFIC_GRAPH_ID: GRAPH })).toThrow(
      /live requires/,
    );
    expect(() =>
      loadConfiguredDeadEndMask('live', {
        COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: join(directory, 'missing.json'),
        COMMUNITY_TRAFFIC_GRAPH_ID: GRAPH,
      }),
    ).toThrow(/could not be read/);
    expect(() =>
      loadConfiguredDeadEndMask('live', {
        COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: stale,
        COMMUNITY_TRAFFIC_GRAPH_ID: GRAPH,
      }),
    ).toThrow(/format version 0/);
    expect(() =>
      loadConfiguredDeadEndMask('live', {
        COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: path,
        COMMUNITY_TRAFFIC_GRAPH_ID: 'c'.repeat(64),
      }),
    ).toThrow(/not the configured graph/);
    expect(() =>
      loadConfiguredDeadEndMask('live', {
        COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: path,
        COMMUNITY_TRAFFIC_GRAPH_ID: 'graph-2026',
      }),
    ).toThrow(/64-hex/);
    expect(
      loadConfiguredDeadEndMask('live', {
        COMMUNITY_TRAFFIC_DEAD_END_MASK_PATH: path,
        COMMUNITY_TRAFFIC_GRAPH_ID: GRAPH,
      })?.identity,
    ).toMatchObject({ formatVersion: 1, graphId: GRAPH });
  });
});

describe('dead-end mask in the matcher', () => {
  // A batch recorded from Valhalla 3.8.2 on the Alberta/BC graph (whole and partly matched edges).
  const crawl = JSON.parse(
    readFileSync(new URL('./fixtures/valhalla-crawl-calgary.json', import.meta.url), 'utf8'),
  ) as {
    locateResponse: unknown;
    points: TrafficProbeBatchRequest['points'];
    traceResponse: unknown;
  };
  const points = trimBatchEnds(crawl.points, 100);
  const locateBodies: string[] = [];
  const matcher = (deadEndMask?: DeadEndMask) =>
    createValhallaMapMatcher({
      ...(deadEndMask === undefined ? {} : { deadEndMask }),
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (input, init) => {
        if (requestUrl(input).endsWith('/locate'))
          locateBodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate') ? crawl.locateResponse : crawl.traceResponse,
          ),
        );
      },
    });

  it('publishes an edge only when the mask places its whole map geometry on the main network', async () => {
    const plain = await matcher().matchTrace(points);
    const open = (plain?.edges ?? []).filter((edge) => edge.openThroughRoad === true);
    const whole = open.find((edge) => edge.segmentKey !== undefined);
    const partial = open.find((edge) => edge.wholeEdge !== undefined);
    expect(whole).toBeDefined();
    expect(partial).toBeDefined();
    if (whole === undefined || partial === undefined) return;
    const otherWays = [...new Set(open.map((edge) => edge.wayId))].filter(
      (wayId) => wayId !== whole.wayId && wayId !== partial.wayId,
    );
    const statuses = async (ways: Partial<DeadEndMaskWays>) => {
      const mask = parseDeadEndMask(JSON.stringify(maskFile(ways)), { graphId: GRAPH });
      const matched = await matcher(mask).matchTrace(points);
      return (matched?.edges ?? []).filter((edge) => isAggregatedRoad(edge));
    };
    const sorted = (values: number[]) => [...values].sort((left, right) => left - right);
    // Everything on the main network: the mask changes nothing.
    const allEligible = await statuses({
      eligible: sorted([whole.wayId, partial.wayId, ...otherWays]),
    });
    expect(allEligible.filter((edge) => edge.openThroughRoad === true)).toHaveLength(open.length);

    // The whole edge's way excluded; the partly matched edge's way crosses the boundary just
    // after its whole edge, so its whole geometry decides.
    const partialLine = partial.wholeEdge?.line ?? partial.line;
    const forwardLine = partial.forward ? partialLine : [...partialLine].reverse();
    const extended: Position[] = [...forwardLine, [forwardLine.at(-1)?.[0] ?? 0, 51.5]];
    const crossing = await statuses({
      eligible: sorted(otherWays),
      excluded: [whole.wayId],
      mixed: [mixedWay(partial.wayId, extended, `${'e'.repeat(forwardLine.length - 1)}x`)],
    });
    for (const edge of crossing) {
      if (edge.wayId === whole.wayId) expect(edge.openThroughRoad).toBe(false);
      if (edge.wayId === partial.wayId && edge.wholeEdge !== undefined) {
        expect(edge.openThroughRoad).toBe(true);
      }
    }
    const inside = await statuses({
      eligible: sorted(otherWays),
      excluded: [whole.wayId],
      mixed: [mixedWay(partial.wayId, extended, `x${'e'.repeat(forwardLine.length - 1)}`)],
    });
    expect(
      inside.find((edge) => edge.wayId === partial.wayId && edge.wholeEdge)?.openThroughRoad,
    ).toBe(false);
    // A way the mask does not list is never published.
    const unlisted = await statuses({ eligible: sorted(otherWays) });
    expect(
      unlisted.filter((edge) => edge.openThroughRoad === true).map((edge) => edge.wayId),
    ).not.toContain(whole.wayId);
    // The mask adds no request content: `/locate` carries the same map midpoints with or without it.
    expect(new Set(locateBodies).size).toBe(1);
  });
});
