import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  OfflineBundleManifestSchema,
  OfflineBundlePolygonSchema,
  type OfflineBundleManifest,
  type OfflineBundleRegion,
} from '../../packages/contracts/src/offline-bundle.js';

export interface RegionFeature {
  type: 'Feature';
  geometry: OfflineBundleRegion['polygon'];
  properties: {
    id: string;
    name: string;
    bounds: [number, number, number, number];
    overlapMeters: number;
    bulk: boolean;
  };
}

export interface OfflineStyle {
  version: number;
  name?: string;
  sources: Record<string, Record<string, unknown>>;
  layers: Record<string, unknown>[];
  glyphs?: string;
  sprite?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inspectArtifact(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing artifact: ${path}`);
  return { byteSize: info.size, sha256: await sha256File(path) };
}

export async function readRegionCatalog(path: string): Promise<RegionFeature[]> {
  const collection = JSON.parse(await readFile(path, 'utf8')) as {
    type: string;
    features: RegionFeature[];
  };
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Region catalog must be a GeoJSON FeatureCollection');
  }
  const ids = new Set<string>();
  for (const feature of collection.features) {
    const properties = feature.properties;
    if (
      !properties ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(properties.id) ||
      ids.has(properties.id)
    ) {
      throw new Error('Invalid or duplicate region ID');
    }
    ids.add(properties.id);
    OfflineBundlePolygonSchema.parse(feature.geometry);
    if (
      !properties.name ||
      properties.bounds.length !== 4 ||
      !Number.isInteger(properties.overlapMeters)
    ) {
      throw new Error('Invalid region metadata');
    }
  }
  return collection.features;
}

export async function writeRegion(feature: RegionFeature, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'region.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: [feature] }) + '\n',
  );
  const lines = [feature.properties.id];
  let ringId = 0;
  for (const polygon of feature.geometry.coordinates) {
    for (const [hole, ring] of polygon.entries()) {
      lines.push(`${hole ? '!' : ''}${++ringId}`);
      lines.push(...ring.map(([longitude, latitude]) => `  ${longitude}  ${latitude}`));
      lines.push('END');
    }
  }
  lines.push('END');
  await writeFile(join(directory, 'region.poly'), lines.join('\n') + '\n');
}

/** Portable resources; callers bind relative references to their real installation URLs. */
export function createOfflineStyle(source: OfflineStyle, name: string): OfflineStyle {
  if (
    source.version !== 8 ||
    !source.sources.openmaptiles ||
    source.sources.openmaptiles.type !== 'vector'
  ) {
    throw new Error('Expected an OpenMapTiles MapLibre v8 style');
  }
  if (Object.keys(source.sources).some((id) => id !== 'openmaptiles' && id !== 'ne2_shaded')) {
    throw new Error('Style introduced an unsupported external source');
  }
  const style = structuredClone(source);
  style.name = `NavOSS offline ${name}`;
  // Natural Earth's world hillshade is optional online texture, not road/POI data.
  // Offline variants retain the generated Natural Earth vector basemap instead.
  delete style.sources.ne2_shaded;
  style.layers = style.layers.filter((layer) => layer.source !== 'ne2_shaded');
  style.sources.openmaptiles = {
    type: 'vector',
    url: 'pmtiles://maps.pmtiles',
    attribution:
      '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://openmaptiles.org/">© OpenMapTiles</a>',
  };
  style.glyphs = './glyphs/{fontstack}/{range}.pbf';
  style.sprite = './sprites/ofm';
  style.metadata = { ...style.metadata, 'navoss:offline-resource-version': 1 };
  return style;
}

export function bindOfflineStyle(
  source: OfflineStyle,
  bundleRoot: string,
  resourcesRoot: string,
  platform: 'web' | 'native',
): OfflineStyle {
  if (
    source.sources.openmaptiles?.url !== 'pmtiles://maps.pmtiles' ||
    source.glyphs !== './glyphs/{fontstack}/{range}.pbf' ||
    source.sprite !== './sprites/ofm'
  ) {
    throw new Error('Unsupported offline resource layout');
  }
  const root = (value: string) => {
    const clean = value.replace(/\/$/, '');
    if (platform === 'native') {
      if (!clean.startsWith('/')) throw new Error('Native roots must be absolute filesystem paths');
      return pathToFileURL(clean).href;
    }
    const url = new URL(clean);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.protocol !== 'http:' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('The web verifier only serves loopback HTTP');
    }
    return clean;
  };
  const style = structuredClone(source);
  style.sources.openmaptiles = {
    ...style.sources.openmaptiles,
    url: `pmtiles://${root(bundleRoot)}/maps.pmtiles`,
  };
  style.glyphs = `${root(resourcesRoot)}/glyphs/{fontstack}/{range}.pbf`;
  style.sprite = `${root(resourcesRoot)}/sprites/ofm`;
  return style;
}

export function validateManifest(input: unknown): OfflineBundleManifest {
  return OfflineBundleManifestSchema.parse(input);
}

export async function readMapMetadata(path: string) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const header = Buffer.alloc(127);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 127 || header.toString('utf8', 0, 7) !== 'PMTiles' || header[7] !== 3) {
      throw new Error('Expected a PMTiles v3 archive');
    }
    if (header[99] !== 1 || header[98] !== 2) throw new Error('Expected gzip-compressed MVT tiles');
    const offset = Number(header.readBigUInt64LE(24));
    const length = Number(header.readBigUInt64LE(32));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 4 * 1024 * 1024 ||
      offset + length > info.size
    ) {
      throw new Error('Invalid PMTiles metadata offset/length');
    }
    const encoded = Buffer.alloc(length);
    if ((await file.read(encoded, 0, length, offset)).bytesRead !== length)
      throw new Error('Truncated PMTiles metadata');
    const content =
      header[97] === 2 ? gunzipSync(encoded, { maxOutputLength: 4 * 1024 * 1024 }) : encoded;
    if (header[97] !== 1 && header[97] !== 2)
      throw new Error('Unsupported PMTiles internal compression');
    const metadata = JSON.parse(content.toString('utf8')) as {
      name?: string;
      version?: string;
      vector_layers?: { id: string }[];
    };
    if (
      metadata.name !== 'OpenMapTiles' ||
      !metadata.version ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(metadata.version) ||
      !metadata.vector_layers?.some((layer) => layer.id === 'transportation')
    ) {
      throw new Error('Expected the versioned OpenMapTiles schema');
    }
    const minZoom = header[100];
    const maxZoom = header[101];
    if (minZoom === undefined || maxZoom === undefined || minZoom > maxZoom || maxZoom > 16)
      throw new Error('Invalid map zoom coverage');
    return {
      schemaVersion: metadata.version,
      minZoom,
      maxZoom,
      vectorLayers: metadata.vector_layers.map((layer) => layer.id),
    };
  } finally {
    await file.close();
  }
}
