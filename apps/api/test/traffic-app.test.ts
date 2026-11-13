import { Writable } from 'node:stream';

import {
  AppConfigResponseSchema,
  LegacyAppConfigResponseSchema,
  ProblemDetailsSchema,
  RouteTrafficAnnotationSchema,
  TrafficCredentialResponseSchema,
  TrafficFlowResponseSchema,
  TrafficStatusResponseSchema,
} from '@navoss/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import {
  createConfiguredTrafficService,
  createTrafficService,
  type TrafficAttestation,
  type TrafficService,
} from '../src/traffic/service.js';
import type { TrafficSettings } from '../src/traffic/settings.js';
import {
  assertionFor,
  credentialFor,
  DRIVE,
  driveBatch,
  fakeAttestation,
  FIXTURE_SETTINGS,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
  type StubbedMatcher,
} from './traffic-fixture.js';

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
): Promise<TrafficApp> {
  let nowMs = NOW.getTime();
  const clock = (): Date => new Date(nowMs);
  const stub = stubbedMatcher();
  const service = createTrafficService({
    attestation: attestation ?? undefined,
    clock,
    mapMatcher: stub.matcher,
    settings: { ...FIXTURE_SETTINGS, ...settings },
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
    const during = await flow(traffic.app);
    expect(during.flow.features).toEqual([]);
    expect(during.flow.generatedAt).toBe('2026-11-12T18:00:00.000Z');
    expect(during.flow.validUntil).toBe('2026-11-12T18:05:00.000Z');

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

  it('takes a published value down on schedule when no new cohort replaces it', async () => {
    const traffic = await createTrafficApp();
    for (const device of ['phone-1', 'phone-2', 'phone-3']) await traffic.upload(device);
    await traffic.advanceEpoch();

    traffic.setClock(Date.parse('2026-11-12T18:19:59Z'));
    expect((await flow(traffic.app)).flow.features.length).toBeGreaterThan(10);
    // 15 minutes after release, even if the epoch job has not run.
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

  it('does not let a database that never answers hold up startup while off', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const build = (mode: TrafficSettings['mode']) => {
        const failures: string[] = [];
        let failPurge: (error: Error) => void = () => undefined;
        const service = createTrafficService({
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
    const traffic = await createTrafficApp({ routeMinCoverage: 0.4, ...settings });
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
    expect(enriched?.traffic?.observedFraction).toBeGreaterThanOrEqual(0.4);
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

  it('uses only what is published: a jam still below the threshold changes no route', async () => {
    const traffic = await createTrafficApp({ routeMinCoverage: 0.4 });
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
