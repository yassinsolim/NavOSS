import { readFileSync } from 'node:fs';

import type { TrafficProbeBatchRequest } from '@navoss/contracts';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createTrafficCohorts, type TrafficCohorts } from '../src/traffic/cohorts.js';
import { createTrafficCredentials } from '../src/traffic/credentials.js';
import { decodePolyline6, haversineMeters, type Position } from '../src/traffic/geo.js';
import {
  createValhallaMapMatcher,
  MapMatcherError,
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
import { createPostgresTrafficReleaseStore, TRAFFIC_POOL_CONFIG } from '../src/traffic/store.js';
import {
  CAPTURED_AT,
  DRIVE,
  driveBatch,
  FIXTURE_SETTINGS,
  isFixtureTrafficCoordinate,
  JAMMED_GAPS,
  NOW,
  requestUrl,
  stubbedMatcher,
  type LocatedPoint,
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
    openThroughRoad: true,
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

/** The speed an observation describes: distance moved over time spent. */
function speedOf(observation: SegmentObservation): number {
  const meters = observation.moves.reduce((sum, move) => sum + move.to - move.from, 0);
  const seconds =
    observation.moves.reduce((sum, move) => sum + move.seconds, 0) +
    observation.stops.reduce((sum, stop) => sum + stop.endSeconds - stop.startSeconds, 0);
  return (meters / seconds) * 3.6;
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

  it('judges age by the first point, so no driving in an accepted batch is over 10 minutes old', () => {
    // Driving began 10 min 30 s ago and ended 30 s ago: the last point alone looked current.
    const batch = straightBatch(30, 30, 10, '2026-11-12T17:50:00Z');
    expect(findProbeRejection(batch, NOW_MS, limits)).toBe('stale');
    expect(
      findProbeRejection(straightBatch(30, 30, 10, '2026-11-12T17:51:00Z'), NOW_MS, limits),
    ).toBeUndefined();
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
    const first = credentials.issue('installation-a', NOW_MS, 0);
    const second = credentials.issue('installation-a', NOW_MS + 3_600_000, 0);
    const firstSeed = present(credentials.open(first.credential, NOW_MS + 1)).seed;
    const secondSeed = present(credentials.open(second.credential, NOW_MS + 3_600_001)).seed;

    // Two credentials of one installation are different strings but the same contributor.
    expect(first.credential).not.toBe(second.credential);
    expect(credentials.tagFor(firstSeed, 'w1f-000000000000')).toBe(
      credentials.tagFor(secondSeed, 'w1f-000000000000'),
    );
  });

  it('gives unrelated tags to different installations and to one installation on two roads', () => {
    const a = present(
      credentials.open(credentials.issue('installation-a', NOW_MS, 0).credential, NOW_MS),
    ).seed;
    const b = present(
      credentials.open(credentials.issue('installation-b', NOW_MS, 0).credential, NOW_MS),
    ).seed;

    expect(credentials.tagFor(a, 'w1f-000000000000')).not.toBe(
      credentials.tagFor(b, 'w1f-000000000000'),
    );
    expect(credentials.tagFor(a, 'w1f-000000000000')).not.toBe(
      credentials.tagFor(a, 'w2f-000000000000'),
    );
  });

  it('carries nothing readable about the installation', () => {
    const installationId = '0b6f2d7e-5a57-4d0a-9b53-3f1f0f6c9a11';
    const { credential } = credentials.issue(installationId, NOW_MS, 0);
    const bytes = Buffer.from(credential, 'base64url');
    const { seed } = present(credentials.open(credential, NOW_MS));

    expect(bytes.includes(Buffer.from(installationId))).toBe(false);
    expect(bytes.includes(Buffer.from(installationId.replaceAll('-', ''), 'hex'))).toBe(false);
    expect(
      seed.includes(Buffer.from(installationId.replaceAll('-', ''), 'hex').subarray(0, 4)),
    ).toBe(false);
  });

  it('refuses expired, altered and foreign credentials', () => {
    const { credential, expiresAtMs } = credentials.issue('installation-a', NOW_MS, 0);
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
  /** A whole 700 m edge driven end to end at `speedKph`. */
  const sample = (speedKph: number, key = 'w1f-000000000000'): SegmentObservation => ({
    freeFlowKph: 80,
    lengthMeters: 700,
    line: [
      [-114.06, 51.05],
      [-114.05, 51.05],
    ],
    moves: [
      {
        endSeconds: 700 / (speedKph / 3.6),
        from: 0,
        seconds: 700 / (speedKph / 3.6),
        startSeconds: 0,
        to: 700,
      },
    ],
    roadClass: 'motorway',
    segmentKey: key,
    stops: [],
  });
  const as = (contributor: string, drivenAtMs = NOW_MS, newcomerNetwork?: string) => ({
    drivenAtMs,
    newcomerNetwork,
    tagFor: () => contributor,
  });
  const add = (cohorts: TrafficCohorts, contributor: string, speedKph: number, nowMs = NOW_MS) =>
    cohorts.add([sample(speedKph)], as(contributor, nowMs), nowMs).credited;

  it('releases a segment only once three contributors are in its cohort, at the boundary', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    add(cohorts, 'a', 40);
    add(cohorts, 'b', 44);
    expect(cohorts.closeEpoch(NEXT_TICK)).toEqual([]);
    expect(cohorts.pending()).toEqual({ partial: 0, samples: 2, segments: 1 });

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
    expect(cohorts.pending()).toEqual({ partial: 0, samples: 0, segments: 0 });
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
    expect(cohorts.pending()).toEqual({ partial: 0, samples: 1, segments: 1 });
    expect(
      cohorts.closeEpoch(lastUsefulTick + EPOCH_MS + SETTINGS.cohortSeconds * 1_000 + EPOCH_MS),
    ).toEqual([]);
    expect(cohorts.pending()).toEqual({ partial: 0, samples: 0, segments: 0 });
  });

  it('releases only driving from the cohort window before the boundary, whenever it arrived', () => {
    const tick = NEXT_TICK + 2 * EPOCH_MS;
    const arrivalMs = tick - 60_000;
    const window = SETTINGS.cohortSeconds * 1_000;
    // Two batches arrive just before the boundary describing driving 16 minutes before it: in
    // the reviewer's scenario these would have been published and served for 15 more minutes.
    const stale = createTrafficCohorts(SETTINGS);
    stale.add([sample(10)], as('a', tick - window - 60_000), arrivalMs);
    stale.add([sample(10)], as('b', tick - window - 60_000), arrivalMs);
    stale.add([sample(60)], as('c', tick - 120_000), arrivalMs);
    expect(stale.closeEpoch(tick)).toEqual([]);
    expect(stale.pending().samples).toBe(1);

    // Driving that began exactly at the window's start still counts.
    const fresh = createTrafficCohorts(SETTINGS);
    fresh.add([sample(10)], as('a', tick - window), arrivalMs);
    fresh.add([sample(10)], as('b', tick - window), arrivalMs);
    fresh.add([sample(60)], as('c', tick - 120_000), arrivalMs);
    expect(fresh.closeEpoch(tick)).toHaveLength(1);

    // A start time claimed after arrival cannot keep a sample longer than its arrival allows.
    const claimed = createTrafficCohorts(SETTINGS);
    for (const contributor of ['a', 'b', 'c']) {
      claimed.add([sample(60)], as(contributor, tick + window), tick - window - 1);
    }
    expect(claimed.closeEpoch(tick)).toEqual([]);
  });

  it('counts at most one newly registered installation per network in a cohort', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    // One handset with three new App Attest keys, all uploading over one network.
    for (const contributor of ['key-1', 'key-2', 'key-3']) {
      cohorts.add([sample(5)], as(contributor, NOW_MS, 'network-a'), NOW_MS);
    }
    expect(cohorts.pending().samples).toBe(1);
    expect(cohorts.closeEpoch(NEXT_TICK)).toEqual([]);

    // Established installations are not capped, and a newcomer on another network counts.
    cohorts.add([sample(60)], as('established', NEXT_TICK + 1_000), NEXT_TICK + 1_000);
    cohorts.add([sample(60)], as('key-4', NEXT_TICK + 1_000, 'network-b'), NEXT_TICK + 1_000);
    expect(cohorts.closeEpoch(NEXT_TICK + EPOCH_MS)).toHaveLength(1);
  });

  it('keeps one weight and the newcomer cap across a release that re-keys the cohort', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    for (const contributor of ['a', 'b', 'c']) add(cohorts, contributor, 60);
    // Completed after the boundary: these belong to the next cohort, keyed before the release.
    add(cohorts, 'late', 20, NEXT_TICK + 1_000);
    cohorts.add([sample(20)], as('new-1', NEXT_TICK + 1_000, 'network-a'), NEXT_TICK + 1_000);
    expect(cohorts.closeEpoch(NEXT_TICK)).toHaveLength(1);

    // After the release the edge's tags are re-keyed, but the pending ones are still recognised:
    // the same installation is not counted again, nor a second newcomer from the same network.
    expect(cohorts.add([sample(5)], as('late', NEXT_TICK + 2_000), NEXT_TICK + 2_000)).toEqual({
      credited: 0,
      ignored: 1,
    });
    expect(
      cohorts.add([sample(5)], as('new-2', NEXT_TICK + 2_000, 'network-a'), NEXT_TICK + 2_000)
        .credited,
    ).toBe(0);
    expect(cohorts.pending().samples).toBe(2);
    add(cohorts, 'd', 20, NEXT_TICK + 3_000);
    expect(cohorts.closeEpoch(NEXT_TICK + EPOCH_MS).map(({ speedKph }) => speedKph)).toEqual([20]);
  });

  it('counts the threshold for each drawn edge, not for the way as a whole', () => {
    const cohorts = createTrafficCohorts(SETTINGS);
    // Three drivers cover edges 1 and 2 of a way; a fourth alone continues over edges 3 to 5.
    const short = [0, 1, 2, 3].map((index) => edge(index));
    const long = [0, 1, 2, 3, 4, 5, 6].map((index) => edge(index));
    // A batch's partly driven first and last edges count too: 70% of 1 km is past the floor.
    const shortKeys = [0, 1, 2, 3].map((index) => present(edge(index).segmentKey));

    expect(
      observe(short, 54)
        .map(({ segmentKey }) => segmentKey)
        .sort(),
    ).toEqual([...shortKeys].sort());
    cohorts.add(observe(short, 54), as('a'), NOW_MS);
    cohorts.add(observe(short, 50), as('b'), NOW_MS);
    cohorts.add(observe(long, 58), as('solo'), NOW_MS);
    const releases = cohorts.closeEpoch(NEXT_TICK);

    expect(releases.map(({ segmentKey }) => segmentKey).sort()).toEqual([...shortKeys].sort());
    for (const release of releases) {
      // Each released line is exactly that edge's map geometry.
      expect(shortKeys).toContain(edgeSegmentKey({ forward: true, wayId: 7 }, release.line));
    }
    // The stretch only one driver used stays unpublished and unreleased.
    expect(cohorts.pending()).toEqual({ partial: 0, samples: 3, segments: 3 });
  });

  describe('coverage of one edge across batches', () => {
    const KEY = 'w9f-0123456789ab';
    /**
     * What one batch drove of a 1.5 km motorway edge: `intervals` at one steady speed taking
     * `seconds` in all, starting `atSeconds` into the batch.
     */
    const piece = (
      intervals: [number, number][],
      seconds: number,
      overrides: Partial<SegmentObservation> = {},
      atSeconds = 0,
    ): SegmentObservation => {
      const meters = intervals.reduce((sum, [from, to]) => sum + to - from, 0);
      let clock = atSeconds;
      return {
        freeFlowKph: 100,
        lengthMeters: 1_500,
        line: [
          [-114.1, 51.1],
          [-114.08, 51.1],
        ],
        moves: intervals.map(([from, to]) => {
          const share = (seconds * (to - from)) / meters;
          clock += share;
          return { endSeconds: clock, from, seconds: share, startSeconds: clock - share, to };
        }),
        roadClass: 'motorway',
        segmentKey: KEY,
        stops: [],
        ...overrides,
      };
    };
    /** Standing at `at` metres from `fromSeconds` to `toSeconds` of the batch. */
    const standing = (at: number, fromSeconds: number, toSeconds: number): SegmentObservation => ({
      ...piece([], 0),
      stops: [{ at, endSeconds: toSeconds, startSeconds: fromSeconds }],
    });

    it('credits a contributor once its batches together cover 300 m, at their overall speed', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      // A 12 km/h jam: 200 m a minute, so no single batch covers 300 m of the edge.
      for (const contributor of ['a', 'b', 'c']) {
        expect(cohorts.add([piece([[0, 200]], 60)], as(contributor), NOW_MS).credited).toBe(0);
      }
      expect(cohorts.pending()).toEqual({ partial: 3, samples: 0, segments: 1 });
      for (const contributor of ['a', 'b', 'c']) {
        expect(cohorts.add([piece([[200, 400]], 60)], as(contributor), NOW_MS).credited).toBe(1);
      }
      const [release] = cohorts.closeEpoch(NEXT_TICK);
      // 400 m in 120 s is 12 km/h, published in 5 km/h steps; the whole edge is drawn.
      expect(release?.speedKph).toBe(10);
      expect(release?.line).toEqual(piece([], 1).line);
      expect(cohorts.pending()).toEqual({ partial: 0, samples: 0, segments: 0 });
    });

    it('does not let replayed or overlapping batches reach the floor sooner than driving', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      for (let replay = 0; replay < 5; replay += 1) {
        expect(cohorts.add([piece([[0, 200]], 60)], as('a'), NOW_MS).credited).toBe(0);
      }
      // Overlapping coverage counts once: 260 m of the edge so far.
      expect(cohorts.add([piece([[150, 260]], 30)], as('a'), NOW_MS).credited).toBe(0);
      expect(cohorts.add([piece([[260, 300]], 12)], as('a'), NOW_MS).credited).toBe(1);
      // And the contributor still has one weight.
      expect(cohorts.add([piece([[300, 1_500]], 60)], as('a'), NOW_MS).credited).toBe(0);
      expect(cohorts.pending()).toEqual({ partial: 0, samples: 1, segments: 1 });
    });

    it('counts time standing in a queue on the edge', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      for (const contributor of ['a', 'b', 'c']) {
        cohorts.add([piece([[0, 200]], 60)], as(contributor), NOW_MS);
        // Two minutes stopped at 200 m, then 120 m more.
        cohorts.add(
          [
            {
              ...piece([[200, 320]], 36, {}, 120),
              stops: [{ at: 200, endSeconds: 120, startSeconds: 0 }],
            },
          ],
          as(contributor, NOW_MS + 60_000),
          NOW_MS + 60_000,
        );
      }
      // 320 m in 216 s is 5.3 km/h.
      const [release] = cohorts.closeEpoch(NEXT_TICK);
      expect(release?.speedKph).toBe(5);
      expect(classifyCongestion(release?.speedKph ?? 0, 100, SETTINGS)).toBe('stopped');
    });

    it('keeps a contributor’s speed when a slow piece is replayed (the reviewed 1.5 km case)', () => {
      // 100 m in 50 s, then 200 m in 10 s: 300 m in 60 s is 18 km/h, published as 20.
      const run = (replays: number) => {
        const cohorts = createTrafficCohorts(SETTINGS);
        const credits: number[] = [];
        for (const contributor of ['a', 'b', 'c']) {
          cohorts.add([piece([[0, 100]], 50)], as(contributor), NOW_MS);
          for (let replay = 0; replay < replays; replay += 1) {
            credits.push(cohorts.add([piece([[0, 100]], 50)], as(contributor), NOW_MS).credited);
          }
          credits.push(
            cohorts.add([piece([[100, 300]], 10, {}, 60)], as(contributor), NOW_MS).credited,
          );
        }
        return { credits, releases: cohorts.closeEpoch(NEXT_TICK) };
      };
      const honest = run(0);
      const replayed = run(9);

      expect(honest.credits).toEqual([1, 1, 1]);
      // Replays credit nothing and the sample still completes with the piece that covers 300 m.
      expect(replayed.credits.filter((credit) => credit === 1)).toHaveLength(3);
      expect(replayed.credits.at(9)).toBe(1);
      expect(honest.releases.map(({ speedKph }) => speedKph)).toEqual([20]);
      // Summing every upload would have made it 1,200 m in 510 s: 8.5 km/h, published as 10.
      expect(replayed.releases.map(({ speedKph }) => speedKph)).toEqual([20]);
    });

    it('counts each metre’s moving time once when a replay claims another speed for it', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      cohorts.add([piece([[0, 200]], 20)], as('a'), NOW_MS);
      // The same 200 m again, now claiming a crawl, then a part-overlapping piece.
      cohorts.add([piece([[0, 200]], 200)], as('a'), NOW_MS);
      expect(cohorts.add([piece([[100, 300]], 100)], as('a'), NOW_MS).credited).toBe(1);
      for (const contributor of ['b', 'c']) {
        cohorts.add([piece([[0, 300]], 30)], as(contributor), NOW_MS);
      }
      // a: 300 m in 20 s + half of 100 s = 70 s, 15.4 km/h; b and c 36 km/h. Median 36: 35.
      // Summing would give a 600 m in 320 s, and the same median; check a's own sample instead.
      const solo = createTrafficCohorts({ ...SETTINGS, minimumContributors: 3 });
      for (const contributor of ['a', 'b', 'c']) {
        solo.add([piece([[0, 200]], 20)], as(contributor), NOW_MS);
        solo.add([piece([[0, 200]], 200)], as(contributor), NOW_MS);
        solo.add([piece([[100, 300]], 100)], as(contributor), NOW_MS);
      }
      expect(solo.closeEpoch(NEXT_TICK).map(({ speedKph }) => speedKph)).toEqual([15]);
      expect(cohorts.closeEpoch(NEXT_TICK).map(({ speedKph }) => speedKph)).toEqual([35]);
    });

    it('counts a stop once however it is repeated, and separate stops each', () => {
      const minute = 60_000;
      const start = NOW_MS - 10 * minute;
      interface Upload {
        claimedMs: number;
        observation: SegmentObservation;
      }
      const speedWith = (uploads: Upload[]): number | undefined => {
        const cohorts = createTrafficCohorts(SETTINGS);
        for (const contributor of ['a', 'b', 'c']) {
          for (const { claimedMs, observation } of uploads) {
            cohorts.add([observation], as(contributor, claimedMs), NOW_MS);
          }
        }
        return cohorts.closeEpoch(NEXT_TICK)[0]?.speedKph;
      };
      const before: Upload = { claimedMs: start, observation: piece([[0, 150]], 10) };
      const stop: Upload = { claimedMs: start + minute, observation: standing(150, 0, 100) };
      const after: Upload = { claimedMs: start + 3 * minute, observation: piece([[150, 300]], 10) };

      // 300 m in 20 s moving and 100 s standing: 9 km/h, published as 10.
      expect(speedWith([before, stop, after])).toBe(10);
      // The stop uploaded four more times: summing would make it 300 m in 520 s, 2 km/h.
      expect(speedWith([before, stop, stop, stop, stop, stop, after])).toBe(10);
      // Re-batched 20 s later: only those 20 s are new (300 m in 140 s, 7.7 km/h), where
      // summing would give 300 m in 220 s, 4.9 km/h, published as 5.
      const rebatched: Upload = {
        claimedMs: start + minute + 20_000,
        observation: standing(153, 0, 100),
      };
      expect(speedWith([before, stop, rebatched, after])).toBe(10);
      // A second, genuine stop elsewhere on the edge, in another batch, counts in full:
      // 300 m in 220 s is 4.9 km/h, published as 5.
      const second: Upload = { claimedMs: start + 2 * minute, observation: standing(260, 0, 100) };
      expect(speedWith([before, stop, second, after])).toBe(5);
    });

    describe('dwell trimmed off batch ends', () => {
      const minute = 60_000;
      /** Where the vehicle stood, `meters` along the 1.5 km edge (its line is 0.02° long). */
      const at = (meters: number): Position => [-114.1 + (0.02 * meters) / 1_500, 51.1];
      const dwell = (meters: number, startSeconds: number, endSeconds: number) => ({
        endSeconds,
        position: at(meters),
        startSeconds,
      });
      interface Batch {
        claimedMs: number;
        dwells: ReturnType<typeof dwell>[];
        observations: SegmentObservation[];
      }
      const run = (batches: Batch[], tick = NEXT_TICK) => {
        const cohorts = createTrafficCohorts(SETTINGS);
        for (const contributor of ['a', 'b', 'c']) {
          for (const { claimedMs, dwells, observations } of batches) {
            cohorts.add(observations, as(contributor, claimedMs), NOW_MS, dwells);
          }
        }
        return { cohorts, releases: cohorts.closeEpoch(tick) };
      };
      const start = NOW_MS - 9 * minute;
      // Moving 0–200 m in the first minute, then standing at 300 m until the trim cut it off.
      const approach: Batch = {
        claimedMs: start,
        dwells: [dwell(300, 75, 135)],
        observations: [piece([[0, 200]], 60)],
      };
      // Standing at 300 m for two minutes, then moving 400–600 m.
      const resume: Batch = {
        claimedMs: start + 3 * minute,
        dwells: [dwell(300, 0, 120)],
        observations: [piece([[400, 600]], 60, {}, 150)],
      };

      it('counts standing at a batch boundary once the trip is seen going on', () => {
        // 400 m in 120 s moving and 180 s standing: 4.8 km/h, published as 5. Without the
        // dwell it would be 400 m in 120 s, 12 km/h, published as 10.
        expect(run([approach, resume]).releases.map(({ speedKph }) => speedKph)).toEqual([5]);
      });

      it('counts a long stop over several stationary batches, once each, inside the window', () => {
        const stationary = (claimedMs: number): Batch => ({
          claimedMs,
          dwells: [dwell(301, 0, 120)],
          observations: [],
        });
        const going: Batch = {
          claimedMs: start + 6 * minute,
          dwells: [dwell(300, 0, 120)],
          observations: [piece([[400, 1_400]], 60, {}, 150)],
        };
        const speeds = (batches: Batch[], tick?: number) =>
          run(batches, tick).releases.map(({ speedKph }) => speedKph);
        const s1 = stationary(start + 2 * minute);
        const s2 = stationary(start + 4 * minute);
        // Standing only at the two moving batches' ends (60 + 120 s): 1,200 m in 300 s, 14.4 km/h.
        // Counting no standing at all would publish 35 (1,200 m in 120 s).
        expect(speeds([approach, going])).toEqual([15]);
        // With 60 + 120 + 120 + 120 s standing: 1,200 m in 540 s, 8 km/h, published as 10.
        expect(speeds([approach, s1, s2, going])).toEqual([10]);
        // Each stationary batch uploaded again changes nothing; summing would give 6.5 km/h, 5.
        expect(speeds([approach, s1, s2, s2, s1, going])).toEqual([10]);
        // Driving that began more than 15 minutes before the boundary is never released.
        expect(speeds([approach, s1, s2, going], start + 15 * minute + EPOCH_MS)).toEqual([]);
      });

      it('never counts standing that no movement follows, as when a trip ends at the stop', () => {
        const { cohorts, releases } = run([
          approach,
          { claimedMs: start + 2 * minute, dwells: [dwell(300, 0, 280)], observations: [] },
        ]);
        expect(releases).toEqual([]);
        // Coverage alone completes later at 12 km/h: the stop before the end still never counts.
        for (const contributor of ['a', 'b', 'c']) {
          cohorts.add(
            [piece([[200, 400]], 60, {}, 60)],
            as(contributor, start + 8 * minute),
            NOW_MS,
          );
        }
        expect(cohorts.closeEpoch(NEXT_TICK).map(({ speedKph }) => speedKph)).toEqual([10]);
      });

      it('never counts standing before the contributor’s first movement on the edge', () => {
        // A trip that starts standing at 50 m: nothing on this edge came before it.
        const startsHere: Batch = {
          claimedMs: start,
          dwells: [dwell(50, 0, 240)],
          observations: [piece([[150, 450]], 90, {}, 260)],
        };
        // 300 m in 90 s is 12 km/h, published as 10.
        expect(run([startsHere]).releases.map(({ speedKph }) => speedKph)).toEqual([10]);
      });

      it('drops standing claimed after the contributor had already driven past it', () => {
        const onward: Batch = {
          claimedMs: start + 12 * minute,
          dwells: [],
          observations: [piece([[700, 1_500]], 60)],
        };
        // A stationary batch at 300 m claiming a time after the contributor had moved on to
        // 600 m: movement brackets it in space, but it contradicts the trip in time.
        const late: Batch = {
          claimedMs: start + 8 * minute,
          dwells: [dwell(300, 0, 280)],
          observations: [],
        };
        const speeds = (batches: Batch[]) => run(batches).releases.map(({ speedKph }) => speedKph);
        // Short enough that coverage completes only with the onward batch.
        const shortResume: Batch = { ...resume, observations: [piece([[400, 450]], 60, {}, 150)] };
        // 1,050 m in 180 s moving and 180 s standing: 10.5 km/h, published as 10. Counting the
        // late stop as well would give 5.9 km/h, published as 5.
        expect(speeds([approach, shortResume, onward])).toEqual([10]);
        expect(speeds([approach, shortResume, late, onward])).toEqual([10]);
      });

      it('needs the trip to go on at least the server trim, plus placement slack, past a dwell', () => {
        // Movement resuming 110 m past the stop is not enough; 130 m is.
        const short: Batch = {
          ...resume,
          observations: [piece([[300, 410]], 30, {}, 150)],
        };
        const enough: Batch = {
          ...resume,
          observations: [piece([[300, 430]], 30, {}, 150)],
        };
        // Not counted: 310 m in 90 s moving, 12.4 km/h, published as 10 (with the standing, 5).
        expect(run([approach, short]).releases.map(({ speedKph }) => speedKph)).toEqual([10]);
        // Counted: 330 m in 90 s moving and 180 s standing, 4.4 km/h, published as 5.
        expect(run([approach, enough]).releases.map(({ speedKph }) => speedKph)).toEqual([5]);
      });

      it('takes going on across the end node only onto an edge that starts there', () => {
        const nearEnd: Batch = {
          claimedMs: start,
          dwells: [dwell(1_480, 75, 135)],
          observations: [piece([[1_000, 1_400]], 60)],
        };
        const next = (line: Position[]): Batch => ({
          claimedMs: start + 3 * minute,
          dwells: [],
          observations: [
            piece([[0, 300]], 30, { line, lengthMeters: 300, segmentKey: 'w9f-00000000000b' }, 150),
          ],
        });
        // The 1.5 km test edge's line ends at -114.08, 51.1.
        const joined = next([
          [-114.08, 51.1],
          [-114.076, 51.1],
        ]);
        const apart = next([
          [-114.079, 51.1],
          [-114.075, 51.1],
        ]);
        const speedOn = (batches: Batch[]) =>
          run(batches).releases.find(({ segmentKey }) => segmentKey === KEY)?.speedKph;
        // 400 m in 60 s moving: 24 km/h (25); with 60 s standing confirmed, 12 km/h (10).
        expect(speedOn([nearEnd, joined])).toBe(10);
        expect(speedOn([nearEnd, apart])).toBe(25);
      });

      it('places standing only on an edge where the contributor already moves', () => {
        // Same contributor, another edge: a dwell beside the first edge is not put there.
        const other = { segmentKey: 'w10f-0123456789ab' };
        const cohorts = createTrafficCohorts(SETTINGS);
        const perEdge = (claimedMs: number) => ({
          drivenAtMs: claimedMs,
          tagFor: (segmentKey: string) => `a:${segmentKey}`,
        });
        cohorts.add([piece([[0, 200]], 60, other)], perEdge(start), NOW_MS, [dwell(300, 75, 135)]);
        cohorts.add([piece([[400, 600]], 60, {}, 150)], perEdge(start + 3 * minute), NOW_MS, [
          dwell(300, 0, 120),
        ]);
        // The dwell sits on the other edge's line (the test lines coincide); it was placed there,
        // not on the edge only driven afterwards, so nothing completes on either edge.
        expect(cohorts.pending()).toEqual({ partial: 2, samples: 0, segments: 2 });
      });
    });

    it('expires a sample with the oldest evidence it counted, even evidence that arrived late', () => {
      // Completed from driving at 18:11; a delayed batch from 18:09 adds its time at 18:18.
      const minute = 60_000;
      const t = Date.parse('2026-11-12T18:00:00Z');
      const cohorts = createTrafficCohorts(SETTINGS);
      for (const contributor of ['a', 'b', 'c']) {
        cohorts.add([piece([[300, 700]], 40)], as(contributor, t + 11 * minute), t + 12 * minute);
        cohorts.add(
          [{ ...piece([], 0), stops: [{ at: 250, endSeconds: 120, startSeconds: 0 }] }],
          as(contributor, t + 9 * minute),
          t + 18 * minute,
        );
        // A repeat of the fresh batch counts nothing and does not move the cutoff.
        cohorts.add([piece([[300, 700]], 40)], as(contributor, t + 11 * minute), t + 18 * minute);
      }
      // At 18:25 the window starts at 18:10: the 18:09 driving is too old, so nothing it touched
      // is published.
      expect(cohorts.closeEpoch(t + 25 * minute)).toEqual([]);
    });

    it('needs only half of a short edge', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      const short = (intervals: [number, number][]) => piece(intervals, 5, { lengthMeters: 100 });
      expect(cohorts.add([short([[0, 40]])], as('a'), NOW_MS).credited).toBe(0);
      expect(cohorts.add([short([[40, 55]])], as('a'), NOW_MS).credited).toBe(1);
    });

    it('forgets partial coverage with its cohort', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      cohorts.add([piece([[0, 200]], 60)], as('a'), NOW_MS);
      cohorts.closeEpoch(EPOCH_START + SETTINGS.cohortSeconds * 1_000);
      expect(cohorts.pending().partial).toBe(1);
      cohorts.closeEpoch(EPOCH_START + SETTINGS.cohortSeconds * 1_000 + EPOCH_MS);
      expect(cohorts.pending()).toEqual({ partial: 0, samples: 0, segments: 0 });
      // Driving that resumes later starts from nothing.
      expect(
        cohorts.add([piece([[200, 400]], 60)], as('a', NEXT_TICK * 2), NEXT_TICK * 2).credited,
      ).toBe(0);
    });

    it('keeps one contributor’s coverage of different edges apart, under per-edge tags', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      const perEdge = (contributor: string) => ({
        drivenAtMs: NOW_MS,
        tagFor: (segmentKey: string) => `${contributor}:${segmentKey}`,
      });
      const other = { segmentKey: 'w10f-0123456789ab' };
      cohorts.add([piece([[0, 200]], 60), piece([[0, 200]], 60, other)], perEdge('a'), NOW_MS);
      expect(cohorts.pending()).toEqual({ partial: 2, samples: 0, segments: 2 });
      // Coverage of one edge does nothing for another.
      expect(cohorts.add([piece([[200, 250]], 15, other)], perEdge('a'), NOW_MS).credited).toBe(0);
      expect(cohorts.add([piece([[200, 300]], 30)], perEdge('a'), NOW_MS).credited).toBe(1);
    });

    it('credits at most one newcomer per network when coverage completes', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      for (const contributor of ['key-1', 'key-2']) {
        cohorts.add([piece([[0, 200]], 60)], as(contributor, NOW_MS, 'network-a'), NOW_MS);
      }
      expect(
        cohorts.add([piece([[200, 400]], 60)], as('key-1', NOW_MS, 'network-a'), NOW_MS).credited,
      ).toBe(1);
      expect(
        cohorts.add([piece([[200, 400]], 60)], as('key-2', NOW_MS, 'network-a'), NOW_MS).credited,
      ).toBe(0);
    });
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
      expect(cohorts.add([{ ...sample(60), line: planted }], as('b'), NOW_MS).credited).toBe(1);
      expect(cohorts.add([{ ...sample(60), line: planted }], as('c'), NOW_MS).credited).toBe(1);

      expect(cohorts.closeEpoch(NEXT_TICK)[0]?.line).toEqual(sample(0).line);
    });

    it('is not changed by a repeat that is not counted', () => {
      const cohorts = createTrafficCohorts(SETTINGS);
      for (const contributor of ['a', 'b', 'c']) add(cohorts, contributor, 60);
      // The last thing to arrive is a de-duplicated repeat carrying another line.
      expect(cohorts.add([{ ...sample(60), line: planted }], as('a'), NOW_MS).credited).toBe(0);

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

  it('yields what the batch drove of each road edge, at the speed that was driven', async () => {
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
      expect(speedOf(observation)).toBeGreaterThanOrEqual(34);
      expect(speedOf(observation)).toBeLessThanOrEqual(46);
      // Positions are distances along the edge, never coordinates of the upload.
      for (const { from, to } of observation.moves) {
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThanOrEqual(observation.lengthMeters + 1e-6);
      }
      // No time of day and no position of the upload: only these fields exist, and times are
      // offsets within the batch.
      expect(Object.keys(observation).sort()).toEqual([
        'freeFlowKph',
        'lengthMeters',
        'line',
        'moves',
        'roadClass',
        'segmentKey',
        'stops',
      ]);
    }
  });

  it('sees the crawl only on the edges where it happened', async () => {
    const steady = (await observeDrive()).observations;
    const jammed = (await observeDrive(JAMMED_GAPS)).observations;
    const slowed = jammed.filter((observation) => speedOf(observation) < 25);

    expect(slowed.length).toBeGreaterThan(0);
    expect(slowed.length).toBeLessThan(jammed.length);
    expect(jammed.map(({ segmentKey }) => segmentKey)).toEqual(
      steady.map(({ segmentKey }) => segmentKey),
    );
  });

  it('keeps only whole-edge map geometry, never the ends of the drive or an uploaded fix', async () => {
    const { matched, observations, points } = await observeDrive();
    const shape = decodePolyline6(DRIVE.traceResponse.shape);
    // Map vertices: the matched shape and the whole edges `/locate` returned.
    const roadVertices = new Set(
      [
        ...shape,
        ...DRIVE.locateResponse.flatMap((point) =>
          (point.edges ?? []).flatMap(({ edge_info: info }) =>
            info.shape === undefined ? [] : decodePolyline6(info.shape),
          ),
        ),
      ].map((vertex) => vertex.join(',')),
    );
    const uploaded = new Set(points.map(({ position }) => position.join(',')));
    // Where the trimmed batch was snapped on: positions derived from the upload, not map vertices.
    const endVertices = new Set([shape[0], shape.at(-1)].map((vertex) => vertex?.join(',')));
    const kept = observations.flatMap(({ line }) => line);

    expect(kept.length).toBeGreaterThan(10);
    for (const vertex of kept) {
      expect(roadVertices.has(vertex.join(','))).toBe(true);
      expect(uploaded.has(vertex.join(','))).toBe(false);
      expect(endVertices.has(vertex.join(','))).toBe(false);
    }
    // A partly driven edge is observed under its whole edge's key and geometry.
    const partial = matched.edges.filter((edge) => edge.wholeEdge !== undefined);
    expect(partial.length).toBeGreaterThan(0);
    for (const edge of partial) {
      expect(edge.segmentKey).toBeUndefined();
      expect(observations.map(({ segmentKey }) => segmentKey)).toContain(
        edge.wholeEdge?.segmentKey,
      );
    }
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

    // 35 m in 42 s is 3 km/h, on each of the two edges it touched.
    const observed = derive(crawl);
    expect(observed.map(({ segmentKey }) => segmentKey).sort()).toEqual(
      [edges[0], edges[1]].map((driven) => present(driven?.segmentKey)).sort(),
    );
    expect(observed.map((observation) => Math.round(speedOf(observation)))).toEqual([3, 3]);
    expect(derive(crawl.slice(0, 2))).toEqual([]);
  });

  it('ignores tertiary and residential streets, service roads, tracks and parking aisles', () => {
    const derive = (roadClass: string, use: string) =>
      observe(
        [0, 1, 2, 3].map((index) => edge(index, { roadClass, use })),
        50,
      );

    expect(derive('secondary', 'road')).toHaveLength(4);
    expect(derive('motorway', 'ramp')).toHaveLength(4);
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
      [edge(0), edge(1), edge(3), edge(4)].map(({ segmentKey }) => present(segmentKey)).sort(),
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
    for (const observation of observations) expect(speedOf(observation)).toBeCloseTo(50.4, 0);
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
      fetchImplementation: (input) =>
        Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate')
              ? DRIVE.locateResponse
              : {
                  ...recorded,
                  matched_points: recorded.matched_points.map((point, index) => ({
                    ...point,
                    distance_from_trace_point: index === 40 ? 80 : 3,
                  })),
                },
          ),
        ),
    });
    const matched = present(await matcher.matchTrace(points));

    expect(matched.points[40]).toBeUndefined();
    expect(matched.points[39]).toBeDefined();
    // The path is broken there, so distance is not measured across the bad fix.
    expect(matched.points[41]?.startsNewPath).toBe(true);
  });

  it('treats the no-edge sentinel Valhalla sends for a crawl as unmatched, not as an outage', async () => {
    const crawl = JSON.parse(
      readFileSync(new URL('./fixtures/valhalla-crawl-calgary.json', import.meta.url), 'utf8'),
    ) as {
      locateResponse: unknown;
      points: TrafficProbeBatchRequest['points'];
      traceResponse: { matched_points: { edge_index?: number }[] };
    };
    const sentinels = crawl.traceResponse.matched_points.flatMap((point, index) =>
      (point.edge_index ?? 0) > Number.MAX_SAFE_INTEGER ? [index] : [],
    );
    expect(sentinels.length).toBeGreaterThan(0);
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (input) =>
        Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate') ? crawl.locateResponse : crawl.traceResponse,
          ),
        ),
    });
    const points = trimBatchEnds(crawl.points, 100);
    // Rejecting the whole answer turned one in six batches of a 12 km/h jam into a 503.
    const matched = present(await matcher.matchTrace(points));

    for (const index of sentinels) expect(matched.points[index]).toBeUndefined();
    expect(matched.points.filter((point) => point !== undefined).length).toBeGreaterThan(
      points.length / 2,
    );
  });

  it('places a partly matched real edge under its whole edge, confirmed by its geometry', async () => {
    const crawl = JSON.parse(
      readFileSync(new URL('./fixtures/valhalla-crawl-calgary.json', import.meta.url), 'utf8'),
    ) as {
      locateResponse: unknown;
      points: TrafficProbeBatchRequest['points'];
      traceResponse: unknown;
    };
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (input) =>
        Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate') ? crawl.locateResponse : crawl.traceResponse,
          ),
        ),
    });
    const points = trimBatchEnds(crawl.points, 100);
    const matched = present(await matcher.matchTrace(points));
    const partial = matched.edges.filter((edge) => edge.wholeEdge !== undefined);

    // A 12 km/h batch on Deerfoot Trail lies inside long edges it drives only in part.
    expect(partial.length).toBeGreaterThan(0);
    for (const edge of partial) {
      const whole = present(edge.wholeEdge);
      expect(whole.segmentKey).toBe(edgeSegmentKey(edge, whole.line));
      // The matched part lies on the whole edge: its node end is the whole edge's end.
      if (edge.fromFraction === 0) expect(edge.line[0]).toEqual(whole.line[0]);
      if (edge.toFraction === 1) expect(edge.line.at(-1)).toEqual(whole.line.at(-1));
    }
    const observed = deriveObservations(matched, points, SETTINGS);
    // The partly matched first edge is observed under its whole key (the last one was matched by a
    // single fix after an unmatched one, which is no movement).
    expect(observed.map(({ segmentKey }) => segmentKey)).toContain(
      present(partial[0]?.wholeEdge).segmentKey,
    );
    for (const observation of observed) {
      expect(speedOf(observation)).toBeGreaterThan(5);
      expect(speedOf(observation)).toBeLessThan(20);
    }
  });

  it('treats a matched fix without a snap distance as unmatched', async () => {
    const points = trimBatchEnds(driveBatch(CREDENTIAL).points, 100);
    const recorded = DRIVE.traceResponse;
    // The recorded Valhalla 3.8.2 answer has the distance for every point.
    expect(recorded.matched_points.every((point) => 'distance_from_trace_point' in point)).toBe(
      true,
    );
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (input) =>
        Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate')
              ? DRIVE.locateResponse
              : {
                  ...recorded,
                  matched_points: recorded.matched_points.map((point, index) =>
                    index === 40
                      ? Object.fromEntries(
                          Object.entries(point).filter(
                            ([name]) => name !== 'distance_from_trace_point',
                          ),
                        )
                      : point,
                  ),
                },
          ),
        ),
    });
    const matched = present(await matcher.matchTrace(points));

    expect(matched.points[40]).toBeUndefined();
    expect(matched.points[41]?.startsNewPath).toBe(true);
  });

  it('never follows a redirect from the matcher', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (input, init) => {
        seen.push(init);
        return Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate') ? DRIVE.locateResponse : DRIVE.traceResponse,
          ),
        );
      },
    });
    await matcher.matchTrace(trimBatchEnds(driveBatch(CREDENTIAL).points, 100));

    // The trace and the access check: neither follows a redirect.
    expect(seen.map((init) => init?.redirect)).toEqual(['error', 'error']);
  });
});

