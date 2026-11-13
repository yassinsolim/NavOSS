import type { TrafficProbeBatchRequest } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import { createTrafficCohorts, type TrafficCohorts } from '../src/traffic/cohorts.js';
import { createTrafficCredentials } from '../src/traffic/credentials.js';
import { decodePolyline6, haversineMeters, type Position } from '../src/traffic/geo.js';
import {
  createValhallaMapMatcher,
  type MatchedEdge,
  type MatchedTrace,
} from '../src/traffic/map-matcher.js';
import { deriveObservations, type SegmentObservation } from '../src/traffic/observations.js';
import { findProbeRejection, trimBatchEnds } from '../src/traffic/probe-validation.js';
import {
  annotateRouteTraffic,
  minorRoadMeters,
  rankWithTraffic,
  type RankableRoute,
} from '../src/traffic/route-traffic.js';
import { classifyCongestion, edgeSegmentKey } from '../src/traffic/segments.js';
import { createTrafficService, isLocalMatcherEndpoint } from '../src/traffic/service.js';
import { DEFAULT_TRAFFIC_SETTINGS, readTrafficSettings } from '../src/traffic/settings.js';
import {
  CAPTURED_AT,
  DRIVE,
  driveBatch,
  FIXTURE_SETTINGS,
  isFixtureTrafficCoordinate,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
} from './traffic-fixture.js';

const SETTINGS = DEFAULT_TRAFFIC_SETTINGS;
const NOW_MS = NOW.getTime();
const EPOCH_MS = SETTINGS.epochSeconds * 1_000;
/** Start of the epoch `NOW` falls in, and the boundary that closes it. */
const EPOCH_START = Math.floor(NOW_MS / EPOCH_MS) * EPOCH_MS;
const NEXT_TICK = EPOCH_START + EPOCH_MS;
const CREDENTIAL = 'c'.repeat(64);

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** A straight eastbound drive along 51°N: one fix every `stepMeters`, `gapSeconds` apart. */
function straightBatch(
  points: number,
  stepMeters: number,
  gapSeconds = 2,
  capturedAt = CAPTURED_AT,
): TrafficProbeBatchRequest {
  const degreesPerMeter = 1 / (111_195 * Math.cos((51 * Math.PI) / 180));
  return {
    capturedAt,
    credential: CREDENTIAL,
    points: Array.from({ length: points }, (_, index) => [
      -114 + index * stepMeters * degreesPerMeter,
      51,
      index * gapSeconds,
    ]),
    schemaVersion: 1,
  };
}

/** A whole 1 km edge of way 7 starting `index` km east of -114°. */
function edge(index: number, overrides: Partial<MatchedEdge> = {}): MatchedEdge {
  const line: Position[] = [
    [-114 + index * 0.0143, 51],
    [-114 + (index + 1) * 0.0143, 51],
  ];
  const base = {
    beginShapeIndex: index,
    endShapeIndex: index + 1,
    forward: true,
    fromFraction: 0,
    lengthMeters: 1_000,
    line,
    roadClass: 'primary',
    speedKph: 60,
    toFraction: 1,
    use: 'road',
    wayId: 7,
    ...overrides,
  };
  return base.fromFraction === 0 && base.toFraction === 1
    ? { ...base, segmentKey: edgeSegmentKey(base, base.line) }
    : base;
}

/**
 * A drive at `speedKph` across `edges`, one fix every five seconds, starting 30% into the first
 * edge and stopping 70% into the last, so only the edges in between are driven end to end.
 */
function driveAcross(
  edges: MatchedEdge[],
  speedKph: number,
): { matched: MatchedTrace; points: { offsetSeconds: number; position: Position }[] } {
  const matched: MatchedTrace = { edges, points: [] };
  const points: { offsetSeconds: number; position: Position }[] = [];
  const metersPerFix = (speedKph / 3.6) * 5;
  const endMeters = (edges.length - 0.3) * 1_000;
  for (let meters = 300, fix = 0; meters <= endMeters; meters += metersPerFix, fix += 1) {
    const edgeIndex = Math.min(edges.length - 1, Math.floor(meters / 1_000));
    matched.points.push({
      edgeFraction: meters / 1_000 - edgeIndex,
      edgeIndex,
      startsNewPath: false,
    });
    points.push({ offsetSeconds: fix * 5, position: [-114, 51] });
  }
  return { matched, points };
}

