import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  AppConfigResponseSchema,
  LegacyAppConfigResponseSchema,
  ProblemDetailsSchema,
  RouteTrafficAnnotationSchema,
  snapTrafficFlowBounds,
  TrafficCredentialResponseSchema,
  TrafficFlowResponseSchema,
  TrafficStatusResponseSchema,
  type TrafficProbeBatchRequest,
} from '@navoss/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { createCommunityReportService } from '../src/community-reports.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import {
  createConfiguredTrafficService,
  createTrafficService,
  type TrafficAttestation,
  type TrafficMetrics,
  type TrafficService,
} from '../src/traffic/service.js';
import type { DeadEndMaskWays } from '../src/traffic/dead-end-mask.js';
import { decodePolyline6 } from '../src/traffic/geo.js';
import { createValhallaMapMatcher, type MapMatcher } from '../src/traffic/map-matcher.js';
import { edgeSegmentKey } from '../src/traffic/segments.js';
import { DEFAULT_TRAFFIC_SETTINGS, type TrafficSettings } from '../src/traffic/settings.js';
import {
  createInMemoryTrafficReleaseStore,
  type TrafficReleaseStore,
} from '../src/traffic/store.js';
import {
  assertionFor,
  credentialFor,
  DRIVE,
  driveBatch,
  fakeAttestation,
  FIXTURE_SETTINGS,
  isFixtureTrafficCoordinate,
  JAMMED_GAPS,
  NOW,
  requestUrl,
  stubbedMatcher,
  type StubbedMatcher,
} from './traffic-fixture.js';
import { mixedWay, writeServingGraph } from './serving-graph-fixture.js';

const apps: FastifyInstance[] = [];
const FLOW_URL = '/v2/traffic/flow?bbox=9.45,47.10,9.60,47.20';
const EPOCH_MS = 300_000;

interface TrafficApp {
  /** Moves the clock to just after the next epoch boundary and closes the epoch. */
  advanceEpoch(): Promise<void>;
  app: FastifyInstance;
  service: TrafficService;
  setClock(ms: number): void;
  stub: StubbedMatcher;
  /** Uploads the fixture drive as `device`, optionally from a given network address. */
  upload(
    device: string,
    gaps?: readonly number[],
    address?: string,
  ): Promise<LightMyRequestResponse>;
}

async function createTrafficApp(
  settings: Partial<TrafficSettings> = {},
  attestation: TrafficAttestation | null = fakeAttestation(),
  store?: TrafficReleaseStore,
  startMs = NOW.getTime(),
): Promise<TrafficApp> {
  let nowMs = startMs;
  const clock = (): Date => new Date(nowMs);
  const stub = stubbedMatcher();
  const service = createTrafficService({
    isInCoverage: isFixtureTrafficCoordinate,
    attestation: attestation ?? undefined,
    clock,
    mapMatcher: stub.matcher,
    settings: { ...FIXTURE_SETTINGS, ...settings },
    ...(store === undefined ? {} : { store }),
  });
  const app = await buildApp({
    clock,
    communityReports: null,
    searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
    trafficService: service,
  });
  apps.push(app);
  return {
    async advanceEpoch() {
      nowMs = (Math.floor(nowMs / EPOCH_MS) + 1) * EPOCH_MS + 5_000;
      await service.runEpoch();
    },
    app,
    service,
    setClock(ms) {
      nowMs = ms;
    },
    stub,
    async upload(device, gaps, address = '198.51.100.1') {
      // The batch claims a start five minutes before whatever the clock says now.
      const capturedAt = new Date(Math.floor(nowMs / 60_000) * 60_000 - 300_000).toISOString();
      return app.inject({
        headers: { 'x-forwarded-for': address },
        method: 'POST',
        payload: driveBatch(await credentialFor(service, device), gaps, capturedAt),
        url: '/v2/traffic/probes',
      });
    },
  };
}