describe('which matched edges may be published', () => {
  const points = trimBatchEnds(driveBatch(CREDENTIAL).points, 100);
  const publishedKeys = async (stub = stubbedMatcher()) => {
    const matched = present(await stub.matcher.matchTrace(points));
    return deriveObservations(matched, points, SETTINGS).map(({ segmentKey }) => segmentKey);
  };
  /** Sets `flag` on every located edge of `wayId`, in the given direction or both. */
  const mark =
    (
      wayId: number,
      flag: 'deadend' | 'destination_only' | 'no_car' | 'not_thru',
      forward?: boolean,
    ) =>
    (recorded: LocatedPoint[]): LocatedPoint[] =>
      recorded.map((point) => ({
        edges:
          point.edges?.map((candidate) => {
            if (
              candidate.edge_info.way_id !== wayId ||
              (forward !== undefined && candidate.edge.forward !== forward)
            ) {
              return candidate;
            }
            return flag === 'no_car'
              ? { ...candidate, edge: { ...candidate.edge, access: { car: false } } }
              : { ...candidate, edge: { ...candidate.edge, [flag]: true } };
          }) ?? null,
      }));

  it('publishes the recorded drive only on edges of at least 20 m confirmed open', async () => {
    const stub = stubbedMatcher();
    const matched = present(await stub.matcher.matchTrace(points));
    const observations = deriveObservations(matched, points, SETTINGS);
    const keys = observations.map(({ segmentKey }) => segmentKey);

    expect(keys.length).toBeGreaterThan(10);
    for (const observation of observations) {
      const edge = present(
        matched.edges.find(
          (candidate) =>
            (candidate.segmentKey ?? candidate.wholeEdge?.segmentKey) === observation.segmentKey,
        ),
      );
      expect(observation.lengthMeters).toBeGreaterThanOrEqual(20);
      expect(edge.openThroughRoad).toBe(true);
    }
    // The recorded drive has whole aggregated edges shorter than 20 m; none is published.
    const short = matched.edges.filter(
      (edge) => edge.segmentKey !== undefined && edge.lengthMeters < 20,
    );
    expect(short.length).toBeGreaterThan(0);
    for (const edge of short) expect(keys).not.toContain(edge.segmentKey);
  });

  it('asks the graph about map points only, never an uploaded position', async () => {
    const stub = stubbedMatcher();
    await stub.matcher.matchTrace(points);

    expect(stub.locateRequests).toHaveLength(1);
    const uploaded = new Set(
      DRIVE.batchPositions.map(
        ([longitude, latitude]) => `${String(longitude)},${String(latitude)}`,
      ),
    );
    const matched = present(await stubbedMatcher().matcher.matchTrace(points));
    const shape = matched.edges.flatMap(({ line }) => line);
    for (const { lat, lon } of stub.locateRequests[0]?.locations ?? []) {
      expect(uploaded.has(`${lon.toFixed(5)},${lat.toFixed(5)}`)).toBe(false);
      // Each point lies on the road geometry Valhalla returned.
      const nearest = Math.min(...shape.map((vertex) => haversineMeters(vertex, [lon, lat])));
      expect(nearest).toBeLessThan(200);
    }
  });

  it.each([
    ['destination-only (access=private or destination)', 'destination_only'],
    ['a dead end', 'deadend'],
    ['the way into a no-through region', 'not_thru'],
    ['closed to cars', 'no_car'],
  ] as const)('publishes no edge of a way the graph marks as %s', async (_label, flag) => {
    const baseline = await publishedKeys();
    const wayKeys = baseline.filter((key) => key.startsWith('w142596972'));
    expect(wayKeys.length).toBeGreaterThan(0);

    const stub = stubbedMatcher();
    stub.locate(mark(142596972, flag));
    const keys = await publishedKeys(stub);
    expect(keys).toEqual(baseline.filter((key) => !wayKeys.includes(key)));
  });

  it('excludes a way when only the opposite direction leads into a dead end', async () => {
    // Driving out of a cul-de-sac region is as revealing as driving into one.
    const baseline = await publishedKeys();
    const stub = stubbedMatcher();
    stub.locate(mark(161683836, 'not_thru', false));
    const keys = await publishedKeys(stub);
    expect(keys.some((key) => key.startsWith('w161683836'))).toBe(false);
    expect(keys.length).toBeLessThan(baseline.length);
  });

  it('fails closed when the graph does not confirm an edge, and on a lookup outage', async () => {
    const unconfirmed = stubbedMatcher();
    unconfirmed.locate((recorded) => recorded.map(() => ({ edges: null })));
    expect(await publishedKeys(unconfirmed)).toEqual([]);

    // Another way at the same point says nothing about the driven one.
    const elsewhere = stubbedMatcher();
    elsewhere.locate((recorded) =>
      recorded.map((point) => ({
        edges:
          point.edges?.map((candidate) => ({
            ...candidate,
            edge_info: { way_id: candidate.edge_info.way_id + 1 },
          })) ?? null,
      })),
    );
    expect(await publishedKeys(elsewhere)).toEqual([]);

    const down = stubbedMatcher();
    down.locate(() => new Response('{}', { status: 502 }));
    await expect(down.matcher.matchTrace(points)).rejects.toThrow(MapMatcherError);
  });

  it('ignores restrictions on other ways that meet the driven edge', async () => {
    // The recorded answer already includes a private dead-end way at one junction of the drive.
    const flagged = DRIVE.locateResponse.flatMap((point) =>
      (point.edges ?? []).filter(
        (candidate) => candidate.edge.destination_only || candidate.edge.deadend,
      ),
    );
    expect(flagged.length).toBeGreaterThan(0);
    expect((await publishedKeys()).length).toBeGreaterThan(10);
  });
});