function observe(edges: MatchedEdge[], speedKph: number): SegmentObservation[] {
  const { matched, points } = driveAcross(edges, speedKph);
  return deriveObservations(matched, points, SETTINGS);
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
    expect(findProbeRejection(driveBatch(CREDENTIAL), NOW_MS, limits)).toBe('outside_coverage');
  });

  it('rejects batches too old to describe current traffic or dated in the future', () => {
    const batch = straightBatch(30, 30);
    expect(findProbeRejection(batch, NOW_MS + 20 * 60_000, limits)).toBe('stale');
    expect(findProbeRejection(batch, NOW_MS - 10 * 60_000, limits)).toBe('future');
  });

  it('judges the last point, so offsets cannot carry an in-skew start time into the future', () => {
    // Starts 30 s ahead of the server clock, which the skew allowance alone would let through,
    // but its last point is 290 s later still.
    const batch = straightBatch(30, 30, 10, '2026-11-12T18:01:00Z');
    expect(present(batch.points.at(-1))[2]).toBe(290);
    expect(findProbeRejection(batch, NOW_MS, limits)).toBe('future');
    expect(
      findProbeRejection(straightBatch(30, 30, 2, '2026-11-12T18:00:00Z'), NOW_MS, limits),
    ).toBeUndefined();
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

describe('upload credentials', () => {
  const credentials = createTrafficCredentials(7_200);

  it('gives one installation the same per-segment tag under every credential it holds', () => {
    const first = credentials.issue('installation-a', NOW_MS);
    const second = credentials.issue('installation-a', NOW_MS + 3_600_000);
    const firstSeed = present(credentials.open(first.credential, NOW_MS + 1));
    const secondSeed = present(credentials.open(second.credential, NOW_MS + 3_600_001));

    // Two credentials of one installation are different strings but the same contributor.
    expect(first.credential).not.toBe(second.credential);
    expect(credentials.tagFor(firstSeed, 'w1f-000000000000')).toBe(
      credentials.tagFor(secondSeed, 'w1f-000000000000'),
    );
  });

  it('gives unrelated tags to different installations and to one installation on two roads', () => {
    const a = present(
      credentials.open(credentials.issue('installation-a', NOW_MS).credential, NOW_MS),
    );
    const b = present(
      credentials.open(credentials.issue('installation-b', NOW_MS).credential, NOW_MS),
    );

    expect(credentials.tagFor(a, 'w1f-000000000000')).not.toBe(
      credentials.tagFor(b, 'w1f-000000000000'),
    );
    expect(credentials.tagFor(a, 'w1f-000000000000')).not.toBe(
      credentials.tagFor(a, 'w2f-000000000000'),
    );
  });

  it('carries nothing readable about the installation', () => {
    const installationId = '0b6f2d7e-5a57-4d0a-9b53-3f1f0f6c9a11';
    const { credential } = credentials.issue(installationId, NOW_MS);
    const bytes = Buffer.from(credential, 'base64url');
    const seed = present(credentials.open(credential, NOW_MS));

    expect(bytes.includes(Buffer.from(installationId))).toBe(false);
    expect(bytes.includes(Buffer.from(installationId.replaceAll('-', ''), 'hex'))).toBe(false);
    expect(
      seed.includes(Buffer.from(installationId.replaceAll('-', ''), 'hex').subarray(0, 4)),
    ).toBe(false);
  });

  it('refuses expired, altered and foreign credentials', () => {
    const { credential, expiresAtMs } = credentials.issue('installation-a', NOW_MS);
    const altered = `${credential.slice(0, -2)}${credential.endsWith('AA') ? 'BB' : 'AA'}`;

    expect(expiresAtMs).toBe(Math.floor(NOW_MS / 1_000) * 1_000 + 7_200_000);
    expect(credentials.open(credential, expiresAtMs - 1)).toBeDefined();
    expect(credentials.open(credential, expiresAtMs)).toBeUndefined();
    expect(credentials.open(altered, NOW_MS)).toBeUndefined();
    expect(credentials.open('x'.repeat(64), NOW_MS)).toBeUndefined();
    // Another process has another key: a restart invalidates every credential.
    expect(createTrafficCredentials(7_200).open(credential, NOW_MS)).toBeUndefined();
  });
});

describe('publication cohorts', () => {
  const sample = (speedKph: number, key = 'w1f-000000000000'): SegmentObservation => ({
    freeFlowKph: 80,
    line: [
      [-114.06, 51.05],
      [-114.05, 51.05],
    ],
    roadClass: 'motorway',
    segmentKey: key,
    speedKph,
  });
  const add = (cohorts: TrafficCohorts, contributor: string, speedKph: number, nowMs = NOW_MS) =>
    cohorts.add([sample(speedKph)], () => contributor, nowMs);

  it('releases a segment only once three contributors are in its cohort, at the boundary', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    add(cohorts, 'a', 40);
    add(cohorts, 'b', 44);
    expect(cohorts.closeEpoch(NEXT_TICK)).toEqual([]);
    expect(cohorts.pending()).toEqual({ samples: 2, segments: 1 });

    add(cohorts, 'c', 52, NEXT_TICK + 1_000);
    const releases = cohorts.closeEpoch(NEXT_TICK + EPOCH_MS);

    expect(releases).toEqual([
      {
        expiresAtMs: NEXT_TICK + EPOCH_MS + SETTINGS.releaseSeconds * 1_000,
        freeFlowKph: 80,
        line: sample(0).line,
        releasedAtMs: NEXT_TICK + EPOCH_MS,
        roadClass: 'motorway',
        segmentKey: 'w1f-000000000000',
        // The median, 44, rounded to 5 km/h.
        speedKph: 45,
      },
    ]);
    expect(cohorts.pending()).toEqual({ samples: 0, segments: 0 });
  });

  it('gives one contributor one weight however often and whenever it uploads', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    add(cohorts, 'honest-1', 80);
    add(cohorts, 'honest-2', 78);
    // The same slow trace replayed into four different epochs.
    let recorded = 0;
    for (let replay = 0; replay < 4; replay += 1) {
      recorded += add(cohorts, 'attacker', 8, NOW_MS - replay * EPOCH_MS);
    }
    const releases = cohorts.closeEpoch(NEXT_TICK);

    expect(recorded).toBe(1);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.speedKph).toBe(80);
  });

  it('does not let one contributor reach the threshold alone', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    for (let upload = 0; upload < 6; upload += 1) add(cohorts, 'a', 40, NOW_MS + upload * 1_000);
    add(cohorts, 'b', 40);

    expect(cohorts.closeEpoch(NEXT_TICK)).toEqual([]);
    expect(cohorts.pending().samples).toBe(2);
  });

  it('consumes a released cohort: the next change needs three contributions of its own', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    for (const contributor of ['a', 'b', 'c']) add(cohorts, contributor, 60);
    expect(cohorts.closeEpoch(NEXT_TICK)).toHaveLength(1);

    // One more driver, and then a second, change nothing that is published.
    add(cohorts, 'd', 10, NEXT_TICK + 1_000);
    expect(cohorts.closeEpoch(NEXT_TICK + EPOCH_MS)).toEqual([]);
    add(cohorts, 'e', 10, NEXT_TICK + EPOCH_MS + 1_000);
    expect(cohorts.closeEpoch(NEXT_TICK + 2 * EPOCH_MS)).toEqual([]);

    add(cohorts, 'a', 12, NEXT_TICK + 2 * EPOCH_MS + 1_000);
    const next = cohorts.closeEpoch(NEXT_TICK + 3 * EPOCH_MS);
    expect(next).toHaveLength(1);
    expect(next[0]?.speedKph).toBe(10);
    expect(next[0]?.releasedAtMs).toBe(NEXT_TICK + 3 * EPOCH_MS);
  });

  it('leaves a sample that arrived after the boundary for the next epoch', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    add(cohorts, 'a', 60);
    add(cohorts, 'b', 60);
    add(cohorts, 'c', 60, NEXT_TICK + 500);

    expect(cohorts.closeEpoch(NEXT_TICK)).toEqual([]);
    expect(cohorts.closeEpoch(NEXT_TICK + EPOCH_MS)).toHaveLength(1);
  });

  it('forgets an unpublished sample once it is older than the cohort lifetime', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    add(cohorts, 'a', 60);
    add(cohorts, 'b', 60);
    const lastUsefulTick = EPOCH_START + SETTINGS.cohortSeconds * 1_000;
    expect(cohorts.closeEpoch(lastUsefulTick)).toEqual([]);
    expect(cohorts.pending().samples).toBe(2);

    // A third contributor one epoch too late does not complete the cohort.
    add(cohorts, 'c', 60, lastUsefulTick + 1_000);
    expect(cohorts.closeEpoch(lastUsefulTick + EPOCH_MS)).toEqual([]);
    expect(cohorts.pending()).toEqual({ samples: 1, segments: 1 });
    expect(
      cohorts.closeEpoch(lastUsefulTick + EPOCH_MS + SETTINGS.cohortSeconds * 1_000 + EPOCH_MS),
    ).toEqual([]);
    expect(cohorts.pending()).toEqual({ samples: 0, segments: 0 });
  });

  it('counts the threshold for each drawn edge, not for the way as a whole', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    // Three drivers cover edges 1 and 2 of a way; a fourth alone continues over edges 3 to 5.
    const short = [0, 1, 2, 3].map((index) => edge(index));
    const long = [0, 1, 2, 3, 4, 5, 6].map((index) => edge(index));
    const shortKeys = [1, 2].map((index) => present(edge(index).segmentKey));

    expect(
      observe(short, 54)
        .map(({ segmentKey }) => segmentKey)
        .sort(),
    ).toEqual([...shortKeys].sort());
    cohorts.add(observe(short, 54), () => 'a', NOW_MS);
    cohorts.add(observe(short, 50), () => 'b', NOW_MS);
    cohorts.add(observe(long, 58), () => 'solo', NOW_MS);
    const releases = cohorts.closeEpoch(NEXT_TICK);

    expect(releases.map(({ segmentKey }) => segmentKey).sort()).toEqual([...shortKeys].sort());
    for (const release of releases) {
      // Each released line is exactly that edge's map geometry.
      expect(shortKeys).toContain(edgeSegmentKey({ forward: true, wayId: 7 }, release.line));
    }
    // The stretch only one driver used stays unpublished and unreleased.
    expect(cohorts.pending()).toEqual({ samples: 3, segments: 3 });
  });

  describe('geometry of a pending segment', () => {
    const planted: Position[] = [
      [-114.2, 51.3],
      [-114.1, 51.3],
    ];

    it('is not changed by later contributors that are counted', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      add(cohorts, 'a', 60);
      // Both later contributors count toward the threshold, and both carry another line. Nothing
      // after them restores the first one.
      expect(cohorts.add([{ ...sample(60), line: planted }], () => 'b', NOW_MS)).toBe(1);
      expect(cohorts.add([{ ...sample(60), line: planted }], () => 'c', NOW_MS)).toBe(1);

      expect(cohorts.closeEpoch(NEXT_TICK)[0]?.line).toEqual(sample(0).line);
    });

    it('is not changed by a repeat that is not counted', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      for (const contributor of ['a', 'b', 'c']) add(cohorts, contributor, 60);
      // The last thing to arrive is a de-duplicated repeat carrying another line.
      expect(cohorts.add([{ ...sample(60), line: planted }], () => 'a', NOW_MS)).toBe(0);

      expect(cohorts.closeEpoch(NEXT_TICK)[0]?.line).toEqual(sample(0).line);
    });
  });
});

