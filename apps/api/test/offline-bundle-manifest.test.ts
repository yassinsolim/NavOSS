import { mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OfflineBundleManifestSchema, ProblemDetailsSchema } from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixture from '../../../infra/offline/test/manifest-fixture.json' with { type: 'json' };
import { buildApp } from '../src/app.js';

const apps: FastifyInstance[] = [];
const directories: string[] = [];

async function createApp(value?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-offline-api-'));
  directories.push(directory);
  const path = join(directory, 'manifest.json');
  if (value !== undefined) await writeFile(path, JSON.stringify(value));
  vi.stubEnv('NAVOSS_OFFLINE_MANIFEST_PATH', path);
  const app = await buildApp();
  apps.push(app);
  return { app, path, directory };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

describe('GET /v1/offline/manifest', () => {
  it('serves the shared contract with an ETag, without proxying artifact URLs', async () => {
    const { app } = await createApp(fixture);
    const response = await app.inject({ method: 'GET', url: '/v1/offline/manifest' });
    expect(response.statusCode).toBe(200);
    expect(OfflineBundleManifestSchema.parse(response.json())).toEqual(fixture);
    expect(response.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    expect(response.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
    const head = await app.inject({ method: 'HEAD', url: '/v1/offline/manifest' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    const post = await app.inject({ method: 'POST', url: '/v1/offline/manifest' });
    expect(post.statusCode).toBe(404);
  });

  it('handles weak, strong and list conditional requests', async () => {
    const { app } = await createApp(fixture);
    const response = await app.inject({ method: 'GET', url: '/v1/offline/manifest' });
    const etag = String(response.headers.etag);
    for (const header of [etag, etag.slice(2), `"another", ${etag}`, '*']) {
      const cached = await app.inject({
        method: 'GET',
        url: '/v1/offline/manifest',
        headers: { 'if-none-match': header },
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe('');
    }
  });

  it('observes atomic file replacement and changes the ETag', async () => {
    const { app, path } = await createApp(fixture);
    const before = await app.inject({ method: 'GET', url: '/v1/offline/manifest' });
    const updated = { ...fixture, bundleVersion: '2026-11-11-v1-abcdef012345' };
    await writeFile(`${path}.next`, JSON.stringify(updated));
    await rename(`${path}.next`, path);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/offline/manifest',
      headers: { 'if-none-match': String(before.headers.etag) },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(updated);
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it('fails closed for absent, corrupt and unsupported manifests without leaking the path', async () => {
    const { app, path } = await createApp();
    for (const content of [
      undefined,
      '{invalid',
      JSON.stringify({ ...fixture, schemaVersion: 2 }),
    ]) {
      if (content !== undefined) await writeFile(path, content);
      const response = await app.inject({ method: 'GET', url: '/v1/offline/manifest' });
      expect(response.statusCode).toBe(503);
      expect(ProblemDetailsSchema.parse(response.json()).code).toBe('service_unavailable');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(path);
    }
  });

  it('bounds file reads and does not serve a stale ETag when the file becomes invalid', async () => {
    const { app, path } = await createApp(fixture);
    const before = await app.inject({ method: 'GET', url: '/v1/offline/manifest' });
    await truncate(path, 4 * 1024 * 1024 + 1);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/offline/manifest',
      headers: { 'if-none-match': String(before.headers.etag) },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers.etag).toBeUndefined();
  });

  it('remains unavailable when the optional environment location is not configured', async () => {
    vi.stubEnv('NAVOSS_OFFLINE_MANIFEST_PATH', '');
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/offline/manifest' });
    expect(response.statusCode).toBe(503);
  });
});
