import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { parseBuildOptions } from '../../../infra/offline/build.mjs';
import { routingEnginePin } from '../../../infra/offline/engine.mjs';
import {
  createManifest,
  type BuiltRegion,
  type BuiltResources,
  type GraphIdentity,
} from '../../../infra/offline/manifest.mjs';
import { searchNormalization } from '../../../infra/offline/resources.mjs';
import fixture from '../../../infra/offline/test/manifest-fixture.json' with { type: 'json' };
import {
  bindOfflineStyle,
  createOfflineStyle,
  inspectArtifact,
  readMapMetadata,
  readRegionCatalog,
  validateManifest,
  writeRegion,
  type OfflineStyle,
  type RegionFeature,
} from '../../../infra/offline/tools.mjs';

const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-offline-tools-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function feature(): RegionFeature {
  const region = validateManifest(fixture).regions[0];
  if (!region) throw new Error('Missing region fixture');
  return {
    type: 'Feature',
    geometry: region.polygon,
    properties: {
      id: region.id,
      name: region.name,
      bounds: region.bounds,
      overlapMeters: region.overlapMeters,
      bulk: false,
    },
  };
}

const sourceStyle: OfflineStyle = {
  version: 8,
  sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    ne2_shaded: { type: 'raster', tiles: ['https://tiles.openfreemap.org/world.png'] },
  },
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm',
  layers: [
    { id: 'hillshade', source: 'ne2_shaded', type: 'raster' },
    { id: 'roads', source: 'openmaptiles', 'source-layer': 'transportation', type: 'line' },
  ],
};

describe('offline styles and installation layout', () => {
  it('retains vector styling while replacing every network-dependent resource', () => {
    const style = createOfflineStyle(sourceStyle, 'liberty');
    expect(style.layers).toEqual([sourceStyle.layers[1]]);
    expect(JSON.stringify(style)).not.toContain('tiles.openfreemap.org');
    expect(sourceStyle.sources.ne2_shaded).toBeDefined();
    const native = bindOfflineStyle(
      style,
      '/Application Support/NavOSS/calgary',
      '/Application Support/NavOSS/shared',
      'native',
    );
    expect(native.sources.openmaptiles?.url).toBe(
      'pmtiles://file:///Application%20Support/NavOSS/calgary/maps.pmtiles',
    );
    expect(native.glyphs).toBe(
      'file:///Application%20Support/NavOSS/shared/glyphs/{fontstack}/{range}.pbf',
    );
    const web = bindOfflineStyle(
      style,
      'http://127.0.0.1:3021/bundle',
      'http://127.0.0.1:3021/resources',
      'web',
    );
    expect(web.sources.openmaptiles?.url).toBe(
      'pmtiles://http://127.0.0.1:3021/bundle/maps.pmtiles',
    );
  });

  it('fails loudly when a new style depends on an unpackaged external source', () => {
    expect(() =>
      createOfflineStyle(
        {
          ...sourceStyle,
          sources: {
            ...sourceStyle.sources,
            remoteDem: { type: 'raster-dem', url: 'https://example.test/dem' },
          },
        },
        'liberty',
      ),
    ).toThrow('unsupported external source');
    expect(() => bindOfflineStyle(sourceStyle, '/bundle', '/resources', 'native')).toThrow(
      'Unsupported offline resource layout',
    );
    expect(() =>
      bindOfflineStyle(
        createOfflineStyle(sourceStyle, 'liberty'),
        'https://example.test/bundle',
        'https://example.test/resources',
        'web',
      ),
    ).toThrow('loopback');
  });

  it('uses the existing Calgary street-normalization convention, not a second alias table', () => {
    const aliases = searchNormalization();
    expect(aliases.avenue).toBe('av');
    expect(aliases.ave).toBe('av');
    expect(aliases.trail).toBe('tr');
    expect(aliases.southwest).toBe('sw');
  });
});

