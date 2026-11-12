import type { TrafficProbeBatchRequest } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  classifyCongestion,
  estimateSpeed,
  HISTOGRAM_BINS,
  speedBin,
  type FlowBucket,
} from '../src/traffic/aggregation.js';
import { contributorNetwork, createContributorTokens } from '../src/traffic/contributor.js';
import { decodePolyline6, haversineMeters, type Position } from '../src/traffic/geo.js';
import type { MatchedEdge } from '../src/traffic/map-matcher.js';
import { deriveObservations } from '../src/traffic/observations.js';
import { findProbeRejection, trimBatchEnds } from '../src/traffic/probe-validation.js';
import { annotateRouteTraffic } from '../src/traffic/route-traffic.js';
import { DEFAULT_TRAFFIC_SETTINGS, readTrafficSettings } from '../src/traffic/settings.js';
import { createInMemoryTrafficStore } from '../src/traffic/store.js';
import {
  CAPTURED_AT,
  DRIVE,
  driveBatch,
  FIXTURE_SETTINGS,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
} from './traffic-fixture.js';

const SETTINGS = DEFAULT_TRAFFIC_SETTINGS;
const NOW_MS = NOW.getTime();

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** A straight eastbound drive along 51°N: one fix every `stepMeters`, `gapSeconds` apart. */
function straightBatch(
  points: number,
  stepMeters: number,
  gapSeconds = 2,
): TrafficProbeBatchRequest {
  const degreesPerMeter = 1 / (111_195 * Math.cos((51 * Math.PI) / 180));
  return {
    capturedAt: CAPTURED_AT,
    points: Array.from({ length: points }, (_, index) => [
      -114 + index * stepMeters * degreesPerMeter,
      51,
      index * gapSeconds,
    ]),
    schemaVersion: 1,
  };
}

function bucket(bucketStartMs: number, speedsKph: number[]): FlowBucket {
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const speed of speedsKph) histogram[speedBin(speed)] = (histogram[speedBin(speed)] ?? 0) + 1;
  return { bucketStartMs, histogram, sampleCount: speedsKph.length };
}

describe('trip-end trimming on the server', () => {
  it('removes the first and last 100 m of every batch', () => {
    const batch = straightBatch(41, 25);
    const kept = trimBatchEnds(batch.points, 100);

    // 1,000 m of path: fixes at 100 m through 900 m survive.
    expect(kept).toHaveLength(33);
    expect(kept[0]?.offsetSeconds).toBe(8);
    expect(kept.at(-1)?.offsetSeconds).toBe(72);
    const first = present(batch.points[0]);
    const last = present(batch.points.at(-1));
    for (const { position } of kept) {
      expect(haversineMeters([first[0], first[1]], position)).toBeGreaterThanOrEqual(99.9);
      expect(haversineMeters([last[0], last[1]], position)).toBeGreaterThanOrEqual(99.9);
    }
  });

  it('keeps nothing of a batch shorter than both exclusion zones', () => {
    expect(trimBatchEnds(straightBatch(10, 15).points, 100)).toEqual([]);
  });

  it('measures path distance, so a loop back to the start is still trimmed at both ends', () => {
    const out = straightBatch(21, 25).points;
    const back = out
      .slice(0, -1)
      .reverse()
      .map(([longitude, latitude], index): [number, number, number] => [
        longitude,
        latitude,
        42 + index * 2,
      ]);
    const kept = trimBatchEnds([...out, ...back], 100);
    const start = present(out[0]);

    expect(kept.length).toBeGreaterThan(0);
    for (const { position } of kept) {
      expect(haversineMeters([start[0], start[1]], position)).toBeGreaterThanOrEqual(99.9);
    }
  });
});

describe('probe plausibility', () => {
  const bounds = { east: -109.9, north: 60.1, south: 48.2, west: -139.1 };
  const limits = { ...SETTINGS, bounds };

  it('accepts a recent drive at road speed inside coverage', () => {
    expect(findProbeRejection(straightBatch(30, 30), NOW_MS, limits)).toBeUndefined();
  });

  it('rejects a teleporting trace', () => {
    expect(findProbeRejection(straightBatch(30, 150), NOW_MS, limits)).toBe('implausible_speed');
  });

  it('rejects a batch outside Alberta and British Columbia', () => {
    expect(findProbeRejection(driveBatch(), NOW_MS, limits)).toBe('outside_coverage');
  });

  it('rejects batches too old to describe current traffic or dated in the future', () => {
    const batch = straightBatch(30, 30);
    expect(findProbeRejection(batch, NOW_MS + 20 * 60_000, limits)).toBe('stale');
    expect(findProbeRejection(batch, NOW_MS - 10 * 60_000, limits)).toBe('future');
  });
});

