import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareRenderer } from '../../../infra/offline/verify/prepare.mjs';
import {
  byteRange,
  contentSecurityPolicy,
  safePath,
  verificationServer,
} from '../../../infra/offline/verify/server.mjs';
import fixture from '../../../infra/offline/test/manifest-fixture.json' with { type: 'json' };

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('offline verifier byte ranges and isolation', () => {
  it('supports PMTiles open, closed and suffix ranges without off-by-one bytes', () => {
    expect(byteRange('bytes=0-126', 1000)).toEqual({ start: 0, end: 126, partial: true });
    expect(byteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999, partial: true });
    expect(byteRange('bytes=-127', 1000)).toEqual({ start: 873, end: 999, partial: true });
    expect(byteRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999, partial: true });
    expect(byteRange(undefined, 1000)).toEqual({ start: 0, end: 999, partial: false });
    for (const value of [
      'bytes=1000-',
      'bytes=2-1',
      'bytes=-0',
      'bytes=0-1,3-4',
      'bytes=-',
      'items=0-1',
    ])
      expect(() => byteRange(value, 1000)).toThrow();
  });

  it('refuses traversal and blocks external network by browser policy', () => {
    expect(safePath('/bundle', '/glyphs/Noto%20Sans%20Regular/0-255.pbf')).toBe(
      '/bundle/glyphs/Noto Sans Regular/0-255.pbf',
    );
    for (const path of [
      '/../private',
      '/%2e%2e/private',
      '/foo/../../private',
      '/%5c..%5cprivate',
      '/%00',
    ])
      expect(() => safePath('/bundle', path)).toThrow();
    expect(contentSecurityPolicy()).toContain("connect-src 'self'");
    expect(contentSecurityPolicy()).toContain("default-src 'none'");
  });

  it('serves real HTTP 206/416 and HEAD from an immutable test release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navoss-offline-http-'));
    directories.push(root);
    const regionDirectory = join(root, 'releases', fixture.bundleVersion, 'regions/calgary');
    await mkdir(regionDirectory, { recursive: true });
    await writeFile(join(root, 'manifest.json'), JSON.stringify(fixture));
    await writeFile(
      join(root, 'releases', fixture.bundleVersion, 'build-report.json'),
      JSON.stringify({ caches: { resources: 'shared/test' } }),
    );
    await writeFile(join(regionDirectory, 'maps.pmtiles'), '0123456789');
    const server = await verificationServer(root, 'calgary', 0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      const url = `http://127.0.0.1:${String(address.port)}/bundle/maps.pmtiles`;
      const range = await fetch(url, { headers: { Range: 'bytes=2-5' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(range.headers.get('content-length')).toBe('4');
      expect(await range.text()).toBe('2345');
      const invalid = await fetch(url, { headers: { Range: 'bytes=10-' } });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('content-range')).toBe('bytes */10');
      const head = await fetch(url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe('10');
      expect(await head.text()).toBe('');
      const post = await fetch(url, { method: 'POST' });
      expect(post.status).toBe(405);
    } finally {
      await promisify(server.close.bind(server))();
    }
  });

  it('fails closed on a corrupted cached renderer archive before any download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navoss-renderer-integrity-'));
    directories.push(root);
    await mkdir(join(root, 'verify/vendor'), { recursive: true });
    await writeFile(join(root, 'verify/vendor/maplibre-gl.tgz'), 'not the locked archive');
    await expect(prepareRenderer(root)).rejects.toThrow('Cached renderer checksum mismatch');
    expect(await readFile(join(root, 'verify/vendor/maplibre-gl.tgz'), 'utf8')).toBe(
      'not the locked archive',
    );
  });
});
