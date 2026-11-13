import { createHash } from 'node:crypto';

import type { OfflineBundleManifest } from '../../packages/contracts/src/offline-bundle.js';
import { validateManifest, type RegionFeature } from './tools.mjs';

export interface ArtifactInfo {
  byteSize: number;
  sha256: string;
}

export interface BuiltRegion {
  feature: RegionFeature;
  key: string;
  directory: string;
  files: {
    'maps.pmtiles': ArtifactInfo;
    'routing.tar': ArtifactInfo;
    'search.sqlite': ArtifactInfo;
  };
  maps: { schemaVersion: string; minZoom: number; maxZoom: number };
}

export interface BuiltResources {
  key: string;
  directory: string;
  file: ArtifactInfo;
  unpackedByteSize: number;
}

export interface GraphIdentity {
  graphId: string;
  routingEngineVersion: string;
  tileFormat: string;
  tileFormatVersion: string;
  dataDate: string;
  speedProfileSha256: string;
}

export function createManifest(
  baseUrl: string,
  data: { dataDate: string; osmTimestamp: string },
  graph: GraphIdentity,
  regions: BuiltRegion[],
  resources: BuiltResources,
  generatedAt: string,
): OfflineBundleManifest {
  const orderedRegions = [...regions].sort((left, right) =>
    left.feature.properties.id.localeCompare(right.feature.properties.id, 'en'),
  );
  // Content-derived immutable URLs; a different output can never overwrite an old release path.
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        data,
        graph,
        regions: orderedRegions.map((region) => ({
          feature: region.feature,
          files: region.files,
          maps: region.maps,
        })),
        resources: resources.file,
      }),
    )
    .digest('hex');
  const bundleVersion = `${data.dataDate}-v1-${digest.slice(0, 12)}`;
  const root = `${baseUrl.replace(/\/$/, '')}/${bundleVersion}`;
  const attribution = [
    {
      text: '© OpenStreetMap contributors (Geofabrik extracts)',
      url: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL-1.0',
    },
    {
      text: '© OpenMapTiles',
      url: 'https://openmaptiles.org/',
      license: 'CC-BY-4.0 / BSD-3-Clause',
    },
    {
      text: 'Natural Earth',
      url: 'https://www.naturalearthdata.com/about/terms-of-use/',
      license: 'Public domain',
    },
    {
      text: 'OpenFreeMap; OSM Bright/Liberty; Carto, Stamen and Paul Norman (Positron/Dark)',
      url: 'https://github.com/hyperknot/openfreemap-styles',
      license: 'CC-BY-4.0 / CC-BY-3.0 / BSD-3-Clause / MIT',
    },
    { text: 'Noto Sans glyphs', url: 'https://openfontlicense.org/', license: 'OFL-1.1' },
    { text: 'Maki icons', url: 'https://github.com/mapbox/maki', license: 'CC0-1.0' },
  ];
  return validateManifest({
    schemaVersion: 1,
    bundleVersion,
    ...data,
    generatedAt,
    minimumAppContractVersion: 1,
    graph: {
      id: graph.graphId,
      routingEngineVersion: graph.routingEngineVersion,
      tileFormat: graph.tileFormat,
      tileFormatVersion: graph.tileFormatVersion,
      speedProfileSha256: graph.speedProfileSha256,
    },
    regions: orderedRegions.map((region) => {
      const id = region.feature.properties.id;
      const artifactRoot = `${root}/regions/${id}`;
      return {
        id,
        name: region.feature.properties.name,
        polygon: region.feature.geometry,
        bounds: region.feature.properties.bounds,
        overlapMeters: region.feature.properties.overlapMeters,
        dataDate: data.dataDate,
        artifacts: {
          maps: {
            ...region.files['maps.pmtiles'],
            url: `${artifactRoot}/maps.pmtiles`,
            format: 'pmtiles',
            formatVersion: 3,
            schema: 'openmaptiles',
            ...region.maps,
          },
          routing: {
            ...region.files['routing.tar'],
            url: `${artifactRoot}/routing.tar`,
            format: 'valhalla-tar',
            formatVersion: 1,
            routingEngineVersion: graph.routingEngineVersion,
            tileFormat: graph.tileFormat,
            tileFormatVersion: graph.tileFormatVersion,
            graphId: graph.graphId,
          },
          search: {
            ...region.files['search.sqlite'],
            url: `${artifactRoot}/search.sqlite`,
            format: 'sqlite-fts5',
            formatVersion: 1,
            schemaVersion: 1,
          },
          resources: {
            ...resources.file,
            url: `${root}/resources.tar.gz`,
            format: 'tar-gzip',
            formatVersion: 1,
            schemaVersion: 1,
            unpackedByteSize: resources.unpackedByteSize,
            styles: ['liberty', 'bright', 'positron', 'dark'],
          },
        },
        attribution,
      };
    }),
  });
}