describe('bundle integrity and region data', () => {
  it('reports real file bytes and SHA-256 and rejects empty artifacts', async () => {
    const directory = await temporary();
    const path = join(directory, 'artifact');
    await writeFile(path, 'abc');
    expect(await inspectArtifact(path)).toEqual({
      byteSize: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    await writeFile(path, '');
    await expect(inspectArtifact(path)).rejects.toThrow('Missing artifact');
  });

  it('emits GeoJSON and a closed Osmium/Planetiler polygon from one footprint', async () => {
    const directory = await temporary();
    await writeRegion(feature(), directory);
    const collection = JSON.parse(await readFile(join(directory, 'region.geojson'), 'utf8')) as {
      features: RegionFeature[];
    };
    expect(collection.features[0]?.geometry).toEqual(feature().geometry);
    const polygon = await readFile(join(directory, 'region.poly'), 'utf8');
    expect(polygon.split('\n').filter((line) => line.trim() === '-114.6  50.6')).toHaveLength(2);
    expect(await readRegionCatalog(join(directory, 'region.geojson'))).toHaveLength(1);
    collection.features.push(feature());
    await writeFile(join(directory, 'region.geojson'), JSON.stringify(collection));
    await expect(readRegionCatalog(join(directory, 'region.geojson'))).rejects.toThrow(
      'duplicate region',
    );
  });

  it('checks PMTiles format, compression and embedded OpenMapTiles version', async () => {
    const directory = await temporary();
    const path = join(directory, 'maps.pmtiles');
    const header = Buffer.alloc(127);
    header.write('PMTiles');
    header[7] = 3;
    header[97] = 2;
    header[98] = 2;
    header[99] = 1;
    header[100] = 0;
    header[101] = 14;
    const metadata = gzipSync(
      Buffer.from(
        JSON.stringify({
          name: 'OpenMapTiles',
          version: '3.16.0',
          vector_layers: [{ id: 'transportation' }],
        }),
      ),
    );
    header.writeBigUInt64LE(127n, 24);
    header.writeBigUInt64LE(BigInt(metadata.length), 32);
    await writeFile(path, Buffer.concat([header, metadata]));
    expect(await readMapMetadata(path)).toMatchObject({
      schemaVersion: '3.16.0',
      minZoom: 0,
      maxZoom: 14,
    });
    header[99] = 6;
    await writeFile(path, Buffer.concat([header, metadata]));
    await expect(readMapMetadata(path)).rejects.toThrow('MVT');
    header[99] = 1;
    header.writeBigUInt64LE(2n ** 60n, 24);
    await writeFile(path, Buffer.concat([header, metadata]));
    await expect(readMapMetadata(path)).rejects.toThrow('offset/length');
  });
});

describe('content-addressed manifest production', () => {
  it('binds immutable URLs to actual artifact hashes and changes the release for changed bytes', () => {
    const parsed = validateManifest(fixture);
    const region = parsed.regions[0];
    if (!region) throw new Error('Missing region fixture');
    const graph: GraphIdentity = {
      graphId: parsed.graph.id,
      dataDate: parsed.dataDate,
      routingEngineVersion: '3.9.1',
      tileFormat: 'valhalla-gph',
      tileFormatVersion: '3.9.1',
      speedProfileSha256: parsed.graph.speedProfileSha256,
    };
    const built: BuiltRegion = {
      feature: feature(),
      key: 'test',
      directory: '/unused',
      files: {
        'maps.pmtiles': region.artifacts.maps,
        'routing.tar': region.artifacts.routing,
        'search.sqlite': region.artifacts.search,
      },
      maps: { schemaVersion: '3.16.0', minZoom: 0, maxZoom: 14 },
    };
    const resources: BuiltResources = {
      key: 'test',
      directory: '/unused',
      file: region.artifacts.resources,
      unpackedByteSize: region.artifacts.resources.unpackedByteSize,
    };
    const produce = () =>
      createManifest(
        'https://offline.example.test',
        { dataDate: parsed.dataDate, osmTimestamp: parsed.osmTimestamp },
        graph,
        [built],
        resources,
        parsed.generatedAt,
      );
    const first = produce();
    expect(first.regions[0]?.artifacts.maps.url).toContain(
      `/${first.bundleVersion}/regions/calgary/maps.pmtiles`,
    );
    expect(first.regions[0]?.artifacts.resources.url).toContain(
      `/${first.bundleVersion}/resources.tar.gz`,
    );
    expect(produce().bundleVersion).toBe(first.bundleVersion);
    built.files['maps.pmtiles'] = { byteSize: 1001, sha256: '9'.repeat(64) };
    expect(produce().bundleVersion).not.toBe(first.bundleVersion);
  });
});

describe('reproducible command options', () => {
  it('requires a real dated snapshot and immutable HTTPS hosting', () => {
    expect(
      parseBuildOptions(['--date', '261111', '--base-url', 'https://offline.example.test']),
    ).toMatchObject({ dataDate: '2026-11-11', regions: 'calgary' });
    for (const date of ['latest', '261332', '260230'])
      expect(() =>
        parseBuildOptions(['--date', date, '--base-url', 'https://offline.example.test']),
      ).toThrow();
    expect(() =>
      parseBuildOptions(['--date', '261111', '--base-url', 'http://offline.example.test']),
    ).toThrow('HTTPS');
    expect(() =>
      parseBuildOptions(['--date', '261111', '--base-url', 'https://token@offline.example.test']),
    ).toThrow('HTTPS');
  });
  it('pairs the graph builder with the pinned mobile engine, not the online engine', () => {
    expect(routingEnginePin().routingEngineVersion).toBe('3.9.1');
    expect(routingEnginePin().mobileWrapper.version).toBe('0.6.4');
    expect(() => routingEnginePin('3.8.2')).toThrow('embedded');
    expect(() =>
      parseBuildOptions([
        '--date',
        '261111',
        '--base-url',
        'https://offline.example.test',
        '--routing-engine-version',
        '3.8.2',
      ]),
    ).toThrow('embedded');
  });
});
