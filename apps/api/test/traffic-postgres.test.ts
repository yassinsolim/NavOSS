import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import {
  communityAssertionClientData,
  TrafficCredentialResponseSchema,
  TrafficFlowResponseSchema,
  type CommunityAssertedOperation,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAppAttestVerifier } from '../src/app-attest.js';
import { buildApp } from '../src/app.js';
import { createCommunityReportService, type AttestationMode } from '../src/community-reports.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { runMigrations } from '../src/migrations.js';
import {
  createFixtureSearchProvider,
  isSupportedSearchCoordinate,
} from '../src/search-provider.js';
import { decodePolyline6 } from '../src/traffic/geo.js';
import {
  createTrafficService,
  type TrafficAttestation,
  type TrafficMaintenanceFailure,
} from '../src/traffic/service.js';
import type { TrafficSettings } from '../src/traffic/settings.js';
import { createPostgresTrafficReleaseStore } from '../src/traffic/store.js';
import { createTestAppAttestAuthority, type TestDevice } from './support/app-attest-fixture.js';
import {
  credentialFor,
  DRIVE,
  driveBatch,
  fakeAttestation,
  FIXTURE_SETTINGS,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
} from './traffic-fixture.js';

/**
 * Runs against a real PostGIS. Locally: `docker run -d --name api-traffic-postgis -e
 * POSTGRES_USER=navoss -e POSTGRES_PASSWORD=navoss -e POSTGRES_DB=navoss -p 127.0.0.1:5442:5432
 * postgis/postgis:16-3.5-alpine`. Skips when no database is reachable unless
 * NAVOSS_REQUIRE_TEST_DATABASE=1.
 */
const DATABASE_URL =
  process.env.NAVOSS_TRAFFIC_TEST_DATABASE_URL ?? 'postgres://navoss:navoss@127.0.0.1:5442/navoss';
const SCHEMA = `traffic_test_${randomBytes(6).toString('hex')}`;
// A database of its own: an unmigrated schema would still see tables in `public`.
const EMPTY_DATABASE = `${SCHEMA}_empty`;
const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'org.navoss.mobile';
const EPOCH_MS = 300_000;
const FLOW_URL = '/v2/traffic/flow?bbox=9.45,47.10,9.60,47.20';

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
    if (process.env.NAVOSS_REQUIRE_TEST_DATABASE === '1') {
      throw new Error('Test database required.');
    }
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

