/**
 * Serving-graph and dead-end-mask files as `serving-graph.mts` and the mask builder write them,
 * for tests of the mask, its configuration and the configured traffic service.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEAD_END_MASK_FORMAT,
  DEAD_END_MASK_FORMAT_VERSION,
  DEAD_END_MASK_POLICY_VERSION,
  deadEndMaskContentDigest,
  encodeDeltas,
  type DeadEndMaskFile,
  type DeadEndMaskWays,
} from '../src/traffic/dead-end-mask.js';
import type { Position } from '../src/traffic/geo.js';
import {
  SERVING_GRAPH_FILES,
  SERVING_GRAPH_PROVENANCE_FORMAT,
  type ServingGraphProvenance,
} from '../src/traffic/serving-graph.js';

export const GRAPH = 'a'.repeat(64);

export function maskFile(
  ways: Partial<DeadEndMaskWays> = {},
  overrides: Partial<Omit<DeadEndMaskFile, 'contentSha256'>> = {},
): DeadEndMaskFile {
  const complete: DeadEndMaskWays = {
    eligible: encodeDeltas(ways.eligible ?? []),
    excluded: encodeDeltas(ways.excluded ?? []),
    unknown: encodeDeltas(ways.unknown ?? []),
    mixed: ways.mixed ?? [],
  };
  const content: Omit<DeadEndMaskFile, 'contentSha256'> = {
    format: DEAD_END_MASK_FORMAT,
    formatVersion: DEAD_END_MASK_FORMAT_VERSION,
    graph: {
      dataDate: '2026-11-11',
      graphId: GRAPH,
      provenanceSha256: 'f'.repeat(64),
      routingEngineVersion: '3.8.2',
    },
    inputs: {
      extractPolicyVersion: DEAD_END_MASK_POLICY_VERSION,
      osmTimestamp: '2026-11-11T21:22:47Z',
      pbf: 'alberta-british-columbia-261111.osm.pbf',
      pbfSha256: 'b'.repeat(64),
    },
    rules: {
      core: 'test',
      publishableClasses: ['secondary'],
      terminalClasses: ['secondary'],
      terminalMeters: 400,
    },
    summary: {},
    ways: complete,
    ...overrides,
  };
  return { ...content, contentSha256: deadEndMaskContentDigest(content) };
}

/** Mixed-way entry from positions (degrees) and one status letter per interval. */
export function mixedWay(wayId: number, positions: readonly Position[], letters: string) {
  const flat = positions.flatMap(([longitude, latitude]) => [
    Math.round(longitude * 1e6),
    Math.round(latitude * 1e6),
  ]);
  const deltas = flat.map((value, index) => (index < 2 ? value : value - (flat[index - 2] ?? 0)));
  return [wayId, letters, deltas] as [number, string, number[]];
}

export const PBF = 'alberta-british-columbia-261111.osm.pbf';
export const PBF_SHA = 'b'.repeat(64);

/**
 * Writes a serving graph directory as `serving-graph.mts` does: a tile archive (here a few bytes
 * standing in for it), Valhalla's serving configuration, graph.json, provenance.json and the
 * mask built for them, listing `ways`. Returns the graph id (the archive's SHA-256).
 */
export function writeServingGraph(
  directory: string,
  archive: string,
  mounted = directory,
  ways: Partial<DeadEndMaskWays> = { eligible: [5] },
): string {
  writeFileSync(join(directory, SERVING_GRAPH_FILES.tiles), archive);
  const graphId = createHash('sha256').update(archive).digest('hex');
  const config = JSON.stringify({
    mjolnir: {
      tile_dir: '/nonexistent',
      tile_extract: join(mounted, SERVING_GRAPH_FILES.tiles),
      traffic_extract: '',
    },
  });
  writeFileSync(join(directory, SERVING_GRAPH_FILES.config), config);
  writeFileSync(
    join(directory, SERVING_GRAPH_FILES.graph),
    JSON.stringify({
      dataDate: '2026-11-11',
      graphId,
      routingEngineVersion: '3.8.2',
      speedProfileSha256: 'd'.repeat(64),
    }),
  );
  const provenance: ServingGraphProvenance = {
    format: SERVING_GRAPH_PROVENANCE_FORMAT,
    formatVersion: 1,
    graphId,
    connectedTarBytes: Buffer.byteLength(archive),
    servingConfigSha256: createHash('sha256').update(config).digest('hex'),
    routingEngineVersion: '3.8.2',
    engineImage: `ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:${'1'.repeat(64)}`,
    builder: {
      dockerfileSha256: '2'.repeat(64),
      imageId: `sha256:${'3'.repeat(64)}`,
      scriptsSha256: { 'infra/offline/build-graph.sh': '4'.repeat(64) },
    },
    input: {
      dataDate: '2026-11-11',
      osmTimestamp: '2026-11-11T21:22:47Z',
      pbf: PBF,
      pbfSha256: PBF_SHA,
      sha256sums: `${'5'.repeat(64)}  alberta-261111.osm.pbf\n${PBF_SHA}  ${PBF}\n`,
    },
  };
  const provenanceText = JSON.stringify(provenance, null, 2);
  writeFileSync(join(directory, SERVING_GRAPH_FILES.provenance), provenanceText);
  const mask = maskFile(ways, {
    graph: {
      dataDate: '2026-11-11',
      graphId,
      provenanceSha256: createHash('sha256').update(provenanceText).digest('hex'),
      routingEngineVersion: '3.8.2',
    },
  });
  writeFileSync(join(directory, SERVING_GRAPH_FILES.mask), JSON.stringify(mask));
  return graphId;
}