describe('privacy limits', () => {
  it('cannot be configured below the published values', () => {
    expect(() => readTrafficSettings({ COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS: '1' })).toThrow();
    expect(() => readTrafficSettings({ COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS: '2' })).toThrow();
    expect(() => readTrafficSettings({ COMMUNITY_TRAFFIC_TRIP_TRIM_METERS: '200' })).toThrow();
    expect(
      readTrafficSettings({ COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS: '5' }).minimumContributors,
    ).toBe(5);
    expect(readTrafficSettings({}).mode).toBe('off');
    expect(readTrafficSettings({ COMMUNITY_TRAFFIC_MODE: '' }).mode).toBe('off');
  });

  it('has no setting for retention, batch trimming or road classes', () => {
    const settings = readTrafficSettings({
      COMMUNITY_TRAFFIC_BATCH_TRIM_METERS: '50',
      COMMUNITY_TRAFFIC_BUCKET_SECONDS: '900',
      COMMUNITY_TRAFFIC_HALF_LIFE_SECONDS: '3600',
      COMMUNITY_TRAFFIC_WINDOW_SECONDS: '7200',
    });

    expect(settings).toMatchObject({
      batchTrimMeters: 100,
      cohortSeconds: 900,
      epochSeconds: 300,
      releaseSeconds: 900,
    });
  });

  it.each([
    { minimumContributors: 2 },
    { batchTrimMeters: 50 },
    { tripEndTrimMeters: 200 },
    { epochSeconds: 60 },
    { cohortSeconds: 7_200 },
    { releaseSeconds: 1_800 },
  ])('refuses to build a service with %o', (weaker) => {
    expect(() =>
      createTrafficService({
        isInCoverage: isFixtureTrafficCoordinate,
        mapMatcher: stubbedMatcher().matcher,
        settings: { ...FIXTURE_SETTINGS, ...weaker },
      }),
    ).toThrow(/privacy limits/);
  });
});

