import { Writable } from 'node:stream';

import { TrafficFlowResponseSchema, TrafficStatusResponseSchema } from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import { decodePolyline6 } from '../src/traffic/geo.js';
import { applyTrafficMigrations } from '../src/traffic/migrations.js';
import { createTrafficService } from '../src/traffic/service.js';
import type { TrafficSettings } from '../src/traffic/settings.js';
import { createPostgresTrafficStore } from '../src/traffic/store.js';
import {
  DRIVE,
  driveBatch,
  FIXTURE_SETTINGS,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
} from './traffic-fixture.js';

// Local PostGIS for this slice:
//   docker run -d --name api-traffic-postgis -p 127.0.0.1:5442:5432 -e POSTGRES_DB=navoss \
//     -e POSTGRES_USER=navoss -e POSTGRES_PASSWORD=navoss postgis/postgis:16-3.5-alpine
const CONNECTION = {
  connectionTimeoutMillis: 1_500,
  database: process.env.TRAFFIC_TEST_PGDATABASE ?? 'navoss',
  host: process.env.TRAFFIC_TEST_PGHOST ?? '127.0.0.1',
  password: process.env.TRAFFIC_TEST_PGPASSWORD ?? 'navoss',
  port: Number(process.env.TRAFFIC_TEST_PGPORT ?? 5442),
  user: process.env.TRAFFIC_TEST_PGUSER ?? 'navoss',
};