describe('speed aggregation', () => {
  const bucketMs = SETTINGS.bucketSeconds * 1_000;
  const current = Math.floor(NOW_MS / bucketMs) * bucketMs;

  it('takes the median, so one crawling or speeding sample does not move the estimate', () => {
    const estimate = estimateSpeed([bucket(current, [48, 50, 51, 52, 6])], NOW_MS, SETTINGS);
    expect(estimate?.speedKph).toBe(51);
    expect(estimate?.sampleCount).toBe(5);
    expect(
      estimateSpeed([bucket(current, [48, 50, 51, 52, 170])], NOW_MS, SETTINGS)?.speedKph,
    ).toBe(51);
  });

  it('lets fresh samples outweigh a larger number of old ones', () => {
    const estimate = estimateSpeed(
      [bucket(current - 5 * bucketMs, [20, 20, 20]), bucket(current, [60, 60])],
      NOW_MS,
      SETTINGS,
    );
    expect(estimate?.speedKph).toBe(61);
  });

  it('ignores buckets older than the window and reports nothing when none remain', () => {
    const expired = bucket(NOW_MS - (SETTINGS.windowSeconds + 600) * 1_000, [20, 20, 20]);
    expect(estimateSpeed([expired, bucket(current, [60])], NOW_MS, SETTINGS)?.speedKph).toBe(61);
    expect(estimateSpeed([expired], NOW_MS, SETTINGS)).toBeUndefined();
  });

  it('reports freshness at bucket resolution and never in the future', () => {
    expect(estimateSpeed([bucket(current, [60])], NOW_MS, SETTINGS)?.observedAtMs).toBe(NOW_MS);
    expect(estimateSpeed([bucket(current - bucketMs, [60])], NOW_MS, SETTINGS)?.observedAtMs).toBe(
      current,
    );
  });
});

describe('congestion classification', () => {
  it.each([
    [80, 80, 'free'],
    [56, 80, 'free'],
    [55, 80, 'slow'],
    [36, 80, 'slow'],
    [35, 80, 'heavy'],
    [16, 80, 'heavy'],
    [15, 80, 'stopped'],
    [0, 80, 'stopped'],
    [95, 80, 'free'],
  ] as const)('%d km/h on an %d km/h road is %s', (speed, freeFlow, level) => {
    expect(classifyCongestion(speed, freeFlow, SETTINGS)).toBe(level);
  });
});

