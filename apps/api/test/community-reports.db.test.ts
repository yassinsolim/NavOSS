import { randomBytes } from 'node:crypto';

import {
  communityAssertionClientData,
  type CommunityAssertedOperation,
  type CommunityReportPublication,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAppAttestVerifier } from '../src/app-attest.js';
import { buildApp } from '../src/app.js';
import {
  createCommunityReportService,
  type AttestationMode,
  type CommunityReportService,
} from '../src/community-reports.js';
import { MIGRATIONS, MigrationError, pendingMigrations, runMigrations } from '../src/migrations.js';
import { isSupportedSearchCoordinate } from '../src/search-provider.js';
import {
  createTestAppAttestAuthority,
  type TestAttestedDevice,
  type TestDevice,
} from './support/app-attest-fixture.js';

/**
 * Runs against a real PostGIS. Locally: `docker run --platform linux/amd64 -d --name
 * api-reports-postgis -e POSTGRES_USER=navoss -e POSTGRES_PASSWORD=navoss -e POSTGRES_DB=navoss
 * -p 127.0.0.1:5441:5432 postgis/postgis:16-3.5-alpine`. Skips when no database is reachable unless
 * NAVOSS_REQUIRE_TEST_DATABASE=1.
 */
const DATABASE_URL =
  process.env.NAVOSS_TEST_DATABASE_URL ?? 'postgres://navoss:navoss@127.0.0.1:5441/navoss';
const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'org.navoss.mobile';
const SCHEMA = `community_test_${randomBytes(6).toString('hex')}`;

async function databaseAvailable(): Promise<boolean> {
  const probe = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1_500,
    max: 1,
  });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    if (process.env.NAVOSS_REQUIRE_TEST_DATABASE === '1')
      throw new Error('Test database required.');
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const available = await databaseAvailable();

const DOWNTOWN = { latitude: 51.044712, longitude: -114.071883 };
const NEARBY = { latitude: 51.0452, longitude: -114.0712 };
const BBOX = { east: -113.95, north: 51.12, south: 50.95, west: -114.2 };

const offset = (meters: number) => ({
  latitude: DOWNTOWN.latitude,
  longitude: DOWNTOWN.longitude + meters / 70_000,
});