describe('observations from a map-matched drive', () => {
  async function observeDrive(gaps?: readonly number[]) {
    const batch = driveBatch(CREDENTIAL, gaps);
    const points = trimBatchEnds(batch.points, FIXTURE_SETTINGS.batchTrimMeters);
    const matched = await stubbedMatcher().matcher.matchTrace(points);
    if (matched === undefined) throw new Error('fixture did not match');
    return { matched, observations: deriveObservations(matched, points, FIXTURE_SETTINGS), points };
  }

  it('yields one sample per road edge at the speed that was driven', async () => {
    const { observations } = await observeDrive();

    expect(observations.length).toBeGreaterThan(10);
    expect(new Set(observations.map(({ segmentKey }) => segmentKey)).size).toBe(
      observations.length,
    );
    for (const observation of observations) {
      expect(observation.segmentKey).toMatch(/^w\d+[fb]-[0-9a-f]{12}$/);
      expect(observation.roadClass).toBe('primary');
      expect(observation.freeFlowKph).toBe(51);
      // 22 m every 2 s is 39.6 km/h; the off-road nudge and snapping move it a little.
      expect(observation.speedKph).toBeGreaterThanOrEqual(34);
      expect(observation.speedKph).toBeLessThanOrEqual(46);
      // No time and no position of the upload: only these five fields exist.
      expect(Object.keys(observation).sort()).toEqual([
        'freeFlowKph',
        'line',
        'roadClass',
        'segmentKey',
        'speedKph',
      ]);
    }
  });

  it('sees the crawl only on the edges where it happened', async () => {
    const steady = (await observeDrive()).observations;
    const jammed = (await observeDrive(JAMMED_GAPS)).observations;
    const slowed = jammed.filter(({ speedKph }) => speedKph < 25);

    expect(slowed.length).toBeGreaterThan(0);
    expect(slowed.length).toBeLessThan(jammed.length);
    expect(jammed.map(({ segmentKey }) => segmentKey)).toEqual(
      steady.map(({ segmentKey }) => segmentKey),
    );
  });

  it('keeps only whole-edge road geometry, never the ends of the drive or an uploaded fix', async () => {
    const { matched, observations, points } = await observeDrive();
    const shape = decodePolyline6(DRIVE.traceResponse.shape);
    const roadVertices = new Set(shape.map((vertex) => vertex.join(',')));
    const uploaded = new Set(points.map(({ position }) => position.join(',')));
    const endVertices = new Set([shape[0], shape.at(-1)].map((vertex) => vertex?.join(',')));
    const kept = observations.flatMap(({ line }) => line);

    expect(kept.length).toBeGreaterThan(10);
    for (const vertex of kept) {
      expect(roadVertices.has(vertex.join(','))).toBe(true);
      expect(uploaded.has(vertex.join(','))).toBe(false);
      expect(endVertices.has(vertex.join(','))).toBe(false);
    }
    // The partly driven first and last edge have no key and are never observed.
    expect(matched.edges[0]?.segmentKey).toBeUndefined();
    expect(matched.edges.at(-1)?.segmentKey).toBeUndefined();
    for (const observation of observations) {
      expect(
        edgeSegmentKey(
          {
            forward: observation.segmentKey.includes('f-'),
            wayId: Number(/\d+/.exec(observation.segmentKey)?.[0]),
          },
          observation.line,
        ),
      ).toBe(observation.segmentKey);
    }
  });

  it('reports a jam for a vehicle that barely moves but not for two stationary fixes', () => {
    const edges = [edge(0), edge(1), edge(2)];
    const crawl = Array.from({ length: 8 }, (_, index) => ({
      // From 5 m before the middle edge to 30 m into the last one, 5 m every 6 s.
      matched: {
        edgeFraction: index < 1 ? 0.995 : index < 2 ? 0 : (index - 1) * 0.005,
        edgeIndex: index < 1 ? 0 : 1,
        startsNewPath: false,
      },
      point: { offsetSeconds: index * 6, position: [-114, 51] satisfies Position },
    }));
    const derive = (entries: typeof crawl) =>
      deriveObservations(
        { edges, points: entries.map(({ matched }) => matched) },
        entries.map(({ point }) => point),
        SETTINGS,
      );

    // 35 m in 42 s is 3 km/h.
    expect(derive(crawl).map(({ speedKph }) => Math.round(speedKph))).toEqual([3]);
    expect(derive(crawl.slice(0, 2))).toEqual([]);
  });

  it('ignores tertiary and residential streets, service roads, tracks and parking aisles', () => {
    const derive = (roadClass: string, use: string) =>
      observe(
        [0, 1, 2, 3].map((index) => edge(index, { roadClass, use })),
        50,
      );

    expect(derive('secondary', 'road')).toHaveLength(2);
    expect(derive('motorway', 'ramp')).toHaveLength(2);
    expect(derive('tertiary', 'road')).toEqual([]);
    expect(derive('unclassified', 'road')).toEqual([]);
    expect(derive('residential', 'road')).toEqual([]);
    expect(derive('service_other', 'parking_aisle')).toEqual([]);
    expect(derive('service_other', 'driveway')).toEqual([]);
    expect(derive('service_other', 'track')).toEqual([]);
    expect(derive('primary', 'living_street')).toEqual([]);
    expect(derive('primary', 'ferry')).toEqual([]);
  });

  it('does not credit a minor road driven between two stretches of the same main road', () => {
    const edges = [edge(0), edge(1), edge(2, { roadClass: 'residential' }), edge(3), edge(4)];
    const keys = observe(edges, 50).map(({ segmentKey }) => segmentKey);

    expect(keys.sort()).toEqual(
      [edge(1), edge(3)].map(({ segmentKey }) => present(segmentKey)).sort(),
    );
  });

  it('survives a sliver of a first edge instead of discarding the whole batch', () => {
    // The batch begins 99.5% of the way along its first edge.
    const sliver = edge(0, { fromFraction: 0.995, lengthMeters: 5 });
    const edges = [
      sliver,
      edge(1),
      edge(2),
      edge(3),
      edge(4, { toFraction: 0.7, lengthMeters: 700 }),
    ];
    const points = Array.from({ length: 50 }, (_, index) => ({
      offsetSeconds: index * 5,
      position: [-114, 51] satisfies Position,
    }));
    // 70 m every 5 s (50.4 km/h) from the sliver onward.
    const matched: MatchedTrace = {
      edges,
      points: points.map((_, index) => {
        const meters = 995 + index * 70;
        const edgeIndex = Math.min(4, Math.floor(meters / 1_000));
        return { edgeFraction: meters / 1_000 - edgeIndex, edgeIndex, startsNewPath: false };
      }),
    };
    const observations = deriveObservations(matched, points, SETTINGS);

    expect(observations.map(({ segmentKey }) => segmentKey).sort()).toEqual(
      [1, 2, 3].map((index) => present(edge(index).segmentKey)).sort(),
    );
    for (const observation of observations) expect(observation.speedKph).toBeCloseTo(50.4, 0);
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
  const edges: MatchedEdge[] = [0, 1, 2].map((index) => {
    const road = { forward: true, wayId: 100 + index };
    const line = geometry.slice(index * 2, index * 2 + 3);
    return {
      ...road,
      beginShapeIndex: index * 2,
      endShapeIndex: index * 2 + 2,
      fromFraction: 0,
      lengthMeters: 1_000,
      line,
      roadClass: index === 2 ? 'residential' : 'primary',
      segmentKey: edgeSegmentKey(road, line),
      speedKph: 60,
      toFraction: 1,
      use: 'road',
    };
  });
  const key = (index: number): string => present(edges[index]?.segmentKey);
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
        [key(0), 60],
        [key(1), 20],
      ]),
      SETTINGS,
    );

    // 1 km at 20 km/h takes 180 s; the edge of the free band, 42 km/h, takes 85.7 s.
    expect(annotation?.delaySeconds).toBeCloseTo(94.3, 1);
    expect(annotation?.typicalDurationSeconds).toBe(180);
    expect(annotation?.durationSeconds).toBeCloseTo(274.3, 1);
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
    const annotation = annotateRouteTraffic(route, edges, new Map([[key(1), 20]]), {
      ...SETTINGS,
      routeMinCoverage: 0.3,
    });

    // The slow edge spans geometry segments 2 and 3: half in each step.
    expect(annotation?.stepDurationsSeconds[0]).toBeCloseTo(90 + 47.1, 0);
    expect(annotation?.stepDurationsSeconds[1]).toBeCloseTo(90 + 47.1, 0);
    expect(annotation?.stepDurationsSeconds[2]).toBe(0);
  });

  it('never makes a route faster than its typical duration', () => {
    const annotation = annotateRouteTraffic(
      route,
      edges,
      new Map([
        [key(0), 95],
        [key(1), 95],
      ]),
      SETTINGS,
    );
    expect(annotation?.delaySeconds).toBe(0);
    expect(annotation?.durationSeconds).toBe(180);
  });

  it('says traffic is unavailable when too little of the route is observed', () => {
    expect(annotateRouteTraffic(route, edges, new Map([[key(0), 20]]), SETTINGS)).toBeUndefined();
    expect(annotateRouteTraffic(route, edges, new Map(), SETTINGS)).toBeUndefined();
  });

  it('does not use a speed published for the opposite direction or another edge of the way', () => {
    const opposite = edges.map((item) =>
      edgeSegmentKey({ forward: false, wayId: item.wayId }, item.line),
    );
    const otherEdge = edgeSegmentKey({ forward: true, wayId: 100 }, geometry.slice(4));
    expect(
      annotateRouteTraffic(
        route,
        edges,
        new Map([...opposite, otherEdge].map((segmentKey) => [segmentKey, 10])),
        SETTINGS,
      ),
    ).toBeUndefined();
  });

  it('caps the delay of a standstill at the typical duration of the whole route', () => {
    const annotation = annotateRouteTraffic(
      route,
      edges,
      new Map([
        [key(0), 0],
        [key(1), 60],
      ]),
      SETTINGS,
    );

    // Uncapped, 1 km at the 3 km/h floor would add 1,114 s to a three-minute route.
    expect(annotation?.congestion[0]).toBe('stopped');
    expect(annotation?.delaySeconds).toBe(180);
    expect(annotation?.durationSeconds).toBe(360);
    const stepTotal = annotation?.stepDurationsSeconds.reduce((sum, step) => sum + step, 0) ?? 0;
    expect(stepTotal).toBeCloseTo(360, 3);
  });
});