describe('contributor independence', () => {
  it('treats a phone rotating inside its IPv6 /64 as one contributor', () => {
    expect(contributorNetwork('2001:db8:12:3400:a1b2:c3d4:e5f6:1')).toBe(
      contributorNetwork('2001:db8:12:3400::99'),
    );
    expect(contributorNetwork('2001:db8:12:3400::1')).not.toBe(
      contributorNetwork('2001:db8:12:3401::1'),
    );
    expect(contributorNetwork('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('gives one driver unrelated tokens on different roads and a new process new tokens', () => {
    const tokens = createContributorTokens();
    expect(tokens.tokenFor('198.51.100.7', 'w1f')).toBe(tokens.tokenFor('198.51.100.7', 'w1f'));
    expect(tokens.tokenFor('198.51.100.7', 'w1f')).not.toBe(tokens.tokenFor('198.51.100.7', 'w2f'));
    expect(tokens.tokenFor('198.51.100.7', 'w1f')).not.toBe(tokens.tokenFor('198.51.100.8', 'w1f'));
    expect(createContributorTokens().tokenFor('198.51.100.7', 'w1f')).not.toBe(
      tokens.tokenFor('198.51.100.7', 'w1f'),
    );
  });
});

describe('publication threshold', () => {
  const observation = {
    bucketStartMs: Math.floor(NOW_MS / 300_000) * 300_000,
    forward: true,
    freeFlowKph: 80,
    lines: [
      [
        [-114.06, 51.05],
        [-114.05, 51.05],
      ] satisfies Position[],
    ],
    roadClass: 'motorway',
    segmentKey: 'w1f',
    speedBin: speedBin(40),
    wayId: 1,
  };
  const rule = { minimumContributors: 3, windowStartMs: NOW_MS - 1_800_000 };
  const bounds = { east: -114, north: 51.1, south: 51, west: -114.1 };

  it('publishes a segment only once three independent contributors have driven it', async () => {
    const store = createInMemoryTrafficStore();
    await store.record([observation], () => 'a');
    await store.record([observation], () => 'b');
    expect((await store.publishedInBounds(bounds, rule, 10)).segments).toEqual([]);
    expect(await store.publishedByKeys(['w1f'], rule)).toEqual([]);
    expect(await store.counts(rule)).toEqual({
      observedSegments: 1,
      publishedSegments: 0,
      samples: 2,
    });

    await store.record([observation], () => 'c');
    expect((await store.publishedInBounds(bounds, rule, 10)).segments).toHaveLength(1);
    expect(await store.counts(rule)).toMatchObject({ publishedSegments: 1, samples: 3 });
  });

  it('does not let one contributor reach the threshold by uploading repeatedly', async () => {
    const store = createInMemoryTrafficStore();
    for (let upload = 0; upload < 6; upload += 1) {
      await store.record(
        [{ ...observation, bucketStartMs: observation.bucketStartMs - (upload % 3) * 300_000 }],
        () => 'a',
      );
    }
    await store.record([observation], () => 'b');

    expect((await store.publishedInBounds(bounds, rule, 10)).segments).toEqual([]);
    expect((await store.counts(rule)).samples).toBe(4);
  });

  it('withholds a segment whose road geometry is not yet known', async () => {
    const store = createInMemoryTrafficStore();
    for (const token of ['a', 'b', 'c']) {
      await store.record([{ ...observation, lines: [] }], () => token);
    }
    expect(await store.publishedByKeys(['w1f'], rule)).toEqual([]);
  });

  it('unpublishes when contributors age out of the window, then forgets the segment', async () => {
    const store = createInMemoryTrafficStore();
    await store.record(
      [{ ...observation, bucketStartMs: observation.bucketStartMs - 1_500_000 }],
      () => 'a',
    );
    await store.record([observation], () => 'b');
    await store.record([observation], () => 'c');
    expect(await store.publishedByKeys(['w1f'], rule)).toHaveLength(1);

    const later = { ...rule, windowStartMs: rule.windowStartMs + 600_000 };
    expect(await store.publishedByKeys(['w1f'], later)).toEqual([]);

    await store.expire(NOW_MS + 3_600_000);
    expect(await store.counts({ ...rule, windowStartMs: 0 })).toEqual({
      observedSegments: 0,
      publishedSegments: 0,
      samples: 0,
    });
  });

  it('never allows a threshold of one', () => {
    expect(() => readTrafficSettings({ COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS: '1' })).toThrow();
    expect(readTrafficSettings({}).mode).toBe('off');
    expect(readTrafficSettings({ COMMUNITY_TRAFFIC_MODE: '' }).mode).toBe('off');
  });
});

describe('observations from a map-matched drive', () => {
  async function observe(gaps?: readonly number[]) {
    const batch = driveBatch(gaps);
    const points = trimBatchEnds(batch.points, FIXTURE_SETTINGS.batchTrimMeters);
    const matched = await stubbedMatcher().matcher.matchTrace(points);
    if (matched === undefined) throw new Error('fixture did not match');
    return {
      matched,
      observations: deriveObservations(matched, points, Date.parse(CAPTURED_AT), FIXTURE_SETTINGS),
      points,
    };
  }

  it('yields one sample per road segment at the speed that was driven', async () => {
    const { observations } = await observe();

    expect(observations.length).toBeGreaterThan(3);
    expect(new Set(observations.map(({ segmentKey }) => segmentKey)).size).toBe(
      observations.length,
    );
    for (const observation of observations) {
      expect(observation.segmentKey).toMatch(/^w\d+[fb]$/);
      expect(observation.roadClass).toBe('primary');
      // 22 m every 2 s is 39.6 km/h; the off-road nudge and snapping move it a little.
      expect(observation.speedBin * 2).toBeGreaterThanOrEqual(34);
      expect(observation.speedBin * 2).toBeLessThanOrEqual(44);
      expect(observation.bucketStartMs).toBe(Date.parse('2026-11-12T17:55:00Z'));
    }
  });

  it('sees the crawl only on the segments where it happened', async () => {
    const steady = (await observe()).observations;
    const jammed = (await observe(JAMMED_GAPS)).observations;
    const slowed = jammed.filter(({ speedBin: bin }) => bin * 2 < 25);

    expect(slowed.length).toBeGreaterThan(0);
    expect(slowed.length).toBeLessThan(jammed.length);
    expect(jammed.map(({ segmentKey }) => segmentKey)).toEqual(
      steady.map(({ segmentKey }) => segmentKey),
    );
  });

  it('stores only whole-edge road geometry, never the ends of the drive or an uploaded fix', async () => {
    const { matched, observations, points } = await observe();
    const roadVertices = new Set(matched.shape.map((vertex) => vertex.join(',')));
    const uploaded = new Set(points.map(({ position }) => position.join(',')));
    const firstEdge = present(matched.edges[0]);
    const lastEdge = present(matched.edges.at(-1));
    const endVertices = new Set(
      [matched.shape[firstEdge.beginShapeIndex], matched.shape[lastEdge.endShapeIndex]].map(
        (vertex) => vertex?.join(','),
      ),
    );
    const stored = observations.flatMap(({ lines }) => lines.flat());

    expect(stored.length).toBeGreaterThan(10);
    for (const vertex of stored) {
      expect(roadVertices.has(vertex.join(','))).toBe(true);
      expect(uploaded.has(vertex.join(','))).toBe(false);
      expect(endVertices.has(vertex.join(','))).toBe(false);
    }
  });

  it('reports a jam for a vehicle that barely moves but not for two stationary fixes', () => {
    const edge: MatchedEdge = {
      beginShapeIndex: 0,
      endShapeIndex: 1,
      forward: true,
      fromFraction: 0,
      lengthMeters: 1_000,
      roadClass: 'motorway',
      speedKph: 100,
      toFraction: 1,
      use: 'road',
      wayId: 7,
    };
    const shape: Position[] = [
      [-114, 51],
      [-113.986, 51],
    ];
    const crawl = Array.from({ length: 8 }, (_, index) => ({
      matched: { edgeFraction: 0.4 + index * 0.005, edgeIndex: 0, startsNewPath: false },
      point: { offsetSeconds: index * 6, position: [-114, 51] satisfies Position },
    }));
    const derive = (entries: typeof crawl) =>
      deriveObservations(
        { edges: [edge], points: entries.map(({ matched }) => matched), shape },
        entries.map(({ point }) => point),
        Date.parse(CAPTURED_AT),
        SETTINGS,
      );

    // 35 m in 42 s is 3 km/h.
    expect(derive(crawl).map(({ speedBin: bin }) => bin)).toEqual([speedBin(3)]);
    expect(derive(crawl.slice(0, 2))).toEqual([]);
  });

  it('ignores residential streets, service roads and parking aisles', () => {
    const edge = (roadClass: string, use: string): MatchedEdge => ({
      beginShapeIndex: 0,
      endShapeIndex: 1,
      forward: true,
      fromFraction: 0,
      lengthMeters: 1_000,
      roadClass,
      speedKph: 40,
      toFraction: 1,
      use,
      wayId: 9,
    });
    const points = Array.from({ length: 10 }, (_, index) => ({
      offsetSeconds: index * 5,
      position: [-114, 51] satisfies Position,
    }));
    const derive = (roadClass: string, use: string) =>
      deriveObservations(
        {
          edges: [edge(roadClass, use)],
          points: points.map((_, index) => ({
            edgeFraction: index / 10,
            edgeIndex: 0,
            startsNewPath: false,
          })),
          shape: [
            [-114, 51],
            [-113.986, 51],
          ],
        },
        points,
        Date.parse(CAPTURED_AT),
        SETTINGS,
      );

    expect(derive('tertiary', 'road')).toHaveLength(1);
    expect(derive('residential', 'road')).toEqual([]);
    expect(derive('service_other', 'parking_aisle')).toEqual([]);
    expect(derive('primary', 'ferry')).toEqual([]);
  });
});

describe('route traffic annotation', () => {
  // Three 1 km edges at 60 km/h free flow: a 180 s route in two steps.
  const geometry: Position[] = [
    [-114, 51],
    [-113.9929, 51],
    [-113.9857, 51],
    [-113.9786, 51],
    [-113.9714, 51],
    [-113.9643, 51],
    [-113.9571, 51],
  ];
  const edges: MatchedEdge[] = [0, 1, 2].map((index) => ({
    beginShapeIndex: index * 2,
    endShapeIndex: index * 2 + 2,
    forward: true,
    fromFraction: 0,
    lengthMeters: 1_000,
    roadClass: index === 2 ? 'residential' : 'primary',
    speedKph: 60,
    toFraction: 1,
    use: 'road',
    wayId: 100 + index,
  }));
  const route = {
    durationSeconds: 180,
    geometry,
    steps: [
      { durationSeconds: 90, geometry: geometry.slice(0, 4) },
      { durationSeconds: 90, geometry: geometry.slice(3) },
      { durationSeconds: 0, geometry: [geometry[6], geometry[6]] as Position[] },
    ],
  };

  it('adds delay only where traffic is slower than the free-flow band', () => {
    const annotation = annotateRouteTraffic(
      route,
      edges,
      new Map([
        ['w100f', 58],
        ['w101f', 21],
      ]),
      SETTINGS,
    );

    // 1 km at 21 km/h takes 171.4 s; the edge of the free band, 42 km/h, takes 85.7 s.
    expect(annotation?.delaySeconds).toBeCloseTo(85.7, 1);
    expect(annotation?.typicalDurationSeconds).toBe(180);
    expect(annotation?.durationSeconds).toBeCloseTo(265.7, 1);
    expect(annotation?.observedFraction).toBe(0.67);
    expect(annotation?.congestion).toEqual([
      'free',
      'free',
      'heavy',
      'heavy',
      'unknown',
      'unknown',
    ]);
  });

  it('puts the delay on the steps that contain the congestion', () => {
    const annotation = annotateRouteTraffic(route, edges, new Map([['w101f', 21]]), {
      ...SETTINGS,
      routeMinCoverage: 0.3,
    });

    // The slow edge spans geometry segments 2 and 3: half in each step.
    expect(annotation?.stepDurationsSeconds[0]).toBeCloseTo(90 + 42.9, 0);
    expect(annotation?.stepDurationsSeconds[1]).toBeCloseTo(90 + 42.9, 0);
    expect(annotation?.stepDurationsSeconds[2]).toBe(0);
  });

  it('never makes a route faster than its typical duration', () => {
    const annotation = annotateRouteTraffic(
      route,
      edges,
      new Map([
        ['w100f', 95],
        ['w101f', 95],
      ]),
      SETTINGS,
    );
    expect(annotation?.delaySeconds).toBe(0);
    expect(annotation?.durationSeconds).toBe(180);
  });

  it('says traffic is unavailable when too little of the route is observed', () => {
    expect(annotateRouteTraffic(route, edges, new Map([['w100f', 20]]), SETTINGS)).toBeUndefined();
    expect(annotateRouteTraffic(route, edges, new Map(), SETTINGS)).toBeUndefined();
  });

  it('does not use a speed published for the opposite direction or a minor road', () => {
    expect(
      annotateRouteTraffic(
        route,
        edges,
        new Map([
          ['w100b', 10],
          ['w101b', 10],
          ['w102f', 10],
        ]),
        SETTINGS,
      ),
    ).toBeUndefined();
  });

  it('bounds the delay of a standstill instead of dividing by zero', () => {
    const annotation = annotateRouteTraffic(
      route,
      edges,
      new Map([
        ['w100f', 1],
        ['w101f', 60],
      ]),
      SETTINGS,
    );
    expect(annotation?.congestion[0]).toBe('stopped');
    expect(annotation?.delaySeconds).toBeCloseTo(1_200 - 85.7, 0);
  });
});

describe('Valhalla responses', () => {
  it('decodes six-decimal polylines', () => {
    expect(decodePolyline6('_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI')).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('resolves a route to edges addressed by the route geometry itself', async () => {
    const edges = await stubbedMatcher().matcher.walkRoute(DRIVE.route.geometry);

    expect(edges?.[0]?.beginShapeIndex).toBe(0);
    expect(edges?.at(-1)?.endShapeIndex).toBe(DRIVE.route.geometry.length - 1);
    const metres = edges?.reduce((sum, edge) => sum + edge.lengthMeters, 0) ?? 0;
    expect(Math.abs(metres - DRIVE.route.distanceMeters)).toBeLessThan(5);
  });

  it('treats an unmatched trace as no data and an outage as an error', async () => {
    const stub = stubbedMatcher();
    const points = trimBatchEnds(driveBatch().points, 100);

    stub.failNext(400);
    await expect(stub.matcher.matchTrace(points)).resolves.toBeUndefined();
    stub.failNext(502);
    await expect(stub.matcher.matchTrace(points)).rejects.toThrow('status 502');
    await expect(stub.matcher.matchTrace(points.slice(0, 20))).resolves.toBeUndefined();
  });
});