describe('release storage', () => {
  const failingClient = (rollback: 'fails' | 'succeeds') => {
    const released: unknown[] = [];
    const client = {
      query: (sql: string) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
        if (sql === 'ROLLBACK') {
          return rollback === 'fails'
            ? Promise.reject(new Error('Query read timeout'))
            : Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error('canceling statement due to lock timeout'));
      },
      release: (error?: unknown) => {
        released.push(error);
      },
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
    return { released, store: createPostgresTrafficReleaseStore(pool) };
  };

  it('destroys a connection whose rollback cannot be confirmed', async () => {
    const { released, store } = failingClient('fails');
    await expect(store.publishEpoch(NEXT_TICK, [])).rejects.toThrow(/lock timeout/);
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('returns a connection to the pool once its rollback is confirmed', async () => {
    const { released, store } = failingClient('succeeds');
    await expect(store.publishEpoch(NEXT_TICK, [])).rejects.toThrow(/lock timeout/);
    expect(released).toEqual([undefined]);
  });

  it('bounds statements and lock waits on the server, not only in the client', () => {
    expect(TRAFFIC_POOL_CONFIG.statement_timeout).toBeLessThan(TRAFFIC_POOL_CONFIG.query_timeout);
    expect(TRAFFIC_POOL_CONFIG.lock_timeout).toBeLessThan(TRAFFIC_POOL_CONFIG.statement_timeout);
  });
});

describe('walking real Alberta/BC routes', () => {
  interface RecordedWalk {
    distanceMeters: number;
    geometry: Position[];
    name: string;
    responses: unknown[];
  }
  const recorded = JSON.parse(
    readFileSync(new URL('./fixtures/valhalla-walks-alberta-bc.json', import.meta.url), 'utf8'),
  ) as { routes: RecordedWalk[] };

  it.each(recorded.routes.map((route) => [route.name, route] as const))(
    'walks %s',
    async (_name, route) => {
      let call = 0;
      const matcher = createValhallaMapMatcher({
        endpoint: 'http://valhalla.test/trace_attributes',
        fetchImplementation: () => {
          const answer = route.responses[call];
          call += 1;
          return Promise.resolve(Response.json(answer));
        },
      });
      // Valhalla repeated the last vertex of every chunk that ended part-way along an edge, and
      // once added a zero-length edge; the walk once failed on all of them, so no route longer
      // than 100 km (and many short ones) could carry traffic or be re-ranked.
      const edges = present(await matcher.walkRoute(route.geometry));

      expect(call).toBe(route.responses.length);
      expect(edges[0]?.beginShapeIndex).toBe(0);
      expect(edges.at(-1)?.endShapeIndex).toBe(route.geometry.length - 1);
      edges.forEach((edge, index) => {
        if (index > 0) expect(edge.beginShapeIndex).toBe(edges[index - 1]?.endShapeIndex);
        // Each edge's line is the route's own geometry between its indexes.
        expect(edge.line).toEqual(
          route.geometry.slice(edge.beginShapeIndex, edge.endShapeIndex + 1),
        );
      });
      const meters = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
      expect(Math.abs(meters - route.distanceMeters)).toBeLessThan(route.distanceMeters * 0.002);
    },
  );

  it('refuses a walk whose vertices are not the route geometry', async () => {
    const [route] = recorded.routes.filter(({ responses }) => responses.length === 1);
    const shifted = present(route).geometry.map(([longitude, latitude], index): Position =>
      index === 10 ? [longitude + 0.0001, latitude] : [longitude, latitude],
    );
    const matcher = createValhallaMapMatcher({
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: () => Promise.resolve(Response.json(present(route).responses[0])),
    });
    expect(await matcher.walkRoute(shifted)).toBeUndefined();
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