describe.skipIf(!(await databaseAvailable()))('community traffic on PostGIS', () => {
  const authority = createTestAppAttestAuthority({ bundleId: BUNDLE_ID, teamId: TEAM_ID });
  const apps: FastifyInstance[] = [];
  let admin: Pool;
  let nowMs = NOW.getTime();
  const clock = (): Date => new Date(nowMs);

  // `public` stays on the path for the PostGIS types; the test schema is searched first.
  const schemaPool = (): Pool =>
    new Pool({
      connectionString: DATABASE_URL,
      max: 4,
      options: `-c search_path=${SCHEMA},public`,
    });

  const emptyDatabasePool = (): Pool => {
    const url = new URL(DATABASE_URL);
    url.pathname = `/${EMPTY_DATABASE}`;
    return new Pool({ connectionString: url.toString(), max: 2 });
  };

  interface TrafficAppOptions {
    /** `real` verifies assertions against the community installation tables in this database. */
    attestation?: 'fake' | 'real';
    attestationMode?: AttestationMode;
    settings?: Partial<TrafficSettings>;
  }

  async function createApp(options: TrafficAppOptions = {}) {
    const stub = stubbedMatcher();
    const logLines: string[] = [];
    const failures: TrafficMaintenanceFailure[] = [];
    const communityReports =
      options.attestation === 'real'
        ? createCommunityReportService({
            attestationMode: options.attestationMode ?? 'enforce',
            clock,
            installationSecret: Buffer.alloc(32, 7),
            isInCoverage: isSupportedSearchCoordinate,
            pool: schemaPool(),
            publication: 'shadow',
            verifier: createAppAttestVerifier({
              bundleId: BUNDLE_ID,
              environment: 'production',
              rootCertificatePem: authority.rootPem,
              teamId: TEAM_ID,
            }),
          })
        : null;
    const attestation: TrafficAttestation = communityReports ?? fakeAttestation();
    const service = createTrafficService({
      attestation,
      clock,
      mapMatcher: stub.matcher,
      onMaintenanceFailure: (failure) => failures.push(failure),
      settings: { ...FIXTURE_SETTINGS, ...options.settings },
      store: createPostgresTrafficReleaseStore(schemaPool()),
    });
    const app = await buildApp({
      clock,
      communityReports,
      logger: {
        level: 'trace',
        stream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            logLines.push(chunk.toString('utf8'));
            done();
          },
        }),
      },
      searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
      trafficService: service,
    });
    await app.ready();
    apps.push(app);
    return { app, failures, logLines, service, stub };
  }

  function post(
    app: FastifyInstance,
    credential: string,
    gaps?: readonly number[],
    address = '198.51.100.1',
  ) {
    const capturedAt = new Date(Math.floor(nowMs / 60_000) * 60_000 - 300_000).toISOString();
    return app.inject({
      headers: { 'x-forwarded-for': address },
      method: 'POST',
      payload: driveBatch(credential, gaps, capturedAt),
      url: '/v2/traffic/probes',
    });
  }

  async function advanceEpoch(service: { runEpoch(): Promise<void> }): Promise<void> {
    nowMs = (Math.floor(nowMs / EPOCH_MS) + 1) * EPOCH_MS + 5_000;
    await service.runEpoch();
  }

  async function flowFeatures(app: FastifyInstance, url = FLOW_URL) {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    return TrafficFlowResponseSchema.parse(response.json()).features;
  }

  /** Every row of every table in the test schema, with its transaction id and physical address. */
  async function dumpDatabase(): Promise<string> {
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name <> 'spatial_ref_sys'
       ORDER BY table_name`,
      [SCHEMA],
    );
    const dumps: string[] = [];
    for (const { table_name: table } of tables.rows) {
      const rows = await admin.query<{ row: string }>(
        `SELECT xmin::text || ' ' || ctid::text || ' ' || row_to_json(t)::text AS row
         FROM ${SCHEMA}.${table} t ORDER BY t.ctid`,
      );
      dumps.push(`${table}\n${rows.rows.map(({ row }) => row).join('\n')}`);
    }
    return dumps.join('\n');
  }

  const releaseRows = () =>
    admin.query<{
      ctid: string;
      expires_at: Date;
      released_at: Date;
      segment_key: string;
      xmin: string;
    }>(
      `SELECT xmin::text, ctid::text, segment_key, released_at, expires_at
       FROM ${SCHEMA}.traffic_releases t ORDER BY t.ctid`,
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`CREATE DATABASE ${EMPTY_DATABASE}`);
    const pool = schemaPool();
    try {
      await runMigrations(pool);
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    nowMs = NOW.getTime();
    await admin.query(
      `TRUNCATE ${SCHEMA}.traffic_releases, ${SCHEMA}.community_report_votes,
                ${SCHEMA}.community_reports, ${SCHEMA}.community_installations,
                ${SCHEMA}.community_challenges`,
    );
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DROP DATABASE IF EXISTS ${EMPTY_DATABASE} WITH (FORCE)`);
    await admin.end();
  });

  it('gets its one table from the shared migration runner', async () => {
    const tables = await admin.query<{ relname: string; relpersistence: string }>(
      `SELECT c.relname, c.relpersistence FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'traffic%' ORDER BY 1`,
      [SCHEMA],
    );
    // One unlogged table: no separate migration ledger, no segment or bucket tables.
    expect(tables.rows).toEqual([{ relname: 'traffic_releases', relpersistence: 'u' }]);
    const applied = await admin.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.navoss_schema_migrations ORDER BY id`,
    );
    expect(applied.rows.map(({ id }) => id)).toEqual([
      '0001_community_reports',
      '0002_community_traffic',
    ]);
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'traffic_releases' ORDER BY 1`,
      [SCHEMA],
    );
    expect(columns.rows.map(({ column_name: name }) => name)).toEqual([
      'expires_at',
      'free_flow_kph',
      'geom',
      'released_at',
      'road_class',
      'segment_key',
      'speed_kph',
    ]);
  });

  it('refuses to start collecting on a database that was not migrated, but starts when off', async () => {
    const build = (mode: TrafficSettings['mode']) =>
      createTrafficService({
        attestation: fakeAttestation(),
        mapMatcher: stubbedMatcher().matcher,
        settings: { ...FIXTURE_SETTINGS, mode },
        store: createPostgresTrafficReleaseStore(emptyDatabasePool()),
      });
    for (const mode of ['collect', 'live'] as const) {
      const enabled = build(mode);
      await expect(enabled.start()).rejects.toThrow(/migrations are pending/);
      await enabled.close();
    }

    const off = build('off');
    await expect(off.start()).resolves.toBeUndefined();
    await off.close();
    // Neither attempt created anything: the API never applies a migration itself.
    const pool = emptyDatabasePool();
    try {
      const created = await pool.query<{ present: boolean }>(
        `SELECT to_regclass('traffic_releases') IS NOT NULL
           OR to_regclass('navoss_schema_migrations') IS NOT NULL AS present`,
      );
      expect(created.rows[0]?.present).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('stores nothing until a cohort of three is released at an epoch boundary', async () => {
    const { app, service } = await createApp();
    const before = await dumpDatabase();

    for (const device of ['phone-1', 'phone-2']) {
      expect((await post(app, await credentialFor(service, device))).statusCode).toBe(202);
    }
    // The same installation again with a new credential from another network.
    await post(app, await credentialFor(service, 'phone-2'), JAMMED_GAPS, '2001:db8:12:3400::1');
    expect(await dumpDatabase()).toBe(before);
    await advanceEpoch(service);
    // Two contributors: the database is byte for byte what it was before any upload.
    expect(await dumpDatabase()).toBe(before);
    expect(await flowFeatures(app)).toEqual([]);

    await post(app, await credentialFor(service, 'phone-3'), JAMMED_GAPS);
    expect(await dumpDatabase()).toBe(before);
    await advanceEpoch(service);
    const features = await flowFeatures(app);

    expect(features.length).toBeGreaterThan(10);
    for (const feature of features) {
      // Two of three contributors drove at 40 km/h, so the median ignores the crawl.
      expect(feature.properties).toEqual({
        congestion: 'free',
        freeFlowKph: 51,
        observedAt: '2026-11-12T18:10:00.000Z',
        speedKph: 40,
      });
    }
    expect((await releaseRows()).rowCount).toBe(features.length);
    // Outside the box nothing is returned.
    expect(await flowFeatures(app, '/v2/traffic/flow?bbox=9.60,47.20,9.70,47.30')).toEqual([]);
  });

  it('adjusts a route from the published rows', async () => {
    const { app, service } = await createApp({ settings: { routeMinCoverage: 0.4 } });
    for (const device of ['phone-1', 'phone-2', 'phone-3']) {
      await post(app, await credentialFor(service, device), JAMMED_GAPS);
    }
    await advanceEpoch(service);
    const result = await service.enrichRoutes([{ ...DRIVE.route, label: 'fastest' as const }]);

    expect(result.trafficSource?.id).toBe('navoss-community');
    expect(result.routes[0]?.traffic?.delaySeconds).toBeGreaterThan(20);
    expect(new Set(result.routes[0]?.congestion)).toEqual(
      new Set(['unknown', 'free', 'slow', 'heavy']),
    );
  });

  it('writes each epoch as one mixed, ordered transaction on the epoch grid', async () => {
    const { app, service } = await createApp();
    const addresses = ['198.51.100.1', '203.0.113.7', '2001:db8:12:3400::1'];
    for (const [index, address] of addresses.entries()) {
      await post(app, await credentialFor(service, `phone-${String(index)}`), undefined, address);
    }
    await advanceEpoch(service);
    const rows = (await releaseRows()).rows;

    expect(rows.length).toBeGreaterThan(10);
    // Every segment of the three batches shares one transaction id: row versions cannot be
    // grouped back into the roads of one upload.
    expect(new Set(rows.map(({ xmin }) => xmin)).size).toBe(1);
    // Physical order is key order, not arrival order.
    expect(rows.map(({ segment_key: key }) => key)).toEqual(
      rows.map(({ segment_key: key }) => key).sort(),
    );
    // The only times stored are epoch boundaries.
    for (const row of rows) {
      expect(row.released_at.toISOString()).toBe('2026-11-12T18:05:00.000Z');
      expect(row.expires_at.toISOString()).toBe('2026-11-12T18:20:00.000Z');
    }
  });

  it('persists and logs no uploaded position, address, credential or fine timestamp', async () => {
    const { app, failures, logLines, service, stub } = await createApp();
    const addresses = ['198.51.100.1', '198.51.100.2', '2001:db8:12:3400::1'];
    const credentials: string[] = [];
    for (const [index, address] of addresses.entries()) {
      const credential = await credentialFor(service, `phone-${String(index)}`);
      credentials.push(credential);
      expect((await post(app, credential, JAMMED_GAPS, address)).statusCode).toBe(202);
    }
    // Failure paths must be as quiet as success.
    stub.failNext(502);
    const failing = await credentialFor(service, 'phone-9');
    credentials.push(failing);
    expect((await post(app, failing, undefined, '198.51.100.4')).statusCode).toBe(503);
    expect((await post(app, 'A'.repeat(64), undefined, '198.51.100.5')).statusCode).toBe(401);
    await advanceEpoch(service);
    expect((await flowFeatures(app)).length).toBeGreaterThan(10);
    // A storage failure at the boundary is reported by name only.
    await post(app, await credentialFor(service, 'phone-0'));
    await post(app, await credentialFor(service, 'phone-1'));
    await post(app, await credentialFor(service, 'phone-2'));
    // Every insert into this schema's table now fails. (Renaming the table away would not do:
    // the name would then resolve to a `traffic_releases` in `public`, if one exists.)
    await admin.query(
      `ALTER TABLE ${SCHEMA}.traffic_releases ADD CONSTRAINT storage_down CHECK (false) NOT VALID`,
    );
    try {
      await advanceEpoch(service);
    } finally {
      await admin.query(`ALTER TABLE ${SCHEMA}.traffic_releases DROP CONSTRAINT storage_down`);
    }
    expect(failures).toEqual(['epoch']);
    expect(service.metrics().epochFailures).toBe(1);
    // What the operator summary logs: finite numbers, nothing that could name a road or a time.
    for (const value of Object.values(service.metrics())) expect(Number.isFinite(value)).toBe(true);

    const database = await dumpDatabase();
    const logs = logLines.join('');
    expect(database).toMatch(/w\d+[fb]-[0-9a-f]{12}/);

    const uploaded = driveBatch('x'.repeat(64), JAMMED_GAPS).points;
    const roadVertices = new Set(
      decodePolyline6(DRIVE.traceResponse.shape).map((vertex) => vertex.join(',')),
    );
    // Through a pool whose search path includes the test schema: on a database without PostGIS
    // in `public`, the migration installs the extension there.
    const geometryPool = schemaPool();
    const stored = await geometryPool
      .query<{ line: [number, number][] }>(
        `SELECT ST_AsGeoJSON(geom, 6)::json -> 'coordinates' AS line FROM traffic_releases`,
      )
      .finally(() => geometryPool.end());
    const storedVertices = stored.rows.flatMap(({ line }) =>
      line.map((vertex) => vertex.join(',')),
    );
    expect(storedVertices.length).toBeGreaterThan(20);
    // Every stored coordinate is a vertex of the OpenStreetMap road geometry Valhalla returned.
    for (const vertex of storedVertices) expect(roadVertices.has(vertex)).toBe(true);
    for (const [longitude, latitude] of uploaded) {
      expect(storedVertices).not.toContain(`${String(longitude)},${String(latitude)}`);
      expect(logs).not.toContain(String(longitude));
      expect(logs).not.toContain(String(latitude));
    }
    for (const text of [database, logs]) {
      for (const secret of [...addresses, '198.51.100', '2001:db8', ...credentials, 'phone-']) {
        expect(text).not.toContain(secret);
      }
    }
    // Every timestamp anywhere in the traffic table is on the five-minute grid.
    const fine = await admin.query(
      `SELECT 1 FROM ${SCHEMA}.traffic_releases
       WHERE extract(epoch FROM released_at)::bigint % 300 <> 0
          OR extract(epoch FROM expires_at)::bigint % 300 <> 0
          OR released_at <> date_trunc('second', released_at)`,
    );
    expect(fine.rowCount).toBe(0);
  });

  it('deletes a release at the boundary it expires on, and stops serving it even if cleanup fails', async () => {
    const { app, service } = await createApp();
    for (const device of ['phone-1', 'phone-2', 'phone-3']) {
      await post(app, await credentialFor(service, device));
    }
    await advanceEpoch(service);
    expect((await releaseRows()).rowCount).toBeGreaterThan(10);

    // 18:20, the expiry boundary, before any cleanup has run: already not served.
    nowMs = Date.parse('2026-11-12T18:20:00Z');
    expect(await flowFeatures(app)).toEqual([]);
    expect((await releaseRows()).rowCount).toBeGreaterThan(10);
    await service.runEpoch();
    expect((await releaseRows()).rowCount).toBe(0);
  });

  it('stores nothing at all while only collecting, even for a cohort of three', async () => {
    const { app, service } = await createApp({ settings: { mode: 'collect' } });
    const before = await dumpDatabase();
    for (const device of ['phone-1', 'phone-2', 'phone-3']) {
      expect((await post(app, await credentialFor(service, device))).statusCode).toBe(202);
    }
    await advanceEpoch(service);

    // The cohorts were formed and counted for the operator, then thrown away.
    expect(service.metrics().segmentsReleased).toBeGreaterThan(10);
    expect(service.metrics().pendingSamples).toBe(0);
    expect((await releaseRows()).rowCount).toBe(0);
    expect(await dumpDatabase()).toBe(before);
  });

  it('has the publication rules as database constraints', async () => {
    const insert = (overrides: Record<string, string>) => {
      const row = {
        expires_at: `'2026-11-12T18:20:00Z'`,
        free_flow_kph: '50',
        geom: `ST_SetSRID(ST_MakeLine(ST_MakePoint(9.5, 47.1), ST_MakePoint(9.51, 47.1)), 4326)`,
        released_at: `'2026-11-12T18:05:00Z'`,
        road_class: `'primary'`,
        segment_key: `'w1f-0123456789ab'`,
        speed_kph: '40',
        ...overrides,
      };
      const pool = schemaPool();
      return pool
        .query(
          `INSERT INTO traffic_releases (${Object.keys(row).join(', ')})
           VALUES (${Object.values(row).join(', ')})`,
        )
        .finally(() => pool.end());
    };

    await expect(insert({})).resolves.toMatchObject({ rowCount: 1 });
    await admin.query(`TRUNCATE ${SCHEMA}.traffic_releases`);
    // An exact speed, a minor road, a time off the five-minute grid, a lifetime over 15 minutes,
    // and a key that is not one whole edge.
    await expect(insert({ speed_kph: '43' })).rejects.toThrow(/check constraint/);
    await expect(insert({ road_class: `'tertiary'` })).rejects.toThrow(/check constraint/);
    await expect(insert({ road_class: `'residential'` })).rejects.toThrow(/check constraint/);
    await expect(insert({ released_at: `'2026-11-12T18:05:07Z'` })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert({ expires_at: `'2026-11-12T18:25:00Z'` })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert({ segment_key: `'w1f'` })).rejects.toThrow(/check constraint/);
    expect((await releaseRows()).rowCount).toBe(0);
  });

  it.each(['off', 'collect', 'live'] as const)(
    'erases stored releases when the API starts in %s mode',
    async (mode) => {
      const first = await createApp();
      for (const device of ['phone-1', 'phone-2', 'phone-3']) {
        await post(first.app, await credentialFor(first.service, device));
      }
      await advanceEpoch(first.service);
      expect((await releaseRows()).rowCount).toBeGreaterThan(10);
      await first.app.close();
      apps.length = 0;

      // The documented rollback: set the mode and restart.
      const restarted = await createApp({ settings: { mode } });
      expect((await releaseRows()).rowCount).toBe(0);
      expect(restarted.failures).toEqual([]);
    },
  );

  describe('with real App Attest installations', () => {
    async function challenge(app: FastifyInstance): Promise<string> {
      const response = await app.inject({ method: 'POST', url: '/v2/community/challenges' });
      expect(response.statusCode).toBe(200);
      return response.json<{ challenge: string }>().challenge;
    }

    async function register(app: FastifyInstance): Promise<TestDevice> {
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
      return device;
    }

    async function requestCredential(
      app: FastifyInstance,
      device: TestDevice,
      operation: CommunityAssertedOperation = { kind: 'traffic-credential' },
    ) {
      const value = await challenge(app);
      const assertion = {
        assertion: device.assert(communityAssertionClientData(value, operation)),
        challenge: value,
        keyId: device.keyId,
      };
      const response = await app.inject({
        method: 'POST',
        payload: { assertion },
        url: '/v2/traffic/credentials',
      });
      return { assertion, response };
    }

    async function credential(app: FastifyInstance, device: TestDevice): Promise<string> {
      const { response } = await requestCredential(app, device);
      expect(response.statusCode).toBe(200);
      return TrafficCredentialResponseSchema.parse(response.json()).credential;
    }

    it('counts an attested device once per segment and publishes for three devices', async () => {
      const { app, service } = await createApp({ attestation: 'real' });
      const [first, second, third] = [
        await register(app),
        await register(app),
        await register(app),
      ];

      await post(app, await credential(app, first), undefined, '198.51.100.1');
      await post(app, await credential(app, second), undefined, '198.51.100.2');
      // The second device again: three more credentials, three more networks.
      for (const address of ['203.0.113.4', '192.0.2.8', '2001:db8:77::1']) {
        const response = await post(app, await credential(app, second), JAMMED_GAPS, address);
        expect(response.statusCode).toBe(202);
      }
      await advanceEpoch(service);
      expect(await flowFeatures(app)).toEqual([]);

      await post(app, await credential(app, third), undefined, '198.51.100.1');
      await advanceEpoch(service);
      expect((await flowFeatures(app)).length).toBeGreaterThan(10);
    });

    it('refuses a credential without a fresh assertion from a registered, attested key', async () => {
      const { app } = await createApp({ attestation: 'real' });
      const device = await register(app);

      // An unregistered key.
      const stranger = await requestCredential(app, authority.createDevice());
      expect(stranger.response.statusCode).toBe(401);
      // An assertion made for another operation.
      const moved = await requestCredential(app, device, { kind: 'delete-installation' });
      expect(moved.response.statusCode).toBe(403);
      // A replayed request: the challenge is one-use.
      const issued = await requestCredential(app, device);
      expect(issued.response.statusCode).toBe(200);
      const replayed = await app.inject({
        method: 'POST',
        payload: { assertion: issued.assertion },
        url: '/v2/traffic/credentials',
      });
      expect(replayed.statusCode).toBe(401);
    });

    it('refuses development keys while attestation is enforced and accepts them only when allowed', async () => {
      const lenient = await createApp({
        attestation: 'real',
        attestationMode: 'allow-development',
      });
      const simulator = authority.createDevelopmentDevice();
      const value = await challenge(lenient.app);
      const registered = await lenient.app.inject({
        method: 'POST',
        payload: {
          challenge: value,
          keyId: simulator.keyId,
          kind: 'development',
          publicKey: simulator.publicKey,
        },
        url: '/v2/community/installations',
      });
      expect(registered.statusCode).toBe(201);
      expect((await requestCredential(lenient.app, simulator)).response.statusCode).toBe(200);

      // The same, already registered, development installation against an enforcing server.
      const strict = await createApp({ attestation: 'real' });
      const refused = await requestCredential(strict.app, simulator);
      expect(refused.response.statusCode).toBe(403);
    });

    it('stores nothing that links a release, or an upload, to an installation', async () => {
      const { app, service } = await createApp({ attestation: 'real' });
      const devices = [await register(app), await register(app), await register(app)];
      const installations = await admin.query<{ id: string; key_id_hash: Buffer }>(
        `SELECT id, key_id_hash FROM ${SCHEMA}.community_installations`,
      );
      const credentials: string[] = [];
      for (const device of devices) {
        const issued = await credential(app, device);
        credentials.push(issued);
        await post(app, issued);
      }
      await advanceEpoch(service);
      expect((await releaseRows()).rowCount).toBeGreaterThan(10);

      const traffic = await admin.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM ${SCHEMA}.traffic_releases t`,
      );
      const stored = traffic.rows.map(({ row }) => row).join('\n');
      for (const { id, key_id_hash: hash } of installations.rows) {
        expect(stored).not.toContain(id);
        expect(stored).not.toContain(hash.toString('hex'));
      }
      const everything = await dumpDatabase();
      for (const issued of credentials) expect(everything).not.toContain(issued);
      // No table but traffic_releases mentions a road segment, and the installation table has
      // no traffic column: there is nothing to join.
      const withSegments = everything
        .split(/\n(?=[a-z_]+\n)/)
        .filter((table) => /w\d+[fb]-[0-9a-f]{12}/.test(table))
        .map((table) => table.split('\n')[0]);
      expect(withSegments).toEqual(['traffic_releases']);
      const foreignKeys = await admin.query(
        `SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = $1 AND table_name = 'traffic_releases'
           AND constraint_type = 'FOREIGN KEY'`,
        [SCHEMA],
      );
      expect(foreignKeys.rowCount).toBe(0);
    });
  });
});