describe('route ranking with traffic', () => {
  interface Candidate extends RankableRoute {
    id: string;
  }
  const route = (
    id: string,
    durationSeconds: number,
    minorMeters: number | undefined,
  ): Candidate => ({ distanceMeters: 10_000, durationSeconds, id, minorMeters });
  const order = (routes: Candidate[]) => rankWithTraffic(routes).map(({ id }) => id);

  it('promotes another through-road route that is faster with traffic', () => {
    expect(order([route('arterial', 900, 300), route('highway', 700, 250)])).toEqual([
      'highway',
      'arterial',
    ]);
  });

  it('never promotes a route that uses more minor-road distance, whatever the claimed delay', () => {
    // Planted traffic says the arterial takes two hours; the alternative cuts through 2 km of
    // residential streets.
    expect(order([route('arterial', 7_200, 300), route('rat-run', 700, 2_300)])).toEqual([
      'arterial',
      'rat-run',
    ]);
  });

  it('never promotes a route whose roads are unknown, or over one whose roads are unknown', () => {
    expect(order([route('arterial', 7_200, 300), route('unwalked', 700, undefined)])).toEqual([
      'arterial',
      'unwalked',
    ]);
    expect(order([route('unwalked', 7_200, undefined), route('arterial', 700, 300)])).toEqual([
      'unwalked',
      'arterial',
    ]);
  });

  it('keeps the routing engine order when traffic changes nothing', () => {
    const routes = [route('a', 600, 0), route('b', 660, 0), route('c', 720, 5_000)];
    expect(order(routes)).toEqual(['a', 'b', 'c']);
  });

  it('lets a faster through route pass a slower one but not a minor-road route pass either', () => {
    expect(
      order([route('jammed', 3_000, 200), route('rat-run', 800, 4_000), route('clear', 900, 250)]),
    ).toEqual(['jammed', 'rat-run', 'clear']);
    expect(
      order([route('jammed', 3_000, 200), route('clear', 900, 250), route('rat-run', 800, 4_000)]),
    ).toEqual(['clear', 'jammed', 'rat-run']);
  });

  it('counts residential and service metres as minor and through classes as not', () => {
    expect(
      minorRoadMeters([
        edge(0, { roadClass: 'motorway' }),
        edge(1, { roadClass: 'tertiary' }),
        edge(2, { roadClass: 'residential' }),
        edge(3, { lengthMeters: 40, roadClass: 'service_other' }),
        edge(4, { roadClass: 'unclassified' }),
      ]),
    ).toBe(2_040);
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
    const metres = edges?.reduce((sum, item) => sum + item.lengthMeters, 0) ?? 0;
    expect(Math.abs(metres - DRIVE.route.distanceMeters)).toBeLessThan(5);
  });

  it('derives the same edge keys from a drive and from a route over the same road', async () => {
    const stub = stubbedMatcher();
    const points = trimBatchEnds(driveBatch(CREDENTIAL).points, 100);
    const driven = (await stub.matcher.matchTrace(points))?.edges.flatMap(
      ({ segmentKey }) => segmentKey ?? [],
    );
    const walked = new Set(
      (await stub.matcher.walkRoute(DRIVE.route.geometry))?.flatMap(
        ({ segmentKey }) => segmentKey ?? [],
      ),
    );

    expect(driven?.length).toBeGreaterThan(50);
    for (const segmentKey of driven ?? []) expect(walked.has(segmentKey)).toBe(true);
  });

  it('treats an unmatched trace as no data and an outage as an error', async () => {
    const stub = stubbedMatcher();
    const points = trimBatchEnds(driveBatch(CREDENTIAL).points, 100);

    stub.failNext(400);
    await expect(stub.matcher.matchTrace(points)).resolves.toBeUndefined();
    stub.failNext(502);
    await expect(stub.matcher.matchTrace(points)).rejects.toThrow('status 502');
    await expect(stub.matcher.matchTrace(points.slice(0, 20))).resolves.toBeUndefined();
  });

  it('treats a fix snapped from far off the road as unmatched', async () => {
    const points = trimBatchEnds(driveBatch(CREDENTIAL).points, 100);
    const recorded = DRIVE.traceResponse;
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: () =>
        Promise.resolve(
          Response.json({
            ...recorded,
            matched_points: recorded.matched_points.map((point, index) => ({
              ...point,
              distance_from_trace_point: index === 40 ? 80 : 3,
            })),
          }),
        ),
    });
    const matched = present(await matcher.matchTrace(points));

    expect(matched.points[40]).toBeUndefined();
    expect(matched.points[39]).toBeDefined();
    // The path is broken there, so distance is not measured across the bad fix.
    expect(matched.points[41]?.startsNewPath).toBe(true);
  });

  it('never follows a redirect from the matcher', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (_input, init) => {
        seen.push(init);
        return Promise.resolve(Response.json(DRIVE.traceResponse));
      },
    });
    await matcher.matchTrace(trimBatchEnds(driveBatch(CREDENTIAL).points, 100));

    expect(seen.map((init) => init?.redirect)).toEqual(['error']);
  });
});

