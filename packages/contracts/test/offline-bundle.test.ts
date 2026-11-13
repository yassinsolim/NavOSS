import { describe, expect, it } from 'vitest';

import fixture from '../../../infra/offline/test/manifest-fixture.json' with { type: 'json' };
import { OfflineBundleManifestSchema } from '../src/index.js';

function sample() {
  const value = structuredClone(fixture);
  const region = value.regions[0];
  if (!region) throw new Error('Missing fixture region');
  return { value, region };
}

describe('OfflineBundleManifestSchema', () => {
  it('accepts the complete versioned download and on-device format contract', () => {
    const result = OfflineBundleManifestSchema.parse(fixture);
    expect(result.graph.routingEngineVersion).toBe('3.9.1');
    expect(result.regions[0]?.artifacts.maps.schemaVersion).toBe('3.16.0');
    expect(result.regions[0]?.artifacts.resources.styles).toEqual([
      'liberty',
      'bright',
      'positron',
      'dark',
    ]);
  });

  it('rejects independently built graphs and duplicate region IDs', () => {
    const { value, region } = sample();
    region.artifacts.routing.graphId = 'f'.repeat(64);
    expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    const duplicate = structuredClone(fixture);
    duplicate.regions.push(...structuredClone(fixture.regions));
    expect(OfflineBundleManifestSchema.safeParse(duplicate).success).toBe(false);
  });

  it('rejects mixed dates and a version unrelated to the snapshot', () => {
    const { value, region } = sample();
    region.dataDate = '2026-11-10';
    expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    expect(
      OfflineBundleManifestSchema.safeParse({ ...fixture, osmTimestamp: '2026-11-10T21:22:47Z' })
        .success,
    ).toBe(false);
    expect(
      OfflineBundleManifestSchema.safeParse({
        ...fixture,
        bundleVersion: '2026-11-10-v1-012345abcdef',
      }).success,
    ).toBe(false);
  });

  it('rejects corrupt integrity metadata, unsafe sizes and unsupported formats', () => {
    const { value, region } = sample();
    for (const sha256 of ['abc', 'G'.repeat(64), 'A'.repeat(64)]) {
      region.artifacts.maps.sha256 = sha256;
      expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    }
    for (const byteSize of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        OfflineBundleManifestSchema.safeParse({
          ...fixture,
          regions: [
            {
              ...fixture.regions[0],
              artifacts: {
                ...fixture.regions[0]?.artifacts,
                maps: { ...fixture.regions[0]?.artifacts.maps, byteSize },
              },
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(OfflineBundleManifestSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(
      OfflineBundleManifestSchema.safeParse({ ...fixture, minimumAppContractVersion: 0 }).success,
    ).toBe(false);
    const formats = sample();
    formats.region.artifacts.routing.format = 'gzip';
    expect(OfflineBundleManifestSchema.safeParse(formats.value).success).toBe(false);
  });

  it('requires closed geographic rings contained by ordered bounds', () => {
    const { value, region } = sample();
    const ring = region.polygon.coordinates[0]?.[0];
    if (!ring) throw new Error('Missing polygon ring');
    ring.pop();
    expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    const outside = sample();
    outside.region.bounds = [-114.5, 50.7, -113.4, 51.4];
    expect(OfflineBundleManifestSchema.safeParse(outside.value).success).toBe(false);
    expect(
      OfflineBundleManifestSchema.safeParse({
        ...fixture,
        regions: [{ ...fixture.regions[0], bounds: [-113.3, 50.6, -114.6, 51.5] }],
      }).success,
    ).toBe(false);
  });

  it('disallows credentials, mutable signed URLs and remote plaintext HTTP', () => {
    for (const url of [
      'http://offline.example.test/map.pmtiles',
      'https://token@offline.example.test/map.pmtiles',
      'https://offline.example.test/map.pmtiles?token=secret',
      'file:///map.pmtiles',
      'https://offline.example.test/map.pmtiles#fragment',
    ]) {
      const { value, region } = sample();
      region.artifacts.maps.url = url;
      expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    }
    const { value, region } = sample();
    region.artifacts.maps.url = 'http://127.0.0.1:3021/maps.pmtiles';
    expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(true);
  });

  it('requires attribution and rejects undeclared contract keys', () => {
    const { value, region } = sample();
    region.attribution = [];
    expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    expect(
      OfflineBundleManifestSchema.safeParse({
        ...fixture,
        downloadToken: 'not part of the contract',
      }).success,
    ).toBe(false);
  });
  it('refuses a routing extract built for another embedded engine or tile format', () => {
    const { value, region } = sample();
    region.artifacts.routing.routingEngineVersion = '3.8.2';
    expect(OfflineBundleManifestSchema.safeParse(value).success).toBe(false);
    const wrongTile = sample();
    wrongTile.region.artifacts.routing.tileFormatVersion = '3.8.2';
    expect(OfflineBundleManifestSchema.safeParse(wrongTile.value).success).toBe(false);
    expect(
      OfflineBundleManifestSchema.safeParse({
        ...fixture,
        graph: { ...fixture.graph, routingEngineVersion: '3.8.2' },
      }).success,
    ).toBe(false);
  });
});