async function postgisAvailable(): Promise<boolean> {
  const probe = new Pool({ ...CONNECTION, max: 1 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const FLOW_URL = '/v1/traffic/flow?bbox=9.45,47.10,9.60,47.20';

describe.skipIf(!(await postgisAvailable()))('community traffic on PostGIS', () => {
  const admin = new Pool({ ...CONNECTION, max: 2 });
  const apps: FastifyInstance[] = [];

  async function createApp(settings: Partial<TrafficSettings> = {}, clock = () => NOW) {
    const stub = stubbedMatcher();
    const logLines: string[] = [];
    const service = createTrafficService({
      clock,
      mapMatcher: stub.matcher,
      settings: { ...FIXTURE_SETTINGS, ...settings },
      store: createPostgresTrafficStore(new Pool({ ...CONNECTION, max: 4 })),
    });
    const app = await buildApp({
      clock,
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
    apps.push(app);
    return { app, logLines, service, stub };
  }

  function upload(app: FastifyInstance, address: string, gaps?: readonly number[]) {
    return app.inject({
      headers: { 'x-forwarded-for': address },
      method: 'POST',
      payload: driveBatch(gaps),
      url: '/v1/traffic/probes',
    });
  }

  /** Every row of every table in the database, rendered as text. */
  async function dumpDatabase(): Promise<string> {
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'spatial_ref_sys'`,
    );
    const dumps = await Promise.all(
      tables.rows.map(async ({ table_name: table }) => {
        const rows = await admin.query<{ row: string }>(
          `SELECT row_to_json(t)::text AS row FROM ${table} t`,
        );
        return `${table}\n${rows.rows.map(({ row }) => row).join('\n')}`;
      }),
    );
    return dumps.join('\n');
  }

  beforeAll(async () => {
    await admin.query(
      'DROP TABLE IF EXISTS traffic_flow_buckets, traffic_segments, traffic_schema_migrations',
    );
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await admin.end();
  });

  it('creates its schema once and reapplies cleanly', async () => {
    const client = await admin.connect();
    try {
      expect(await applyTrafficMigrations(client)).toEqual(['0001_community_traffic']);
      expect(await applyTrafficMigrations(client)).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('enforces the contributor threshold in the database', async () => {
    const { app } = await createApp();

    await upload(app, '198.51.100.1');
    await upload(app, '198.51.100.2');
    await upload(app, '198.51.100.2');
    expect(TrafficFlowResponseSchema.parse((await app.inject(FLOW_URL)).json()).features).toEqual(
      [],
    );
    const withheld = TrafficStatusResponseSchema.parse(
      (await app.inject('/v1/traffic/status')).json(),
    );
    expect(withheld.coverage?.publishedSegments).toBe(0);
    expect(withheld.coverage?.observedSegments).toBeGreaterThan(3);
    expect(withheld.coverage?.samples).toBe((withheld.coverage?.observedSegments ?? 0) * 2);

    await upload(app, '2001:db8:12:3400::1', JAMMED_GAPS);
    const flow = TrafficFlowResponseSchema.parse((await app.inject(FLOW_URL)).json());

    expect(flow.features.length).toBeGreaterThan(3);
    expect(flow.coverage.publishedSegments).toBe(flow.features.length);
    for (const feature of flow.features) {
      expect(feature.properties.sampleCount).toBe(3);
      // Two of three contributors drove at 40 km/h, so the median ignores the crawl.
      expect(feature.properties.congestion).toBe('free');
      expect(feature.properties.observedAt).toBe('2026-11-12T18:00:00.000Z');
    }
    // Outside the box nothing is returned.
    expect(
      TrafficFlowResponseSchema.parse(
        (await app.inject('/v1/traffic/flow?bbox=9.60,47.20,9.70,47.30')).json(),
      ).features,
    ).toEqual([]);
  });

  it('adjusts a route from the published rows', async () => {
    const { app, service } = await createApp({ routeMinCoverage: 0.4 });
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      await upload(app, address, JAMMED_GAPS);
    }
    const result = await service.enrichRoutes([{ ...DRIVE.route, label: 'fastest' as const }]);

    expect(result.trafficSource?.id).toBe('navoss-community');
    expect(result.routes[0]?.traffic?.delaySeconds).toBeGreaterThan(20);
    expect(new Set(result.routes[0]?.congestion)).toEqual(
      new Set(['unknown', 'free', 'slow', 'heavy']),
    );
  });

  it('persists and logs no uploaded position, trace, address or fine timestamp', async () => {
    const { app, logLines, stub } = await createApp();
    const addresses = ['198.51.100.1', '198.51.100.2', '2001:db8:12:3400::1'];
    for (const address of addresses) {
      expect((await upload(app, address, JAMMED_GAPS)).statusCode).toBe(202);
    }
    // Failure paths must be as quiet as success.
    stub.failNext(502);
    expect((await upload(app, '198.51.100.4')).statusCode).toBe(503);
    await admin.query('ALTER TABLE traffic_flow_buckets RENAME TO traffic_flow_buckets_hidden');
    try {
      expect((await upload(app, '198.51.100.5')).statusCode).toBe(503);
    } finally {
      await admin.query('ALTER TABLE traffic_flow_buckets_hidden RENAME TO traffic_flow_buckets');
    }
    expect((await app.inject(FLOW_URL)).statusCode).toBe(200);

    const database = await dumpDatabase();
    const logs = logLines.join('');
    expect(database).toContain('traffic_segments');
    expect(database).toMatch(/w\d+[fb]/);

    const uploaded = driveBatch(JAMMED_GAPS).points;
    const roadVertices = new Set(
      decodePolyline6((DRIVE.traceResponse as { shape: string }).shape).map((vertex) =>
        vertex.join(','),
      ),
    );
    const storedVertices = [...database.matchAll(/\[(-?\d+\.\d+),(-?\d+\.\d+)\]/g)].map(
      (match) => `${String(Number(match[1]))},${String(Number(match[2]))}`,
    );
    expect(storedVertices.length).toBeGreaterThan(20);
    // Every stored coordinate is a vertex of the OpenStreetMap road geometry Valhalla returned.
    for (const vertex of storedVertices) expect(roadVertices.has(vertex)).toBe(true);
    for (const [longitude, latitude] of uploaded) {
      const pair = `${String(longitude)},${String(latitude)}`;
      expect(storedVertices).not.toContain(pair);
      for (const text of [database, logs]) {
        expect(text).not.toContain(`${String(longitude)},${String(latitude)}`);
        expect(text).not.toContain(`${String(latitude)},${String(longitude)}`);
      }
      expect(logs).not.toContain(String(longitude));
      expect(logs).not.toContain(String(latitude));
    }
    for (const text of [database, logs]) {
      for (const address of [...addresses, '198.51.100', '2001:db8']) {
        expect(text).not.toContain(address);
      }
    }

    // The only times kept are five-minute bucket starts.
    const bucketStarts = await admin.query<{ bucket_start: Date }>(
      'SELECT DISTINCT bucket_start FROM traffic_flow_buckets',
    );
    expect(bucketStarts.rows.map(({ bucket_start: start }) => start.toISOString())).toEqual([
      '2026-11-12T17:55:00.000Z',
    ]);
    const columns = await admin.query<{ column_name: string; table_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'traffic\\_%' ESCAPE '\\'
         AND data_type IN ('timestamp with time zone', 'timestamp without time zone')
       ORDER BY 1, 2`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'bucket_start', table_name: 'traffic_flow_buckets' },
      { column_name: 'applied_at', table_name: 'traffic_schema_migrations' },
    ]);
  });

  it('expires buckets and forgets segments nobody is driving', async () => {
    let now = NOW;
    const { app, service } = await createApp({}, () => now);
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      await upload(app, address);
    }
    now = new Date(NOW.getTime() + 31 * 60_000);
    // The window alone already hides stale rows, before the sweeper removes them.
    expect(TrafficFlowResponseSchema.parse((await app.inject(FLOW_URL)).json()).features).toEqual(
      [],
    );

    const store = createPostgresTrafficStore(new Pool({ ...CONNECTION, max: 1 }));
    await store.expire(now.getTime() - (service.settings.windowSeconds + 300) * 1_000);
    await store.close();
    const remaining = await admin.query<{ buckets: string; segments: string }>(
      `SELECT (SELECT count(*) FROM traffic_flow_buckets)::text AS buckets,
              (SELECT count(*) FROM traffic_segments)::text AS segments`,
    );
    expect(remaining.rows[0]).toEqual({ buckets: '0', segments: '0' });
  });

  it('starts from nothing after a restart, because old contributor tokens cannot be compared', async () => {
    const first = await createApp();
    await upload(first.app, '198.51.100.1');
    await upload(first.app, '198.51.100.2');
    await first.app.close();
    apps.length = 0;

    const second = await createApp();
    await upload(second.app, '198.51.100.1');
    const status = TrafficStatusResponseSchema.parse(
      (await second.app.inject('/v1/traffic/status')).json(),
    );

    expect(status.coverage?.publishedSegments).toBe(0);
    expect(status.coverage?.samples).toBe(status.coverage?.observedSegments);
  });
});