describe('walking a route longer than one matcher request', () => {
  // 260 km due east along 51°N, one vertex every 500 m: three requests of at most 100 km.
  const degreesPerMeter = 1 / (111_195 * Math.cos((51 * Math.PI) / 180));
  const geometry: Position[] = Array.from({ length: 521 }, (_, index) => [
    Number((-114 + index * 500 * degreesPerMeter).toFixed(6)),
    51,
  ]);

  function encodePolyline6(positions: readonly Position[]): string {
    let previousLatitude = 0;
    let previousLongitude = 0;
    let encoded = '';
    const append = (delta: number): void => {
      let value = delta < 0 ? -delta * 2 - 1 : delta * 2;
      while (value >= 0x20) {
        encoded += String.fromCharCode((0x20 | (value % 0x20)) + 63);
        value = Math.floor(value / 0x20);
      }
      encoded += String.fromCharCode(value + 63);
    };
    for (const [longitude, latitude] of positions) {
      const latitudeE6 = Math.round(latitude * 1e6);
      const longitudeE6 = Math.round(longitude * 1e6);
      append(latitudeE6 - previousLatitude);
      append(longitudeE6 - previousLongitude);
      previousLatitude = latitudeE6;
      previousLongitude = longitudeE6;
    }
    return encoded;
  }

  /** Answers like Valhalla's edge walk: echoes the vertices, one 1 km edge per two segments. */
  function longRouteMatcher(mutate: (edges: Record<string, unknown>[]) => void = () => undefined) {
    const requests: Position[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: async (_input, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          shape: { lat: number; lon: number }[];
        };
        const shape = body.shape.map(({ lat, lon }): Position => [lon, lat]);
        requests.push(shape);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        const edges: Record<string, unknown>[] = [];
        for (let begin = 0; begin < shape.length - 1; begin += 2) {
          edges.push({
            begin_shape_index: begin,
            end_shape_index: Math.min(begin + 2, shape.length - 1),
            forward: true,
            length: Math.min(2, shape.length - 1 - begin) * 0.5,
            road_class: 'motorway',
            speed: 110,
            use: 'road',
            // The way is identified by where the edge starts, whichever request returns it.
            way_id: 1_000 + Math.round((present(shape[begin])[0] + 114) / degreesPerMeter / 1_000),
          });
        }
        mutate(edges);
        return Response.json({ edges, shape: encodePolyline6(shape), units: 'kilometers' });
      },
    });
    return { matcher, maxInFlight: () => maxInFlight, requests };
  }

  it('splits it into overlapping requests and returns one gapless edge list', async () => {
    const { matcher, maxInFlight, requests } = longRouteMatcher();
    const edges = present(await matcher.walkRoute(geometry));

    expect(requests.map((shape) => shape.length)).toEqual([201, 201, 121]);
    // Consecutive requests share exactly one vertex.
    expect(requests[1]?.[0]).toEqual(requests[0]?.at(-1));
    expect(requests[2]?.[0]).toEqual(requests[1]?.at(-1));
    // One at a time, so a long route never holds both Valhalla threads.
    expect(maxInFlight()).toBe(1);

    expect(edges).toHaveLength(260);
    expect(edges[0]?.beginShapeIndex).toBe(0);
    expect(edges.at(-1)?.endShapeIndex).toBe(geometry.length - 1);
    edges.forEach((item, index) => {
      // Indexes address the whole route, not the chunk, and tile it without a gap.
      expect(item.beginShapeIndex).toBe(index * 2);
      expect(item.endShapeIndex).toBe(index * 2 + 2);
      expect(item.line).toEqual(geometry.slice(index * 2, index * 2 + 3));
      expect(item.wayId).toBe(1_000 + index);
    });
    expect(edges.reduce((sum, item) => sum + item.lengthMeters, 0)).toBeCloseTo(260_000, 3);
    // Keys on both sides of a chunk boundary are those of the same edges walked in one piece.
    expect(edges[100]?.segmentKey).toBe(
      edgeSegmentKey({ forward: true, wayId: 1_100 }, geometry.slice(200, 203)),
    );
  });

  it('applies published speeds across the chunk boundary', async () => {
    const { matcher } = longRouteMatcher();
    const edges = present(await matcher.walkRoute(geometry));
    const annotation = annotateRouteTraffic(
      {
        durationSeconds: 8_509,
        geometry,
        steps: [{ durationSeconds: 8_509, geometry }],
      },
      edges,
      new Map(edges.slice(60, 220).map((item) => [present(item.segmentKey), 55])),
      SETTINGS,
    );

    expect(annotation?.observedFraction).toBe(0.62);
    expect(annotation?.congestion.slice(118, 122)).toEqual(['unknown', 'unknown', 'slow', 'slow']);
    expect(annotation?.congestion.slice(198, 204)).toEqual(new Array(6).fill('slow'));
    expect(annotation?.congestion.slice(438, 442)).toEqual(['slow', 'slow', 'unknown', 'unknown']);
    // 160 km at 55 km/h instead of the 77 km/h edge of the free band.
    expect(annotation?.delaySeconds).toBeCloseTo(160 * (3_600 / 55 - 3_600 / 77), 0);
  });

  it('gives up when a chunk has a gap or does not echo the route vertices', async () => {
    const gap = longRouteMatcher((edges) => {
      edges.splice(3, 1);
    });
    await expect(gap.matcher.walkRoute(geometry)).resolves.toBeUndefined();
    // It stops at the first unusable chunk instead of sending the rest.
    expect(gap.requests).toHaveLength(1);

    const short = longRouteMatcher((edges) => {
      edges.pop();
    });
    await expect(short.matcher.walkRoute(geometry)).resolves.toBeUndefined();
  });

  it('refuses a route too long to walk in twelve requests', async () => {
    const { matcher, requests } = longRouteMatcher();
    const veryLong: Position[] = Array.from({ length: 2_601 }, (_, index) => [
      Number((-130 + index * 500 * degreesPerMeter).toFixed(6)),
      51,
    ]);

    await expect(matcher.walkRoute(veryLong)).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
});

describe('matcher endpoint allowlist', () => {
  it.each([
    'http://valhalla:8002/trace_attributes',
    'http://localhost:8002/trace_attributes',
    'http://127.0.0.1:8002/trace_attributes',
    'http://10.0.3.7:8002/trace_attributes',
    'http://172.20.0.5:8002/trace_attributes',
    'http://192.168.1.20:8002/trace_attributes',
    'http://[::1]:8002/trace_attributes',
    'http://[fd12:3456::7]:8002/trace_attributes',
  ])('accepts the local endpoint %s', (endpoint) => {
    expect(isLocalMatcherEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://valhalla1.openstreetmap.de/trace_attributes',
    'https://valhalla1.openstreetmap.de./trace_attributes',
    'https://valhalla.example.com/trace_attributes',
    'http://localhost./trace_attributes',
    'http://8.8.8.8:8002/trace_attributes',
    'http://172.32.0.1:8002/trace_attributes',
    'http://[2001:db8::1]:8002/trace_attributes',
    'http://user:secret@valhalla:8002/trace_attributes',
    'ftp://valhalla/trace_attributes',
    'not a url',
  ])('refuses %s', (endpoint) => {
    expect(isLocalMatcherEndpoint(endpoint)).toBe(false);
  });
});