async function flow(app: FastifyInstance) {
  const response = await app.inject(FLOW_URL);
  expect(response.statusCode).toBe(200);
  return { body: response.body, flow: TrafficFlowResponseSchema.parse(response.json()), response };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('community traffic over HTTP', () => {
  it('publishes flow only for three attested installations, and only at an epoch boundary', async () => {
    const traffic = await createTrafficApp();

    for (const device of ['phone-1', 'phone-2']) {
      const response = await traffic.upload(device);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: 'accepted' });
    }
    // The third contributor arrives, and still nothing changes until the epoch closes.
    expect((await traffic.upload('phone-3')).statusCode).toBe(202);
    // Nothing was published in the epoch the process started in: unavailable, not empty.
    expect((await traffic.app.inject(FLOW_URL)).statusCode).toBe(503);

    await traffic.advanceEpoch();
    const after = await flow(traffic.app);

    expect(after.response.headers['cache-control']).toBe('public, max-age=30');
    expect(after.flow.source).toEqual({
      attribution: 'Traffic from opted-in NavOSS drivers',
      id: 'navoss-community',
    });
    expect(after.flow.coverage).toEqual({ minimumContributors: 3, truncated: false });
    expect(after.flow.generatedAt).toBe('2026-11-12T18:05:00.000Z');
    expect(after.flow.features.length).toBeGreaterThan(10);
    for (const feature of after.flow.features) {
      expect(feature.properties).toEqual({
        congestion: 'free',
        freeFlowKph: 51,
        // The epoch boundary that released the value, not the moment of any upload or request.
        observedAt: '2026-11-12T18:05:00.000Z',
        speedKph: 40,
      });
    }
  });

  it('never answers with another body under an epoch that was already published', async () => {
    const store = createInMemoryTrafficReleaseStore();
    const first = await createTrafficApp({}, fakeAttestation(), store);
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await first.upload(device);
    await first.advanceEpoch();
    const published = await flow(first.app);
    expect(published.flow.features.length).toBeGreaterThan(10);
    const epochMs = Date.parse(published.flow.generatedAt);

    // The API restarts within that epoch, against the same storage: it erases the releases on
    // start and has nothing published for this epoch, so it answers 503, never an empty body
    // labelled with the epoch the old process published.
    const restarted = await createTrafficApp({}, fakeAttestation(), store, epochMs + 60_000);
    const during = await restarted.app.inject(FLOW_URL);
    expect(during.statusCode).toBe(503);
    // At the next boundary it publishes that epoch: legitimately empty, under a new label.
    await restarted.advanceEpoch();
    const next = await flow(restarted.app);
    expect(next.flow.generatedAt).toBe(new Date(epochMs + EPOCH_MS).toISOString());
    expect(next.flow.features).toEqual([]);
    expect((await flow(restarted.app)).body).toBe(next.body);
  });

  it('answers 503 when storage loses the published snapshot within its epoch', async () => {
    const store = createInMemoryTrafficReleaseStore();
    const traffic = await createTrafficApp({}, fakeAttestation(), store);
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    await traffic.advanceEpoch();
    expect((await flow(traffic.app)).flow.features.length).toBeGreaterThan(10);
    // What a database crash does to the unlogged tables.
    await store.purge();
    expect((await traffic.app.inject(FLOW_URL)).statusCode).toBe(503);
    const route = { ...DRIVE.route, label: 'fastest' as const };
    expect((await traffic.service.enrichRoutes([route])).routes).toEqual([route]);
  });

  it('counts one installation once, whatever network or credential it uploads with', async () => {
    const traffic = await createTrafficApp();

    await traffic.upload('phone-1', undefined, '198.51.100.1');
    await traffic.upload('phone-2', undefined, '198.51.100.1');
    // The same phone on Wi-Fi, on cellular, through a VPN, each time with a fresh credential.
    for (const address of ['203.0.113.9', '2001:db8:aa:1::5', '192.0.2.77']) {
      expect((await traffic.upload('phone-2', JAMMED_GAPS, address)).statusCode).toBe(202);
    }
    await traffic.advanceEpoch();
    expect((await flow(traffic.app)).flow.features).toEqual([]);
    expect(traffic.service.metrics().pendingSamples).toBe(
      2 * traffic.service.metrics().pendingSegments,
    );

    // Three different installations behind one shared network address do count.
    await traffic.upload('phone-3', undefined, '198.51.100.1');
    await traffic.advanceEpoch();
    expect((await flow(traffic.app)).flow.features.length).toBeGreaterThan(10);
  });

  it('serves one unchanging snapshot per epoch, however many batches arrive during it', async () => {
    const traffic = await createTrafficApp();
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    await traffic.advanceEpoch();
    const published = (await flow(traffic.app)).body;

    // A fourth, crawling driver, a repeat, and the passage of time inside the epoch.
    await traffic.upload('phone-4', JAMMED_GAPS);
    await traffic.upload('phone-1', JAMMED_GAPS);
    expect((await flow(traffic.app)).body).toBe(published);
    traffic.setClock(Date.parse('2026-11-12T18:09:59Z'));
    expect((await flow(traffic.app)).body).toBe(published);

    // At the next boundary the single new contributor still changes nothing but the epoch times.
    await traffic.advanceEpoch();
    const next = await flow(traffic.app);
    expect(next.flow.generatedAt).toBe('2026-11-12T18:10:00.000Z');
    expect(next.flow.features).toEqual(
      TrafficFlowResponseSchema.parse(JSON.parse(published)).features,
    );
  });

  it('never labels the previous contents as a new epoch, when read before the epoch job runs', async () => {
    const traffic = await createTrafficApp();
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);

    // 0.2 s after the boundary. The timer runs a second after it; nothing has published yet, and
    // the read is not preceded by runEpoch().
    traffic.setClock(Date.parse('2026-11-12T18:05:00.200Z'));
    const first = await flow(traffic.app);
    expect(first.flow.generatedAt).toBe('2026-11-12T18:05:00.000Z');
    expect(first.flow.validUntil).toBe('2026-11-12T18:10:00.000Z');
    expect(first.flow.features.length).toBeGreaterThan(10);

    // The epoch job running afterwards does not change what this epoch already served.
    traffic.setClock(Date.parse('2026-11-12T18:05:01.000Z'));
    await traffic.service.runEpoch();
    expect((await flow(traffic.app)).body).toBe(first.body);
  });

  it('makes readers of an epoch wait for its publication, however slow the store is', async () => {
    const memory = createInMemoryTrafficReleaseStore();
    // The store finishes writing only when the test opens the gate.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const store: TrafficReleaseStore = {
      ...memory,
      async publishEpoch(epochStartMs, releases) {
        await gate;
        await memory.publishEpoch(epochStartMs, releases);
      },
    };
    const traffic = await createTrafficApp({}, fakeAttestation(), store);
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    traffic.setClock(Date.parse('2026-11-12T18:05:01Z'));

    // The epoch job and two readers start while the store is still writing.
    const job = traffic.service.runEpoch();
    let answered = 0;
    const readers = [traffic.app.inject(FLOW_URL), traffic.app.inject(FLOW_URL)].map((reading) =>
      reading.then((response) => {
        answered += 1;
        return response;
      }),
    );
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(answered).toBe(0);

    openGate();
    await job;
    const bodies = await Promise.all(readers);
    for (const response of bodies) {
      const body = TrafficFlowResponseSchema.parse(response.json());
      expect(body.generatedAt).toBe('2026-11-12T18:05:00.000Z');
      expect(body.features.length).toBeGreaterThan(10);
    }
    expect(bodies[0]?.body).toBe(bodies[1]?.body);
  });

  it('never answers with an epoch the clock passed while the read was waiting', async () => {
    const memory = createInMemoryTrafficReleaseStore();
    // The first flow read waits until the test opens the gate; later reads do not.
    const { promise: gate, resolve: openGate } = Promise.withResolvers<undefined>();
    let held = false;
    const store: TrafficReleaseStore = {
      ...memory,
      async inBounds(bounds, epochStartMs, limit) {
        if (!held) {
          held = true;
          await gate;
        }
        return memory.inBounds(bounds, epochStartMs, limit);
      },
    };
    const traffic = await createTrafficApp({}, fakeAttestation(), store);
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    traffic.setClock(Date.parse('2026-11-12T18:05:01Z'));
    await traffic.service.runEpoch();

    // The read of the 18:05 snapshot is still waiting on the store when the clock passes 18:10.
    // Nothing else runs the epoch job or reads in between.
    const reading = traffic.app.inject(FLOW_URL);
    await vi.waitFor(() => {
      expect(held).toBe(true);
    });
    traffic.setClock(Date.parse('2026-11-12T18:10:01Z'));
    openGate(undefined);
    const response = await reading;
    expect(response.statusCode).toBe(200);
    const body = TrafficFlowResponseSchema.parse(response.json());
    // Not the 18:05 snapshot, already expired at 18:10: the read was repeated against 18:10.
    expect(body.generatedAt).toBe('2026-11-12T18:10:00.000Z');
    expect(body.validUntil).toBe('2026-11-12T18:15:00.000Z');
    // And that is the one body the 18:10 epoch serves.
    expect((await flow(traffic.app)).body).toBe(response.body);
  });

  it('answers 503 rather than serve an epoch whose publication failed', async () => {
    const memory = createInMemoryTrafficReleaseStore();
    let failing = true;
    const store: TrafficReleaseStore = {
      ...memory,
      publishEpoch: (epochStartMs, releases) =>
        failing
          ? Promise.reject(new Error('storage is down'))
          : memory.publishEpoch(epochStartMs, releases),
    };
    const traffic = await createTrafficApp({}, fakeAttestation(), store);
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    traffic.setClock(Date.parse('2026-11-12T18:05:01Z'));

    expect((await traffic.app.inject(FLOW_URL)).statusCode).toBe(503);
    expect(traffic.service.metrics().epochFailures).toBe(1);

    // The released values are offered again at the next boundary and are served from there,
    // still with the boundary that released them and their original expiry.
    failing = false;
    traffic.setClock(Date.parse('2026-11-12T18:10:01Z'));
    const recovered = await flow(traffic.app);
    expect(recovered.flow.generatedAt).toBe('2026-11-12T18:10:00.000Z');
    expect(recovered.flow.features.length).toBeGreaterThan(10);
    for (const feature of recovered.flow.features) {
      expect(feature.properties.observedAt).toBe('2026-11-12T18:05:00.000Z');
    }
    traffic.setClock(Date.parse('2026-11-12T18:20:01Z'));
    expect((await flow(traffic.app)).flow.features).toEqual([]);
  });

  it('takes a published value down on schedule when no new cohort replaces it', async () => {
    const traffic = await createTrafficApp();
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    await traffic.advanceEpoch();

    traffic.setClock(Date.parse('2026-11-12T18:19:59Z'));
    expect((await flow(traffic.app)).flow.features.length).toBeGreaterThan(10);
    // 15 minutes after release, before the timer runs: the read completes that boundary first.
    traffic.setClock(Date.parse('2026-11-12T18:20:00Z'));
    expect((await flow(traffic.app)).flow.features).toEqual([]);
  });

  it('shows a jam where most contributors crawled and a clear road elsewhere', async () => {
    const traffic = await createTrafficApp();
    await traffic.upload('phone-1');
    await traffic.upload('phone-2', JAMMED_GAPS);
    await traffic.upload('phone-3', JAMMED_GAPS);
    await traffic.advanceEpoch();

    const { features } = (await flow(traffic.app)).flow;
    const levels = new Set(features.map(({ properties }) => properties.congestion));

    expect(levels.has('free')).toBe(true);
    expect(levels.has('heavy')).toBe(true);
    for (const { properties } of features.filter((f) => f.properties.congestion === 'heavy')) {
      expect(properties.speedKph).toBeLessThan(23);
    }
  });

  it('reports rules but no totals in status, so uploads cannot be observed through it', async () => {
    const traffic = await createTrafficApp();
    const read = async () => {
      const response = await traffic.app.inject('/v2/traffic/status');
      expect(response.headers['cache-control']).toBe('public, max-age=60');
      return TrafficStatusResponseSchema.parse(response.json());
    };
    const before = await read();

    expect(before).toEqual({
      generatedAt: '2026-11-12T18:00:30.000Z',
      mode: 'live',
      probes: {
        accepting: true,
        batchTargetMeters: 600,
        batchTargetSeconds: 60,
        batchTrimMeters: 100,
        credentialEndpoint: '/v2/traffic/credentials',
        endpoint: '/v2/traffic/probes',
        maxBatchSeconds: 300,
        maxGapSeconds: 15,
        maxPoints: 240,
        minPoints: 10,
        sampleIntervalSeconds: 2,
        schemaVersion: 1,
        tripEndTrimMeters: 400,
      },
      publication: {
        cohortSeconds: 900,
        epochSeconds: 300,
        minimumContributors: 3,
        releaseSeconds: 900,
      },
      source: { attribution: 'Traffic from opted-in NavOSS drivers', id: 'navoss-community' },
    });

    // One upload onto an unobserved road, a second onto the same road, then a publication: the
    // status body never differs, so it cannot say whether a road was already driven.
    await traffic.upload('phone-1');
    expect(await read()).toEqual(before);
    await traffic.upload('phone-2');
    expect(await read()).toEqual(before);
    await traffic.upload('phone-3');
    await traffic.advanceEpoch();
    expect({ ...(await read()), generatedAt: before.generatedAt }).toEqual(before);
    // The operator still has the numbers, in process only.
    expect(traffic.service.metrics()).toMatchObject({ batchesAccepted: 3, pendingSamples: 0 });
    expect(traffic.service.metrics().segmentsReleased).toBeGreaterThan(10);
  });

  it('issues upload credentials only for a verified installation assertion', async () => {
    const traffic = await createTrafficApp();
    const request = (device: string) =>
      traffic.app.inject({
        method: 'POST',
        payload: { assertion: assertionFor(device) },
        url: '/v2/traffic/credentials',
      });

    const issued = await request('phone-1');
    expect(issued.statusCode).toBe(200);
    const { credential, expiresAt } = TrafficCredentialResponseSchema.parse(issued.json());
    expect(expiresAt).toBe('2026-11-12T20:00:30.000Z');
    expect(credential).not.toContain('phone-1');

    const unknown = await request('unregistered-phone');
    expect(unknown.statusCode).toBe(401);
    expect(ProblemDetailsSchema.parse(unknown.json()).code).toBe('unauthorized');
    // What the real service answers for a development key while attestation is enforced.
    const development = await request('development-simulator');
    expect(development.statusCode).toBe(403);
    expect(ProblemDetailsSchema.parse(development.json()).code).toBe('forbidden');

    const malformed = await traffic.app.inject({
      method: 'POST',
      payload: { assertion: { ...assertionFor('phone-1'), installationId: 'x' } },
      url: '/v2/traffic/credentials',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('refuses every upload that does not carry a valid credential', async () => {
    const traffic = await createTrafficApp();
    const post = (payload: unknown) =>
      traffic.app.inject({ method: 'POST', payload: payload as object, url: '/v2/traffic/probes' });
    const valid = driveBatch(await credentialFor(traffic.service, 'phone-1'));
    const anonymous = Object.fromEntries(
      Object.entries(valid).filter(([name]) => name !== 'credential'),
    );

    expect((await post(anonymous)).statusCode).toBe(400);
    const forged = await post({ ...valid, credential: 'A'.repeat(64) });
    expect(forged.statusCode).toBe(401);
    expect(ProblemDetailsSchema.parse(forged.json()).code).toBe('unauthorized');

    // Issued by another process (or before a restart): not accepted here.
    const other = createTrafficService({
      isInCoverage: isFixtureTrafficCoordinate,
      attestation: fakeAttestation(),
      clock: () => NOW,
      mapMatcher: stubbedMatcher().matcher,
      settings: FIXTURE_SETTINGS,
    });
    expect(
      (await post({ ...valid, credential: await credentialFor(other, 'phone-1') })).statusCode,
    ).toBe(401);

    // Expired two hours after issue.
    traffic.setClock(NOW.getTime() + 7_200_000);
    expect((await post(valid)).statusCode).toBe(401);
    expect(traffic.stub.requests).toEqual([]);
    expect(traffic.service.metrics()).toMatchObject({ batchesUnauthorized: 3, pendingSamples: 0 });
  });

  it('reports probes as not accepting when the report service has no App Attest verifier', async () => {
    // What production builds when PGHOST is set but the team id or installation secret is not:
    // the report service exists, but no assertion can be verified.
    const reports = createCommunityReportService({
      attestationMode: 'enforce',
      installationSecret: Buffer.alloc(32, 1),
      isInCoverage: () => true,
      pool: new Pool(),
      publication: 'shadow',
      verifier: undefined,
    });
    try {
      const traffic = await createTrafficApp({}, reports);
      const status = TrafficStatusResponseSchema.parse(
        (await traffic.app.inject('/v2/traffic/status')).json(),
      );
      const response = await traffic.app.inject({
        method: 'POST',
        payload: { assertion: assertionFor('phone-1') },
        url: '/v2/traffic/credentials',
      });

      expect(status.mode).toBe('live');
      expect(status.probes.accepting).toBe(false);
      expect(response.statusCode).toBe(503);
    } finally {
      await reports.close();
    }
  });

  it('admits no installation registered moments ago, and counts one newcomer per network', async () => {
    const traffic = await createTrafficApp();
    const refused = await traffic.app.inject({
      method: 'POST',
      payload: { assertion: assertionFor('fresh-phone') },
      url: '/v2/traffic/credentials',
    });
    expect(refused.statusCode).toBe(403);
    expect(ProblemDetailsSchema.parse(refused.json()).code).toBe('forbidden');
    // Registered an hour ago: a credential is available in the remaining 23 hours.
    expect(refused.headers['retry-after']).toBe('82800');

    // Three two-day-old keys behind one network, as one handset would have, and a fourth behind
    // another spelling of the same /48: one vote.
    for (const device of ['new-1', 'new-2', 'new-3']) {
      expect((await traffic.upload(device, undefined, '2001:db8:5::1')).statusCode).toBe(202);
    }
    await traffic.upload('new-4', undefined, '2001:db8:5:0:0::2');
    await traffic.advanceEpoch();
    expect((await flow(traffic.app)).flow.features).toEqual([]);

    // A newcomer elsewhere and an established installation complete the cohort with the first.
    await traffic.upload('new-5', undefined, '203.0.113.9');
    await traffic.upload('phone-1');
    await traffic.advanceEpoch();
    expect((await flow(traffic.app)).flow.features.length).toBeGreaterThan(10);
  });

  it('does not issue credentials or accept uploads when attestation is not configured', async () => {
    const traffic = await createTrafficApp({}, null);
    const status = TrafficStatusResponseSchema.parse(
      (await traffic.app.inject('/v2/traffic/status')).json(),
    );
    const response = await traffic.app.inject({
      method: 'POST',
      payload: { assertion: assertionFor('phone-1') },
      url: '/v2/traffic/credentials',
    });

    expect(status.mode).toBe('live');
    expect(status.probes.accepting).toBe(false);
    expect(response.statusCode).toBe(503);
  });

  it('rejects schema violations, extra fields and implausible batches', async () => {
    const traffic = await createTrafficApp();
    const credential = await credentialFor(traffic.service, 'phone-1');
    const post = (payload: unknown) =>
      traffic.app.inject({ method: 'POST', payload: payload as object, url: '/v2/traffic/probes' });

    expect((await post({ ...driveBatch(credential), deviceId: 'abc' })).statusCode).toBe(400);
    expect((await post({ ...driveBatch(credential), schemaVersion: 2 })).statusCode).toBe(400);
    const stale = await post(driveBatch(credential, undefined, '2026-11-12T17:40:00Z'));
    expect(stale.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(stale.json()).detail).toMatch(/too old/);
    // The start is within clock skew; the offsets reach three minutes past the server clock.
    const future = await post(driveBatch(credential, undefined, '2026-11-12T18:00:00Z'));
    expect(future.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(future.json()).detail).toMatch(/future/);
    expect(traffic.stub.requests).toEqual([]);
  });

  it('never counts a batch toward a later epoch than the one it arrived in', async () => {
    const traffic = await createTrafficApp();
    // Dated as late as the skew allowance permits.
    const response = await traffic.app.inject({
      method: 'POST',
      payload: driveBatch(
        await credentialFor(traffic.service, 'phone-1'),
        undefined,
        '2026-11-12T17:57:00Z',
      ),
      url: '/v2/traffic/probes',
    });
    expect(response.statusCode).toBe(202);
    await traffic.upload('phone-2');
    await traffic.upload('phone-3');

    // All three are in the 18:00 epoch and are released together at 18:05.
    await traffic.advanceEpoch();
    expect((await flow(traffic.app)).flow.features.length).toBeGreaterThan(10);
    expect(traffic.service.metrics().pendingSamples).toBe(0);
  });

  it('limits each installation, and a network cannot rotate IPv6 addresses for a new quota', async () => {
    const perContributor = await createTrafficApp({ rateLimitPerContributor: 2 });
    expect((await perContributor.upload('phone-1', undefined, '198.51.100.1')).statusCode).toBe(
      202,
    );
    expect((await perContributor.upload('phone-1', undefined, '203.0.113.5')).statusCode).toBe(202);
    const limited = await perContributor.upload('phone-1', undefined, '192.0.2.9');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('600');
    // Another installation on the same network is unaffected.
    expect((await perContributor.upload('phone-2', undefined, '198.51.100.1')).statusCode).toBe(
      202,
    );

    const perNetwork = await createTrafficApp({ rateLimitPerNetwork: 2 });
    expect((await perNetwork.upload('a', undefined, '2001:db8:12:3400::1')).statusCode).toBe(202);
    expect((await perNetwork.upload('b', undefined, '2001:db8:12:3400:a1b2::2')).statusCode).toBe(
      202,
    );
    // A third address in the same /64, and one in a sibling /64 of the same /48.
    expect((await perNetwork.upload('c', undefined, '2001:db8:12:3400:ffff::3')).statusCode).toBe(
      429,
    );
    expect((await perNetwork.upload('d', undefined, '2001:db8:12:99::4')).statusCode).toBe(429);
    expect((await perNetwork.upload('e', undefined, '2001:db8:13::5')).statusCode).toBe(202);
  });

  it('limits how many credentials one network can request', async () => {
    const traffic = await createTrafficApp();
    const request = (device: string, address: string) =>
      traffic.app.inject({
        headers: { 'x-forwarded-for': address },
        method: 'POST',
        payload: { assertion: assertionFor(device) },
        url: '/v2/traffic/credentials',
      });

    for (let index = 0; index < 120; index += 1) {
      // Addresses spread over one IPv4 /24.
      const response = await request(`phone-${String(index)}`, `198.51.100.${String(index)}`);
      expect(response.statusCode).toBe(200);
    }
    const limited = await request('phone-120', '198.51.100.200');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('600');
    expect((await request('phone-121', '198.51.101.1')).statusCode).toBe(200);
    expect(traffic.service.metrics().credentialsIssued).toBe(121);
  });

  it('does not let uploads without a credential use up the shared quota', async () => {
    const traffic = await createTrafficApp({ rateLimitGlobal: 2 });
    const junk = driveBatch('A'.repeat(64));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await traffic.app.inject({
        headers: { 'x-forwarded-for': `203.0.113.${String(attempt)}` },
        method: 'POST',
        payload: junk,
        url: '/v2/traffic/probes',
      });
      expect(response.statusCode).toBe(401);
    }

    expect((await traffic.upload('phone-1')).statusCode).toBe(202);
    expect((await traffic.upload('phone-2')).statusCode).toBe(202);
    expect((await traffic.upload('phone-3')).statusCode).toBe(429);
  });

  it('sheds probe load while a match is in flight instead of queueing behind routing', async () => {
    const stub = stubbedMatcher();
    let finishMatch: () => void = () => undefined;
    const matchHeld = new Promise<void>((resolve) => {
      finishMatch = resolve;
    });
    const service = createTrafficService({
      isInCoverage: isFixtureTrafficCoordinate,
      attestation: fakeAttestation(),
      clock: () => NOW,
      mapMatcher: {
        async matchTrace(points) {
          await matchHeld;
          return stub.matcher.matchTrace(points);
        },
        walkRoute: (geometry) => stub.matcher.walkRoute(geometry),
      },
      settings: FIXTURE_SETTINGS,
    });
    const first = service.ingest(driveBatch(await credentialFor(service, 'phone-1')));
    const second = await service.ingest(driveBatch(await credentialFor(service, 'phone-2')));

    expect(second).toEqual({ status: 'unavailable' });
    finishMatch();
    expect(await first).toEqual({ status: 'accepted' });
    await service.close();
  });

  it('answers 503 for uploads, credentials and flow while off, and keeps flow unpublished while collecting', async () => {
    const off = await createTrafficApp({ mode: 'off' });
    const refused = await off.app.inject({
      method: 'POST',
      payload: driveBatch('A'.repeat(64)),
      url: '/v2/traffic/probes',
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('300');
    expect(
      (
        await off.app.inject({
          method: 'POST',
          payload: { assertion: assertionFor('phone-1') },
          url: '/v2/traffic/credentials',
        })
      ).statusCode,
    ).toBe(503);
    expect((await off.app.inject(FLOW_URL)).statusCode).toBe(503);
    const offStatus = TrafficStatusResponseSchema.parse(
      (await off.app.inject('/v2/traffic/status')).json(),
    );
    expect(offStatus.mode).toBe('off');
    expect(offStatus.probes.accepting).toBe(false);

    const collecting = await createTrafficApp({ mode: 'collect' });
    for (const device of ['phone-1', 'phone-2', 'phone-3']) {
      expect((await collecting.upload(device)).statusCode).toBe(202);
    }
    await collecting.advanceEpoch();
    expect((await collecting.app.inject(FLOW_URL)).statusCode).toBe(503);
    // Cohorts were counted for the operator and thrown away, not kept for later publication.
    expect(collecting.service.metrics().segmentsReleased).toBeGreaterThan(10);
    expect(collecting.service.metrics().pendingSamples).toBe(0);
    const status = TrafficStatusResponseSchema.parse(
      (await collecting.app.inject('/v2/traffic/status')).json(),
    );
    expect(status.mode).toBe('collecting');
    expect(status.probes.accepting).toBe(true);
    const config = AppConfigResponseSchema.parse(
      (await collecting.app.inject('/v2/config')).json(),
    );
    expect(config.features.liveTraffic).toBe(false);
  });

  it('rejects flow boxes that are off the grid or too large', async () => {
    const { app } = await createTrafficApp();

    expect((await app.inject('/v2/traffic/flow?bbox=9.451,47.10,9.60,47.20')).statusCode).toBe(400);
    expect((await app.inject('/v2/traffic/flow?bbox=5.00,45.00,9.60,47.20')).statusCode).toBe(400);
    expect((await app.inject('/v2/traffic/flow')).statusCode).toBe(400);
  });

  it('claims live traffic in v2 config only, leaving the frozen v1 config unchanged', async () => {
    const { app } = await createTrafficApp();
    const v2 = AppConfigResponseSchema.parse((await app.inject('/v2/config')).json());
    const v1 = LegacyAppConfigResponseSchema.parse((await app.inject('/v1/config')).json());

    expect(v2.features.liveTraffic).toBe(true);
    expect(v1.features.liveTraffic).toBe(false);
  });

  it('starts only against a local matcher endpoint', () => {
    const start = (environment: Record<string, string>) =>
      createConfiguredTrafficService({}, { COMMUNITY_TRAFFIC_MODE: 'collect', ...environment });

    expect(() => start({})).toThrow(/self-hosted Valhalla/);
    for (const url of [
      'https://valhalla1.openstreetmap.de/route',
      'https://valhalla1.openstreetmap.de./route',
      'https://routing.example.org/route',
    ]) {
      expect(() => start({ VALHALLA_URL: url })).toThrow(/self-hosted Valhalla/);
      expect(() =>
        start({ VALHALLA_TRACE_URL: url, VALHALLA_URL: 'http://valhalla:8002/route' }),
      ).toThrow(/self-hosted Valhalla/);
    }
    expect(start({ VALHALLA_URL: 'http://valhalla:8002/route' }).mode).toBe('collect');
    // Off needs no matcher at all.
    expect(createConfiguredTrafficService({}, {}).mode).toBe('off');
  });

  it('fails startup on a purge failure when enabled, and only reports it when off', async () => {
    const build = (mode: TrafficSettings['mode']) => {
      const failures: string[] = [];
      const service = createTrafficService({
        isInCoverage: isFixtureTrafficCoordinate,
        attestation: fakeAttestation(),
        mapMatcher: stubbedMatcher().matcher,
        onMaintenanceFailure: (failure) => failures.push(failure),
        settings: { ...FIXTURE_SETTINGS, mode },
        store: {
          byKeys: () => Promise.resolve([]),
          close: () => Promise.resolve(),
          inBounds: () => Promise.resolve({ releases: [], truncated: false }),
          publishEpoch: () => Promise.resolve(),
          purge: () => Promise.reject(new Error('storage is down')),
          ready: () => Promise.resolve(),
        },
      });
      return { failures, service };
    };

    const off = build('off');
    await expect(off.service.start()).resolves.toBeUndefined();
    expect(off.failures).toEqual(['purge']);
    expect(off.service.metrics().purgeFailures).toBe(1);
    const live = build('live');
    await expect(live.service.start()).rejects.toThrow('storage is down');
    expect(live.failures).toEqual(['purge']);
    await Promise.all([off.service.close(), live.service.close()]);
  });

  it('keeps retrying a failed purge while off until the releases are deleted', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      let attempts = 0;
      const failures: string[] = [];
      const memory = createInMemoryTrafficReleaseStore();
      const service = createTrafficService({
        attestation: fakeAttestation(),
        onMaintenanceFailure: (failure) => failures.push(failure),
        settings: { ...FIXTURE_SETTINGS, mode: 'off' },
        store: {
          ...memory,
          purge: () => {
            attempts += 1;
            // The database is unreachable for the first two attempts.
            return attempts < 3 ? Promise.reject(new Error('storage is down')) : memory.purge();
          },
        },
      });
      await service.start();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(3);
      expect(failures).toEqual(['purge', 'purge']);
      expect(service.metrics().purgeFailures).toBe(2);

      // Once a purge has succeeded nothing more is attempted.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(attempts).toBe(3);
      await service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a database that never answers hold up startup while off', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const build = (mode: TrafficSettings['mode']) => {
        const failures: string[] = [];
        let failPurge: (error: Error) => void = () => undefined;
        const service = createTrafficService({
          isInCoverage: isFixtureTrafficCoordinate,
          attestation: fakeAttestation(),
          mapMatcher: stubbedMatcher().matcher,
          onMaintenanceFailure: (failure) => failures.push(failure),
          settings: { ...FIXTURE_SETTINGS, mode },
          store: {
            byKeys: () => Promise.resolve([]),
            close: () => Promise.resolve(),
            inBounds: () => Promise.resolve({ releases: [], truncated: false }),
            publishEpoch: () => Promise.resolve(),
            // Neither succeeds nor fails until the test says so.
            purge: () =>
              new Promise<void>((_resolve, reject) => {
                failPurge = reject;
              }),
            ready: () => Promise.resolve(),
          },
        });
        let state: 'failed' | 'pending' | 'started' = 'pending';
        const started = service.start().then(
          () => {
            state = 'started';
          },
          () => {
            state = 'failed';
          },
        );
        return {
          failPurge: (error: Error) => {
            failPurge(error);
          },
          failures,
          service,
          started,
          state: () => state,
        };
      };

      const off = build('off');
      const live = build('live');
      await vi.advanceTimersByTimeAsync(2_999);
      expect(off.state()).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      // Off: the API starts without the purge. Enabled: it keeps waiting for its storage.
      expect(off.state()).toBe('started');
      expect(live.state()).toBe('pending');
      expect(off.failures).toEqual([]);

      // When the purge does fail later, it is still reported.
      off.failPurge(new Error('connection timed out'));
      live.failPurge(new Error('connection timed out'));
      await Promise.all([off.started, live.started]);
      expect(off.failures).toEqual(['purge']);
      expect(live.state()).toBe('failed');
      expect(live.failures).toEqual(['purge']);
      await Promise.all([off.service.close(), live.service.close()]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed purge to the operator log and still starts when off', async () => {
    const logLines: string[] = [];
    const previous = { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT };
    // A database that refuses connections.
    process.env.PGHOST = '127.0.0.1';
    process.env.PGPORT = '1';
    try {
      const app = await buildApp({
        communityReports: null,
        contributionProvider: { submit: () => Promise.reject(new Error('unused')) },
        googlePlaceQueryBudget: { reserve: () => Promise.reject(new Error('unused')) },
        logger: {
          level: 'info',
          stream: new Writable({
            write(chunk: Buffer, _encoding, done) {
              logLines.push(chunk.toString('utf8'));
              done();
            },
          }),
        },
        searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
      });
      apps.push(app);
      await app.ready();
    } finally {
      if (previous.PGHOST === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = previous.PGHOST;
      if (previous.PGPORT === undefined) delete process.env.PGPORT;
      else process.env.PGPORT = previous.PGPORT;
    }

    const failure = logLines
      .map((line) => JSON.parse(line) as { failure?: string; msg?: string })
      .find(({ msg }) => msg === 'Community traffic maintenance failed');
    expect(failure?.failure).toBe('purge');
  });

  it('documents the traffic endpoints in OpenAPI', async () => {
    const { app } = await createTrafficApp();
    const document = (await app.inject('/openapi.json')).json<{
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    }>();
    const statuses = (path: string, method: string) =>
      Object.keys(document.paths[path]?.[method]?.responses ?? {}).sort();

    // Every status the route's validation and handler can produce, and none they cannot.
    expect(statuses('/v2/traffic/credentials', 'post')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '429',
      '503',
    ]);
    expect(statuses('/v2/traffic/probes', 'post')).toEqual(['202', '400', '401', '429', '503']);
    expect(statuses('/v2/traffic/flow', 'get')).toEqual(['200', '400', '503']);
    expect(statuses('/v2/traffic/status', 'get')).toEqual(['200']);
    // The routes of the first draft of this feature never shipped and are not served.
    expect(Object.keys(document.paths).filter((path) => path.startsWith('/v1/traffic'))).toEqual(
      [],
    );
  });
});

describe('route traffic enrichment', () => {
  const route = { ...DRIVE.route, label: 'fastest' as const };
  const unwalkable = {
    ...DRIVE.route,
    durationSeconds: DRIVE.route.durationSeconds + 10,
    geometry: DRIVE.route.geometry.slice(0, -1),
    id: 'unwalkable',
    label: 'alternative' as const,
  };

  async function jammedService(settings: Partial<TrafficSettings> = {}) {
    // Edges under 20 m and edges the graph does not confirm as open through roads are never
    // published, so a little under 40% of this route can carry traffic.
    const traffic = await createTrafficApp({ routeMinCoverage: 0.35, ...settings });
    for (const device of ['phone-1', 'phone-2', 'phone-3']) {
      await traffic.upload(device, JAMMED_GAPS);
    }
    await traffic.advanceEpoch();
    traffic.stub.requests.length = 0;
    return traffic;
  }

  it('adds delay, congestion and step durations to a route crossing a published jam', async () => {
    const { service } = await jammedService();
    const result = await service.enrichRoutes([route]);
    const enriched = result.routes[0];

    expect(result.trafficSource).toEqual({
      attribution: 'Traffic from opted-in NavOSS drivers',
      id: 'navoss-community',
    });
    expect(enriched?.traffic?.typicalDurationSeconds).toBe(route.durationSeconds);
    expect(enriched?.traffic?.delaySeconds).toBeGreaterThan(20);
    expect(enriched?.traffic?.observedFraction).toBeGreaterThanOrEqual(0.35);
    expect(enriched?.durationSeconds).toBeCloseTo(
      route.durationSeconds + (enriched?.traffic?.delaySeconds ?? 0),
      3,
    );
    expect(enriched?.congestion).toHaveLength(route.geometry.length - 1);
    expect(new Set(enriched?.congestion)).toEqual(new Set(['unknown', 'free', 'slow', 'heavy']));
    // The first and last 400 m were never uploaded, so the route's ends stay unknown.
    expect(enriched?.congestion?.[0]).toBe('unknown');
    expect(enriched?.congestion?.at(-1)).toBe('unknown');
    const stepTotal = enriched?.steps.reduce((sum, step) => sum + step.durationSeconds, 0) ?? 0;
    expect(stepTotal).toBeCloseTo(enriched?.durationSeconds ?? 0, 0);
    expect(
      RouteTrafficAnnotationSchema.safeParse({
        congestion: enriched?.congestion,
        delaySeconds: enriched?.traffic?.delaySeconds,
        durationSeconds: enriched?.durationSeconds,
        observedFraction: enriched?.traffic?.observedFraction,
        stepDurationsSeconds: enriched?.steps.map((step) => step.durationSeconds),
        typicalDurationSeconds: enriched?.traffic?.typicalDurationSeconds,
      }).success,
    ).toBe(true);
  });

  it('reads every speed of a route from one epoch, even when the walk spans a boundary', async () => {
    let nowMs = NOW.getTime();
    const stub = stubbedMatcher();
    const service = createTrafficService({
      attestation: fakeAttestation(),
      clock: () => new Date(nowMs),
      // The recorded drive is in Liechtenstein, outside the provincial service coverage.
      isInCoverage: isFixtureTrafficCoordinate,
      mapMatcher: {
        matchTrace: (points) => stub.matcher.matchTrace(points),
        // Walking the route takes until after the next boundary.
        walkRoute: async (geometry) => {
          const edges = await stub.matcher.walkRoute(geometry);
          nowMs = Date.parse('2026-11-12T18:10:05Z');
          return edges;
        },
      },
      settings: { ...FIXTURE_SETTINGS, routeMinCoverage: 0.35 },
    });
    const upload = async (device: string, gaps?: readonly number[]) => {
      const capturedAt = new Date(Math.floor(nowMs / 60_000) * 60_000 - 300_000).toISOString();
      // A batch refused here (for example as outside coverage) would leave nothing to read.
      expect(
        await service.ingest(driveBatch(await credentialFor(service, device), gaps, capturedAt)),
      ).toEqual({ status: 'accepted' });
    };
    // 18:05 publishes a jam; a new cohort that drove freely replaces it at 18:10.
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await upload(device, JAMMED_GAPS);
    nowMs = Date.parse('2026-11-12T18:05:05Z');
    await service.runEpoch();
    for (const device of ['phone-4', 'phone-5', 'phone-6']) await upload(device);

    const result = await service.enrichRoutes([route]);
    // Every edge is read from the 18:10 snapshot: fully covered and free, not a mixture of the
    // jam and gaps where 18:10 had replaced 18:05.
    expect(result.routes[0]?.traffic?.observedFraction).toBeGreaterThanOrEqual(0.35);
    expect(result.routes[0]?.traffic?.delaySeconds).toBe(0);
    await service.close();
  });

  it('uses only what is published: a jam still below the threshold changes no route', async () => {
    const traffic = await createTrafficApp({ routeMinCoverage: 0.35 });
    await traffic.upload('phone-1', JAMMED_GAPS);
    await traffic.upload('phone-2', JAMMED_GAPS);
    await traffic.advanceEpoch();

    const result = await traffic.service.enrichRoutes([route]);
    expect(result.routes).toEqual([route]);
    expect(result.trafficSource).toBeUndefined();
  });

  it('does not promote an alternative whose roads it could not check', async () => {
    const { service } = await jammedService();
    // The alternative is nominally 10 s slower and cannot be resolved to road edges, so nothing
    // is known about the streets it uses.
    const ranked = await service.enrichRoutes([route, unwalkable]);

    expect(ranked.routes.map(({ id }) => id)).toEqual([route.id, 'unwalkable']);
    expect(ranked.routes[0]?.traffic?.delaySeconds).toBeGreaterThan(20);
    expect(ranked.routes[1]?.traffic).toBeUndefined();
    expect(ranked.routes[1]?.congestion).toBeUndefined();
    // The label states which duration is lowest; the order is the recommendation.
    expect(ranked.routes.map(({ label }) => label)).toEqual(['alternative', 'fastest']);
  });

  it('keeps the engine order between two routes that are jammed alike', async () => {
    const { service } = await jammedService();
    const twin = { ...route, durationSeconds: route.durationSeconds + 90, id: 'twin' };
    const ranked = await service.enrichRoutes([route, { ...twin, label: 'alternative' as const }]);

    expect(ranked.routes.map(({ id }) => id)).toEqual([route.id, 'twin']);
    expect(ranked.routes.map(({ label }) => label)).toEqual(['fastest', 'alternative']);
  });

  it('leaves routes untouched when too little of them is observed', async () => {
    const { service } = await jammedService({ routeMinCoverage: 0.95 });
    const result = await service.enrichRoutes([route]);

    expect(result.trafficSource).toBeUndefined();
    expect(result.routes).toEqual([route]);
  });

  it('skips map matching when nothing is published near the route', async () => {
    const { service, stub } = await createTrafficApp();
    const result = await service.enrichRoutes([route]);

    expect(result.routes).toEqual([route]);
    expect(result.trafficSource).toBeUndefined();
    expect(stub.requests).toEqual([]);
  });

  it('does nothing while collecting, and survives a map-matching outage', async () => {
    const collecting = await jammedService({ mode: 'collect' });
    expect((await collecting.service.enrichRoutes([route])).routes).toEqual([route]);
    expect(collecting.stub.requests).toEqual([]);

    const live = await jammedService();
    live.stub.failNext(502);
    const result = await live.service.enrichRoutes([route]);
    expect(result.routes).toEqual([route]);
    expect(result.trafficSource).toBeUndefined();
  });
});

describe('standing still across batch boundaries, through HTTP on a recorded real edge', () => {
  /**
   * Batches along one 1.18 km Deerfoot Trail edge, with the Valhalla 3.8.2 answers the server
   * received for them on the Alberta/BC graph (see the fixture's note).
   */
  interface Recording {
    batches: Record<
      'approach' | 'resume' | 'stationary' | 'stationaryJitter',
      TrafficProbeBatchRequest['points']
    >;
    exchanges: { path: string; request: unknown; response: unknown }[];
  }
  const recording = (name: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Recording;
  const DWELL = recording('valhalla-dwell-calgary.json');
  /** The same road, stopping 22 m before the end of the edge and going on across its node. */
  const NEXT_EDGE = recording('valhalla-dwell-next-edge-calgary.json');
  const MINUTE = 60_000;
  // A boundary; every trip below begins exactly then, so it is inside its 15-minute window.
  const T0 = Date.parse('2026-11-14T18:00:00Z');
  const everywhere = [DWELL, NEXT_EDGE].flatMap(({ batches }) => Object.values(batches).flat());
  const longitudes = everywhere.map(([lon]) => lon);
  const latitudes = everywhere.map(([, lat]) => lat);
  const FLOW = `/v2/traffic/flow?bbox=${String(
    snapTrafficFlowBounds({
      east: Math.max(...longitudes),
      north: Math.max(...latitudes),
      south: Math.min(...latitudes),
      west: Math.min(...longitudes),
    }),
  )}`;

  /** A batch whose first fix is at `startMs`: `capturedAt` is that rounded down to the minute. */
  interface Upload {
    name: keyof typeof DWELL.batches;
    startMs: number;
  }

  /** Answers the matcher's requests from the recording; refuses any it was not recorded with. */
  function recordedValhalla(requests: string[], recorded: Recording = DWELL): typeof fetch {
    return (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown;
      requests.push(path);
      const exchange = recorded.exchanges.find(
        (candidate) =>
          candidate.path === path && JSON.stringify(candidate.request) === JSON.stringify(request),
      );
      if (exchange === undefined) throw new Error('unrecorded matcher request');
      return Promise.resolve(Response.json(exchange.response));
    };
  }

  async function drive(
    trips: Upload[][],
    build?: (clock: () => Date, requests: string[]) => TrafficService,
    recorded: Recording = DWELL,
  ) {
    let nowMs = T0;
    const clock = (): Date => new Date(nowMs);
    const matcherRequests: string[] = [];
    const service =
      build?.(clock, matcherRequests) ??
      createTrafficService({
        attestation: fakeAttestation(),
        clock,
        mapMatcher: createValhallaMapMatcher({
          endpoint: 'http://valhalla.test/trace_attributes',
          fetchImplementation: recordedValhalla(matcherRequests, recorded),
        }),
        settings: { ...DEFAULT_TRAFFIC_SETTINGS, mode: 'live' },
      });
    const app = await buildApp({
      clock,
      communityReports: null,
      searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
      trafficService: service,
    });
    apps.push(app);
    const uploads = trips
      .flatMap((trip, index) =>
        trip.map((upload) => ({ ...upload, device: `driver-${String(index)}` })),
      )
      .sort((left, right) => left.startMs - right.startMs);
    for (const { device, name, startMs } of uploads) {
      const points = recorded.batches[name];
      // Each batch arrives five seconds after its last fix.
      nowMs = startMs + (points.at(-1)?.[2] ?? 0) * 1_000 + 5_000;
      const response = await app.inject({
        headers: { 'x-forwarded-for': `198.51.${String(100 + Number(device.slice(-1)))}.1` },
        method: 'POST',
        payload: {
          capturedAt: new Date(Math.floor(startMs / MINUTE) * MINUTE).toISOString(),
          credential: await credentialFor(service, device),
          points,
          schemaVersion: 1,
        },
        url: '/v2/traffic/probes',
      });
      expect(response.statusCode).toBe(202);
    }
    /** Closes the epoch at `boundaryMs` and reads the flow layer's releases then. */
    async function releasedAt(boundaryMs: number) {
      nowMs = boundaryMs + 5_000;
      await service.runEpoch();
      const response = await app.inject(FLOW);
      expect(response.statusCode).toBe(200);
      return TrafficFlowResponseSchema.parse(response.json()).features.map(
        ({ id, properties }) => ({ id, speedKph: properties.speedKph }),
      );
    }
    return {
      matcherRequests,
      service,
      /** Closes the epoch at `boundaryMs` and reads the flow layer then. */
      publishedAt: async (boundaryMs: number) =>
        (await releasedAt(boundaryMs)).map(({ speedKph }) => speedKph),
      releasedAt,
    };
  }

  // Driving 0–400 m and on from 400 m to 900 m at 36 km/h, standing at 400 m in between. The
  // trim leaves about 180 m and 280 m driven, 46 s in all, and 28 s standing at each batch end.
  const approach: Upload = { name: 'approach', startMs: T0 };
  const stopped = (startMs: number, jitter = false): Upload => ({
    name: jitter ? 'stationaryJitter' : 'stationary',
    startMs,
  });
  const resume = (startMs: number): Upload => ({ name: 'resume', startMs });
  const threeDrivers = (trip: Upload[]) => [trip, trip, trip];
  const published = async (trip: Upload[], boundaryMs = T0 + 10 * MINUTE) =>
    (await drive(threeDrivers(trip))).publishedAt(boundaryMs);

  it('counts standing at batch boundaries and a stationary batch, each once', async () => {
    // The standing trimmed off the two moving batches: 28 s each, but `resume` claims a start
    // rounded down to T0 + 60 s, so its window overlaps the approach's by 10 s and only the union,
    // 46 s, counts: 458 m in 92 s, 17.9 km/h, published as 20. Before the fix no standing
    // counted: 458 m in 46 s, 36 km/h, published as 35.
    expect(await published([approach, resume(T0 + 70_000)])).toEqual([20]);
    // A 98 s stationary batch between them, claimed from T0 + 60 s: the union of the claimed
    // standing is 116 s (the resume's 28 s falls inside it), so 458 m in 162 s, 10.2 km/h,
    // published as 10.
    const withStop = [approach, stopped(T0 + 70_000), resume(T0 + 170_000)];
    expect(await published(withStop)).toEqual([10]);
    // The same stationary batch uploaded again adds nothing (summing gives 5.5 km/h, 5).
    expect(
      await published([approach, stopped(T0 + 70_000), stopped(T0 + 70_000), resume(T0 + 170_000)]),
    ).toEqual([10]);
  });

  it('counts a longer stop over two batches, one with GPS jitter, without matching them', async () => {
    const { matcherRequests, publishedAt } = await drive(
      threeDrivers([
        approach,
        stopped(T0 + 70_000),
        stopped(T0 + 170_000, true),
        resume(T0 + 270_000),
      ]),
    );
    // Claimed standing windows unite to 204 s: 458 m in 250 s, 6.6 km/h, published as 5
    // (`stopped` against 100 km/h free flow).
    expect(await publishedAt(T0 + 10 * MINUTE)).toEqual([5]);
    // Only the moving batches reached the matcher: stationary batches are never sent.
    expect(matcherRequests.filter((path) => path === '/trace_attributes')).toHaveLength(6);
  });

  it('never counts the stop when the trip ends there or sharing is cancelled', async () => {
    const { publishedAt, service } = await drive(
      threeDrivers([approach, stopped(T0 + 70_000), stopped(T0 + 170_000, true)]),
    );
    expect(await publishedAt(T0 + 10 * MINUTE)).toEqual([]);
    // Partial coverage, with the held dwell, is all there is; it expires with its window.
    expect(service.metrics()).toMatchObject({ pendingPartial: 3, pendingSamples: 0 });
    expect(await publishedAt(T0 + 20 * MINUTE)).toEqual([]);
    expect(service.metrics()).toMatchObject({ pendingPartial: 0, pendingSamples: 0 });
  });

  it('releases nothing once the stop-and-go began more than 15 minutes before the boundary', async () => {
    expect(
      await published([approach, stopped(T0 + 70_000), resume(T0 + 170_000)], T0 + 20 * MINUTE),
    ).toEqual([]);
  });

  describe('a stop just before an edge ends, where the trip goes on across its node', () => {
    // The approach alone covers 580 m of the 1.18 km edge: that sample is complete, but not yet
    // published, before the stop is seen.
    const EDGE = 'w551687611f-0148888c022f';
    const approachNext: Upload = { name: 'approach', startMs: T0 };
    const stopNext = (startMs: number): Upload => ({ name: 'stationary', startMs });
    const goOn = (startMs: number): Upload => ({ name: 'resume', startMs });
    const edgeSpeed = async (trip: Upload[], recorded: Recording = NEXT_EDGE) => {
      const { releasedAt } = await drive(threeDrivers(trip), undefined, recorded);
      return (await releasedAt(T0 + 10 * MINUTE)).find(({ id }) => id === EDGE)?.speedKph;
    };
    /** The parts of a recorded `/locate` edge these tests change. */
    interface LocatedEdge {
      edge: { end_node?: { value: number } };
      edge_id?: { value: number };
    }
    /** The recording with each located edge changed by `change`. */
    const relocated = (change: (edge: LocatedEdge) => void): Recording => {
      const copy = structuredClone(NEXT_EDGE);
      for (const { path, response } of copy.exchanges) {
        if (path !== '/locate') continue;
        // Recorded verbose `/locate` answers, as Valhalla 3.8.2 gave them.
        const located = response as { edges: LocatedEdge[] | null }[];
        for (const point of located) {
          for (const edge of point.edges ?? []) change(edge);
        }
      }
      return copy;
    };

    it('counts the stop on the edge it was on once the trip goes on along the next edges', async () => {
      // Moving only, 580 m in 58 s is 36 km/h (35); that is what an ended trip publishes, below.
      // With the standing trimmed off the two moving batches, confirmed by the movement onto the
      // next edges (the edge after the stop begins at the node the stop's edge ends at, by the
      // graph's node ids): the approach's 30 s and the resume's 28 s, whose minute-rounded claim
      // overlaps it by 8 s, unite to 50 s: 19.3 km/h, published as 20. With a 98 s stationary
      // batch as well, 126 s: 11.3 km/h, published as 10.
      expect(await edgeSpeed([approachNext, goOn(T0 + 112_000)])).toBe(20);
      expect(await edgeSpeed([approachNext, stopNext(T0 + 112_000), goOn(T0 + 212_000)])).toBe(10);
      // Uploading the stationary batch again changes nothing.
      expect(
        await edgeSpeed([
          approachNext,
          stopNext(T0 + 112_000),
          stopNext(T0 + 112_000),
          goOn(T0 + 212_000),
        ]),
      ).toBe(10);
    });

    it('takes going on only onto an edge the graph says begins at the stop edge’s end node', async () => {
      const trip = [approachNext, goOn(T0 + 112_000)];
      // The edge after the stop is located with the same geometry, but its opposing edge ends at
      // another node: the two nodes coincide in position without being connected.
      const coincident = relocated((edge) => {
        const node = edge.edge.end_node;
        if (edge.edge_id?.value === 93_650_445_040 && node !== undefined) node.value += 1;
      });
      expect(await edgeSpeed(trip, coincident)).toBe(35);
      // Without node ids the graph confirms no connection, and the standing does not count; the
      // edges themselves are still published.
      const unidentified = relocated((edge) => {
        delete edge.edge_id;
      });
      expect(await edgeSpeed(trip, unidentified)).toBe(35);
      expect(await edgeSpeed(trip)).toBe(20);
    });

    it('never counts the stop when the trip ends there', async () => {
      // The completed sample is published at its moving speed; the stop stays discarded.
      expect(await edgeSpeed([approachNext, stopNext(T0 + 112_000)])).toBe(35);
    });
  });

  describe('the configured service and the dead-end mask', () => {
    const root = mkdtempSync(join(tmpdir(), 'navoss-configured-traffic-'));
    afterAll(() => {
      rmSync(root, { force: true, recursive: true });
    });
    let graphs = 0;
    /** A verified serving graph directory whose mask lists `ways`; returns its configuration. */
    const servingGraph = (ways: Partial<DeadEndMaskWays>) => {
      graphs += 1;
      const directory = join(root, String(graphs));
      mkdirSync(directory);
      const graphId = writeServingGraph(
        directory,
        'tiles of the 2026-11-11 graph',
        directory,
        ways,
      );
      return { COMMUNITY_TRAFFIC_GRAPH_DIR: directory, COMMUNITY_TRAFFIC_GRAPH_ID: graphId };
    };
    const environment = (mode: 'collect' | 'live', extra: Record<string, string> = {}) => ({
      COMMUNITY_TRAFFIC_MODE: mode,
      VALHALLA_URL: 'http://valhalla:8002/route',
      ...extra,
    });
    /** Builds the service from configuration alone, its matcher answering from the recording. */
    const configured =
      (graph: Record<string, string>) => (clock: () => Date, requests: string[]) => {
        vi.stubGlobal('fetch', recordedValhalla(requests));
        try {
          return createConfiguredTrafficService(
            { attestation: fakeAttestation(), clock },
            environment('live', graph),
          );
        } finally {
          vi.unstubAllGlobals();
        }
      };
    const DEERFOOT = 551_687_611;
    const trip = [approach, stopped(T0 + 70_000), resume(T0 + 170_000)];
    const publishedWith = async (ways: Partial<DeadEndMaskWays>) =>
      (await drive(threeDrivers(trip), configured(servingGraph(ways)))).publishedAt(
        T0 + 10 * MINUTE,
      );
    /** The recorded edge's whole map geometry, as `/locate` gave it, in the way's direction. */
    const deerfootEdge = (() => {
      for (const { path, response } of DWELL.exchanges) {
        if (path !== '/locate') continue;
        // Recorded verbose `/locate` answers, as Valhalla 3.8.2 gave them.
        const located = response as { edges: { edge_info: { shape: string; way_id: number } }[] }[];
        const shape = located[0]?.edges.find(({ edge_info }) => edge_info.way_id === DEERFOOT)
          ?.edge_info.shape;
        if (shape !== undefined) return decodePolyline6(shape);
      }
      throw new Error('the recording has no located Deerfoot edge');
    })();

    it('publishes, from three contributors, only an edge the configured mask places on the main network', async () => {
      // The verified mask lists the way as eligible: the drive is published.
      expect(await publishedWith({ eligible: [DEERFOOT] })).toEqual([10]);
      // Mixed, eligible along the whole edge: published too.
      const along = 'e'.repeat(deerfootEdge.length - 1);
      expect(await publishedWith({ mixed: [mixedWay(DEERFOOT, deerfootEdge, along)] })).toEqual([
        10,
      ]);
      // Excluded, unknown, absent from the mask, or mixed with a boundary inside the edge: the
      // same three contributors publish nothing.
      expect(await publishedWith({ excluded: [DEERFOOT] })).toEqual([]);
      expect(await publishedWith({ unknown: [DEERFOOT] })).toEqual([]);
      expect(await publishedWith({ eligible: [5] })).toEqual([]);
      const boundary = `${'e'.repeat(deerfootEdge.length - 2)}x`;
      expect(await publishedWith({ mixed: [mixedWay(DEERFOOT, deerfootEdge, boundary)] })).toEqual(
        [],
      );
    });

    it('refuses to start live without the verified serving graph; collect may run without', () => {
      expect(() => createConfiguredTrafficService({}, environment('live'))).toThrow();
      expect(createConfiguredTrafficService({}, environment('collect')).mode).toBe('collect');
      expect(() =>
        createConfiguredTrafficService(
          {},
          environment('live', {
            COMMUNITY_TRAFFIC_GRAPH_DIR: join(root, 'missing'),
            COMMUNITY_TRAFFIC_GRAPH_ID: 'e'.repeat(64),
          }),
        ),
      ).toThrow();
      // A verified directory, but configured with another graph id.
      const valid = servingGraph({ eligible: [DEERFOOT] });
      expect(() =>
        createConfiguredTrafficService(
          {},
          environment('live', { ...valid, COMMUNITY_TRAFFIC_GRAPH_ID: 'c'.repeat(64) }),
        ),
      ).toThrow(/not the configured graph/);
      expect(createConfiguredTrafficService({}, environment('live', valid)).mode).toBe('live');
    });
  });
});

describe('evidence time over HTTP, on one synthetic edge', () => {
  // One synthetic 1.5 km northbound edge, matched directly from each fix's latitude. These are
  // valid uploads; the matcher is controlled so that what is tested is ingestion and expiry.
  const T0 = Date.parse('2026-11-14T18:00:00Z');
  const MINUTE = 60_000;
  const METERS_PER_DEGREE = 111_195;
  const at = (meters: number): [number, number] => [-114, 51.01 + meters / METERS_PER_DEGREE];
  const LINE = [at(0), at(1_500)];
  const KEY = edgeSegmentKey({ forward: true, wayId: 900_000_001 }, LINE);
  const oneEdge: MapMatcher = {
    matchTrace: (points) =>
      Promise.resolve({
        edges: [
          {
            beginShapeIndex: 0,
            endShapeIndex: 1,
            forward: true,
            fromFraction: 0,
            lengthMeters: 1_500,
            line: LINE,
            openThroughRoad: true,
            roadClass: 'primary',
            segmentKey: KEY,
            speedKph: 80,
            toFraction: 1,
            use: 'road',
            wayId: 900_000_001,
          },
        ],
        points: points.map(({ position }) => ({
          edgeFraction: ((position[1] - 51.01) * METERS_PER_DEGREE) / 1_500,
          edgeIndex: 0,
          startsNewPath: false,
        })),
      }),
    walkRoute: () => Promise.resolve(undefined),
  };
  /** Driving from `from` to `to` metres at 36 km/h, one fix a second. */
  /** A fix at `meters` along the edge, `seconds` into its batch. */
  const fix = (meters: number, seconds: number): [number, number, number] => [
    ...at(meters),
    seconds,
  ];
  const moving = (from: number, to: number): TrafficProbeBatchRequest['points'] =>
    Array.from({ length: (to - from) / 10 + 1 }, (_, index) => fix(from + index * 10, index));
  /**
   * 0–600 m with 40 s standing at 300 m: after the 100 m trims, 400 m and 80 s (18 km/h) on
   * metres the 600–1200 m batch never drove.
   */
  const earlier: TrafficProbeBatchRequest['points'] = [
    ...moving(0, 300),
    ...Array.from({ length: 20 }, (_, index) => fix(300, 32 + index * 2)),
    ...Array.from({ length: 30 }, (_, index) => fix(310 + index * 10, 71 + index)),
  ];

  interface OneEdgeTraffic {
    metrics(): TrafficMetrics;
    /** Uploads `points` as `driver` at `arrivalMs`, claiming they began at `capturedAtMs`. */
    upload(
      driver: string,
      points: TrafficProbeBatchRequest['points'],
      capturedAtMs: number,
      arrivalMs: number,
    ): Promise<void>;
    /** Closes the epoch at `boundaryMs`; the speeds the flow layer then serves for the edge. */
    releasedAt(boundaryMs: number): Promise<number[]>;
  }

  async function service(): Promise<OneEdgeTraffic> {
    let nowMs = T0;
    const clock = (): Date => new Date(nowMs);
    const traffic = createTrafficService({
      attestation: fakeAttestation(),
      clock,
      mapMatcher: oneEdge,
      settings: { ...DEFAULT_TRAFFIC_SETTINGS, mode: 'live' },
    });
    const app = await buildApp({
      clock,
      communityReports: null,
      searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
      trafficService: traffic,
    });
    apps.push(app);
    const FLOW = `/v2/traffic/flow?bbox=${String(
      snapTrafficFlowBounds({ east: -113.99, north: 51.03, south: 51, west: -114.01 }),
    )}`;
    return {
      metrics: () => traffic.metrics(),
      async upload(driver, points, capturedAtMs, arrivalMs) {
        nowMs = arrivalMs;
        const response = await app.inject({
          headers: { 'x-forwarded-for': `198.51.100.${String(driver.charCodeAt(0))}` },
          method: 'POST',
          payload: {
            capturedAt: new Date(capturedAtMs).toISOString(),
            credential: await credentialFor(traffic, driver),
            points,
            schemaVersion: 1,
          },
          url: '/v2/traffic/probes',
        });
        expect(response.statusCode).toBe(202);
      },
      async releasedAt(boundaryMs) {
        nowMs = boundaryMs + 5_000;
        await traffic.runEpoch();
        const response = await app.inject(FLOW);
        expect(response.statusCode).toBe(200);
        return TrafficFlowResponseSchema.parse(response.json())
          .features.filter(({ id }) => id === KEY)
          .map(({ properties }) => properties.speedKph);
      },
    };
  }

  /**
   * Drivers a and b complete samples before 18:15: by default at 18:12 from driving at 18:11
   * (600–1200 m). `late` runs at 18:18. Driver c then completes a fresh sample from driving that
   * began at `third`. Every boundary up to then is closed, as the running service does, and
   * releases nothing: two contributors are not enough.
   */
  async function timeline(
    third: number,
    {
      late,
      opening = async (traffic) => {
        for (const driver of ['a', 'b']) {
          await traffic.upload(driver, moving(600, 1_200), T0 + 11 * MINUTE, T0 + 12 * MINUTE);
        }
      },
    }: {
      late?: (traffic: OneEdgeTraffic) => Promise<void>;
      opening?: (traffic: OneEdgeTraffic) => Promise<void>;
    } = {},
  ): Promise<OneEdgeTraffic> {
    const traffic = await service();
    await opening(traffic);
    expect(traffic.metrics().pendingSamples).toBe(2);
    expect(await traffic.releasedAt(T0 + 15 * MINUTE)).toEqual([]);
    await late?.(traffic);
    if (third >= T0 + 20 * MINUTE) expect(await traffic.releasedAt(T0 + 20 * MINUTE)).toEqual([]);
    await traffic.upload('c', moving(600, 1_200), third, third + MINUTE);
    expect(traffic.metrics().pendingSamples).toBe(3);
    return traffic;
  }
  /** a and b each send, at 18:18, a delayed batch of their driving from 18:09. */
  const lateEarlier = async (traffic: OneEdgeTraffic) => {
    for (const driver of ['a', 'b']) {
      await traffic.upload(driver, earlier, T0 + 9 * MINUTE, T0 + 18 * MINUTE);
    }
  };

  it('counts a delayed batch while its driving is inside the window', async () => {
    const traffic = await timeline(T0 + 18 * MINUTE, { late: lateEarlier });
    expect(traffic.metrics()).toMatchObject({ batchesAccepted: 5, batchesDropped: 0 });
    // a and b: 800 m in 120 s, 24 km/h; c: 36 km/h. At 18:20 the 18:09 driving is 11 minutes old.
    expect(await traffic.releasedAt(T0 + 20 * MINUTE)).toEqual([25]);
  });

  it('releases nothing at 18:25 from samples that took 18:09 driving at 18:18', async () => {
    const control = await timeline(T0 + 20 * MINUTE);
    expect(await control.releasedAt(T0 + 25 * MINUTE)).toEqual([35]);

    const traffic = await timeline(T0 + 20 * MINUTE, { late: lateEarlier });
    // The delayed batches were accepted and counted, not dropped.
    expect(traffic.metrics()).toMatchObject({ batchesAccepted: 5, batchesDropped: 0 });
    // At 18:25 the window begins at 18:10: a's and b's samples rest on driving from 18:09.
    expect(await traffic.releasedAt(T0 + 25 * MINUTE)).toEqual([]);
    expect(traffic.metrics().pendingSamples).toBe(1);
  });

  it('a repeat that counts nothing never makes a fresh sample expire', async () => {
    // After completion: the completed sample's own batch again at 18:18, now claiming 18:09.
    const afterCompletion = await timeline(T0 + 20 * MINUTE, {
      late: async (traffic) => {
        for (const driver of ['a', 'b']) {
          await traffic.upload(driver, moving(600, 1_200), T0 + 9 * MINUTE, T0 + 18 * MINUTE);
        }
      },
    });
    expect(await afterCompletion.releasedAt(T0 + 25 * MINUTE)).toEqual([35]);

    // Before completion: 700–900 m driven at 18:11, that piece again at 18:13 claiming 18:09,
    // then 900–1200 m driven at 18:13 completes the sample.
    const beforeCompletion = await timeline(T0 + 20 * MINUTE, {
      opening: async (traffic) => {
        for (const driver of ['a', 'b']) {
          await traffic.upload(driver, moving(600, 1_000), T0 + 11 * MINUTE, T0 + 12 * MINUTE);
          await traffic.upload(driver, moving(600, 1_000), T0 + 9 * MINUTE, T0 + 13 * MINUTE);
          await traffic.upload(driver, moving(800, 1_300), T0 + 13 * MINUTE, T0 + 14 * MINUTE);
        }
      },
    });
    expect(beforeCompletion.metrics()).toMatchObject({ batchesAccepted: 7, batchesDropped: 0 });
    expect(await beforeCompletion.releasedAt(T0 + 25 * MINUTE)).toEqual([35]);
  });

  it('counts standing in valid re-cuts of one trace only over the union of their claimed time', async () => {
    // One physical trace: 0–700 m in 70 s, standing 40 s, then on to 1,400 m. After the trims,
    // 1,200 m in 120 s moving and 40 s standing: 27 km/h, published as 25.
    const trace = Array.from({ length: 181 }, (_, t) =>
      fix(t <= 70 ? t * 10 : t <= 110 ? 700 : (t - 40) * 10, t),
    );
    /** Each driver uploads the trace cut to begin `from` seconds in; all claim 18:00. */
    const speeds = async (cuts: number[]) => {
      const traffic = await service();
      for (const driver of ['a', 'b', 'c']) {
        for (const from of cuts) {
          const points = trace
            .slice(from)
            .map(([lon, lat, t]): [number, number, number] => [lon, lat, t - from]);
          await traffic.upload(driver, points, T0, T0 + 200_000);
        }
      }
      expect(traffic.metrics()).toMatchObject({
        batchesAccepted: 3 * cuts.length,
        samplesRecorded: 3,
      });
      return traffic.releasedAt(T0 + 5 * MINUTE);
    };
    expect(await speeds([0])).toEqual([25]);
    expect(await speeds([0, 0, 0, 0])).toEqual([25]);
    // Cut 20, 30 and 40 s in, the stop's claimed windows shift 20, 30 and 40 s earlier: their
    // union is 80 s, 1,200 m in 200 s, 21.6 km/h, published as 20. Counting each window that
    // overlaps by less than a minute in full would give 160 s: 15.4 km/h, published as 15.
    expect(await speeds([0, 20, 30, 40])).toEqual([20]);
  });
});