describe.skipIf(!available)('community reports on PostGIS', () => {
  const authority = createTestAppAttestAuthority({ bundleId: BUNDLE_ID, teamId: TEAM_ID });
  let admin: Pool;
  let now: Date;
  const apps: FastifyInstance[] = [];

  const schemaPool = (): Pool =>
    new Pool({
      connectionString: DATABASE_URL,
      max: 4,
      options: `-c search_path=${SCHEMA},public`,
    });

  async function makeApp(
    publication: CommunityReportPublication,
    attestationMode: AttestationMode = 'enforce',
  ): Promise<{ app: FastifyInstance; service: CommunityReportService }> {
    const service = createCommunityReportService({
      attestationMode,
      clock: () => now,
      installationSecret: Buffer.alloc(32, 7),
      isInCoverage: isSupportedSearchCoordinate,
      pool: schemaPool(),
      publication,
      verifier: createAppAttestVerifier({
        bundleId: BUNDLE_ID,
        environment: 'production',
        rootCertificatePem: authority.rootPem,
        teamId: TEAM_ID,
      }),
    });
    const app = await buildApp({ clock: () => now, communityReports: service });
    apps.push(app);
    return { app, service };
  }

  async function challenge(app: FastifyInstance): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/v2/community/challenges' });
    expect(response.statusCode).toBe(200);
    return response.json<{ challenge: string }>().challenge;
  }

  async function register(app: FastifyInstance): Promise<TestAttestedDevice> {
    const device = authority.createDevice();
    const value = await challenge(app);
    const response = await app.inject({
      method: 'POST',
      payload: {
        attestationObject: device.attest(value),
        challenge: value,
        keyId: device.keyId,
        kind: 'app-attest',
      },
      url: '/v2/community/installations',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'registered', trust: 'attested' });
    return device;
  }

  async function asserted(
    app: FastifyInstance,
    device: TestDevice,
    operation: CommunityAssertedOperation,
    counter?: number,
  ) {
    const value = await challenge(app);
    return {
      assertion: device.assert(communityAssertionClientData(value, operation), counter),
      challenge: value,
      keyId: device.keyId,
    };
  }

  async function submit(
    app: FastifyInstance,
    device: TestDevice,
    coordinate = DOWNTOWN,
    type: 'collision' | 'pothole' = 'collision',
  ) {
    return app.inject({
      method: 'POST',
      payload: {
        assertion: await asserted(app, device, { coordinate, kind: 'submit-report', type }),
        coordinate,
        type,
      },
      url: '/v2/community/reports',
    });
  }

  async function vote(
    app: FastifyInstance,
    device: TestDevice,
    reportId: string,
    value: 'present' | 'not-present',
    observedAt = NEARBY,
  ) {
    return app.inject({
      method: 'POST',
      payload: {
        assertion: await asserted(app, device, { kind: 'vote', observedAt, reportId, vote: value }),
        observedAt,
        vote: value,
      },
      url: `/v2/community/reports/${reportId}/votes`,
    });
  }

  async function nearby(app: FastifyInstance) {
    const response = await app.inject({
      method: 'GET',
      query: Object.fromEntries(Object.entries(BBOX).map(([key, value]) => [key, String(value)])),
      url: '/v2/community/reports',
    });
    expect(response.statusCode).toBe(200);
    return response.json<{
      publication: string;
      reports: {
        confirmations: number;
        coordinate: { latitude: number };
        id: string;
        state: string;
      }[];
    }>();
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    const pool = schemaPool();
    try {
      expect(await pendingMigrations(pool)).toEqual(MIGRATIONS.map((migration) => migration.id));
      expect(await runMigrations(pool)).toEqual(['0001_community_reports']);
      expect(await runMigrations(pool)).toEqual([]);
      expect(await pendingMigrations(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    now = new Date('2026-11-12T18:00:00Z');
    await admin.query(
      `TRUNCATE ${SCHEMA}.community_report_votes, ${SCHEMA}.community_reports,
                ${SCHEMA}.community_installations, ${SCHEMA}.community_challenges`,
    );
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('refuses to run an applied migration whose SQL changed', async () => {
    const pool = schemaPool();
    try {
      await expect(
        runMigrations(pool, [{ id: '0001_community_reports', sql: 'SELECT 1' }]),
      ).rejects.toBeInstanceOf(MigrationError);
    } finally {
      await pool.end();
    }
  });

  it('runs the attested beta flow: submit, unconfirmed, corroborated, expired, purged', async () => {
    const { app, service } = await makeApp('attested');
    const config = await app.inject({ method: 'GET', url: '/v2/config' });
    expect(config.json()).toMatchObject({ features: { communityReports: true } });
    const legacy = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(legacy.json()).toMatchObject({ features: { communityReports: true } });

    const reporter = await register(app);
    const submitted = await submit(app, reporter);
    expect(submitted.statusCode).toBe(201);
    const { reportId } = submitted.json<{ reportId: string }>();

    let read = await nearby(app);
    expect(read.publication).toBe('attested');
    expect(read.reports).toEqual([
      expect.objectContaining({ confirmations: 0, id: reportId, state: 'unconfirmed' }),
    ]);
    expect(read.reports[0]?.coordinate).toEqual({ latitude: 51.0447, longitude: -114.0719 });

    now = new Date(now.getTime() + 30 * 60_000);
    const passer = await register(app);
    const voted = await vote(app, passer, reportId, 'present');
    expect(voted.statusCode).toBe(200);
    expect(voted.json()).toEqual({ active: true, reportId, status: 'recorded' });

    read = await nearby(app);
    expect(read.reports).toEqual([
      expect.objectContaining({ confirmations: 1, id: reportId, state: 'confirmed' }),
    ]);

    // Confirmation at +30 min extended expiry to +2h30.
    now = new Date('2026-11-12T20:29:00Z');
    expect((await nearby(app)).reports).toHaveLength(1);
    now = new Date('2026-11-12T20:31:00Z');
    expect((await nearby(app)).reports).toHaveLength(0);

    now = new Date('2026-11-13T21:00:00Z');
    await service.purgeExpired();
    const remaining = await admin.query(
      `SELECT count(*)::int AS count FROM ${SCHEMA}.community_reports`,
    );
    expect(remaining.rows[0]).toEqual({ count: 0 });
  });

  it('stores nothing readable in shadow mode and reports reading as off', async () => {
    const { app } = await makeApp('shadow');
    const config = await app.inject({ method: 'GET', url: '/v2/config' });
    expect(config.json()).toMatchObject({ features: { communityReports: false } });
    const reporter = await register(app);
    const { reportId } = (await submit(app, reporter)).json<{ reportId: string }>();
    expect((await vote(app, await register(app), reportId, 'present')).statusCode).toBe(200);
    expect(await nearby(app)).toMatchObject({ publication: 'shadow', reports: [] });
  });

  it('hides single reports until independently corroborated in corroborated mode', async () => {
    const { app } = await makeApp('corroborated');
    const reporter = await register(app);
    const { reportId } = (await submit(app, reporter)).json<{ reportId: string }>();
    expect((await nearby(app)).reports).toEqual([]);

    // A second driver reporting the same thing nearby confirms instead of duplicating.
    const merged = await submit(app, await register(app), offset(60));
    expect(merged.statusCode).toBe(201);
    expect(merged.json()).toMatchObject({ reportId, status: 'merged' });
    expect((await nearby(app)).reports).toEqual([
      expect.objectContaining({ confirmations: 1, id: reportId, state: 'confirmed' }),
    ]);
  });

  it('suppresses a report when passing drivers say it is gone', async () => {
    const { app } = await makeApp('attested');
    const { reportId } = (await submit(app, await register(app))).json<{ reportId: string }>();
    const first = await vote(app, await register(app), reportId, 'not-present');
    expect(first.json()).toMatchObject({ active: true });
    expect((await nearby(app)).reports).toEqual([]);
    const second = await vote(app, await register(app), reportId, 'not-present');
    expect(second.json()).toMatchObject({ active: false });
  });

  it('rejects replayed assertions and counter rollback', async () => {
    const { app } = await makeApp('attested');
    const device = await register(app);
    const assertion = await asserted(app, device, {
      coordinate: DOWNTOWN,
      kind: 'submit-report',
      type: 'collision',
    });
    const payload = { assertion, coordinate: DOWNTOWN, type: 'collision' };
    const first = await app.inject({ method: 'POST', payload, url: '/v2/community/reports' });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: 'POST', payload, url: '/v2/community/reports' });
    expect(replay.statusCode).toBe(401);

    const rolledBack = await asserted(
      app,
      device,
      { coordinate: offset(400), kind: 'submit-report', type: 'pothole' },
      device.counter,
    );
    const rollback = await app.inject({
      method: 'POST',
      payload: { assertion: rolledBack, coordinate: offset(400), type: 'pothole' },
      url: '/v2/community/reports',
    });
    expect(rollback.statusCode).toBe(403);
    expect(rollback.json()).toMatchObject({
      code: 'forbidden',
      title: 'Assertion replay rejected',
    });
  });

  it('rejects an assertion moved onto a different coordinate', async () => {
    const { app } = await makeApp('attested');
    const device = await register(app);
    const assertion = await asserted(app, device, {
      coordinate: DOWNTOWN,
      kind: 'submit-report',
      type: 'collision',
    });
    const response = await app.inject({
      method: 'POST',
      payload: { assertion, coordinate: offset(500), type: 'collision' },
      url: '/v2/community/reports',
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects self-votes, duplicate votes, and far-away votes', async () => {
    const { app } = await makeApp('attested');
    const reporter = await register(app);
    const { reportId } = (await submit(app, reporter)).json<{ reportId: string }>();
    expect((await vote(app, reporter, reportId, 'present')).statusCode).toBe(403);

    const voter = await register(app);
    expect((await vote(app, voter, reportId, 'present')).statusCode).toBe(200);
    const duplicate = await vote(app, voter, reportId, 'not-present');
    expect(duplicate.statusCode).toBe(409);

    const far = await vote(app, await register(app), reportId, 'present', offset(3_000));
    expect(far.statusCode).toBe(400);
  });

  it('rate limits per category and per installation', async () => {
    const { app } = await makeApp('attested');
    const device = await register(app);
    for (const meters of [0, 300, 600]) {
      expect((await submit(app, device, offset(meters), 'pothole')).statusCode).toBe(201);
    }
    const limited = await submit(app, device, offset(900), 'pothole');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('900');
    expect((await submit(app, device, offset(900), 'collision')).statusCode).toBe(201);
  });

  it('rejects out-of-coverage coordinates and impossible travel', async () => {
    const { app } = await makeApp('attested');
    const device = await register(app);
    const toronto = await submit(app, device, { latitude: 43.6532, longitude: -79.3832 });
    expect(toronto.statusCode).toBe(400);

    expect((await submit(app, device)).statusCode).toBe(201);
    now = new Date(now.getTime() + 10 * 60_000);
    const kelowna = await submit(app, device, { latitude: 49.888, longitude: -119.496 });
    expect(kelowna.statusCode).toBe(403);
  });

  it('gates development installations behind explicit configuration and limits them', async () => {
    const enforced = await makeApp('attested');
    const development = authority.createDevelopmentDevice();
    const refused = await enforced.app.inject({
      method: 'POST',
      payload: {
        challenge: await challenge(enforced.app),
        keyId: development.keyId,
        kind: 'development',
        publicKey: development.publicKey,
      },
      url: '/v2/community/installations',
    });
    expect(refused.statusCode).toBe(403);

    const { app } = await makeApp('attested', 'allow-development');
    const registered = await app.inject({
      method: 'POST',
      payload: {
        challenge: await challenge(app),
        keyId: development.keyId,
        kind: 'development',
        publicKey: development.publicKey,
      },
      url: '/v2/community/installations',
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toMatchObject({ trust: 'untrusted' });

    expect((await submit(app, development)).statusCode).toBe(201);
    expect((await nearby(app)).reports).toEqual([]);
    expect((await submit(app, development, offset(400), 'pothole')).statusCode).toBe(201);
    expect((await submit(app, development, offset(800), 'pothole')).statusCode).toBe(429);
  });

  it('deletes own reports and whole installations, and keeps key ids out of the database', async () => {
    const { app } = await makeApp('attested');
    const reporter = await register(app);
    const other = await register(app);
    const { reportId } = (await submit(app, reporter)).json<{ reportId: string }>();

    const foreign = await app.inject({
      method: 'DELETE',
      payload: { assertion: await asserted(app, other, { kind: 'delete-report', reportId }) },
      url: `/v2/community/reports/${reportId}`,
    });
    expect(foreign.statusCode).toBe(404);
    const own = await app.inject({
      method: 'DELETE',
      payload: { assertion: await asserted(app, reporter, { kind: 'delete-report', reportId }) },
      url: `/v2/community/reports/${reportId}`,
    });
    expect(own.statusCode).toBe(200);
    expect((await nearby(app)).reports).toEqual([]);

    const stored = await admin.query<{ key_id_hash: Buffer; sealed_public_key: Buffer }>(
      `SELECT key_id_hash, sealed_public_key FROM ${SCHEMA}.community_installations`,
    );
    const keyId = Buffer.from(reporter.keyId, 'base64');
    for (const row of stored.rows) {
      expect(row.key_id_hash.equals(keyId)).toBe(false);
      expect(row.sealed_public_key.includes(keyId)).toBe(false);
    }

    const deleted = await app.inject({
      method: 'DELETE',
      payload: { assertion: await asserted(app, reporter, { kind: 'delete-installation' }) },
      url: '/v2/community/installations',
    });
    expect(deleted.statusCode).toBe(200);
    const afterwards = await submit(app, reporter, offset(400));
    expect(afterwards.statusCode).toBe(401);
    expect(afterwards.json()).toMatchObject({ title: 'Unknown installation' });
  });
});
