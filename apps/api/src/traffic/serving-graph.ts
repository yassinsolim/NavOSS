import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod/v4';

import { DEAD_END_MASK_ROUTING_ENGINE_VERSION, DeadEndMaskError } from './dead-end-mask.js';

/**
 * The graph directory Valhalla serves when community traffic may publish
 * (`infra/offline/serving-graph.mts` writes it; `infra/compose/compose.traffic-graph.yaml` serves
 * it read-only). Valhalla's container and the API's mount the same directory at the same path, so
 * the bytes the API hashes here are the bytes the configuration below makes Valhalla serve:
 *
 * - `connected.tar`: the tile archive, whose SHA-256 is the graph id;
 * - `valhalla-serving.json`: Valhalla's configuration, whose `tile_extract` is that archive and
 *   whose `tile_dir` does not exist (no fallback to loose tiles);
 * - `graph.json`: graph id, engine version and data date;
 * - `provenance.json`: what built the archive from which checksum-verified extract;
 * - `dead-end-mask.json`: the mask built for it.
 */
export const SERVING_GRAPH_FILES = {
  config: 'valhalla-serving.json',
  graph: 'graph.json',
  mask: 'dead-end-mask.json',
  provenance: 'provenance.json',
  tiles: 'connected.tar',
} as const;
export const SERVING_GRAPH_PROVENANCE_FORMAT = 'navoss-serving-graph-provenance';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const GraphJsonSchema = z.strictObject({
  dataDate: z.iso.date(),
  graphId: Sha256Schema,
  routingEngineVersion: z.literal(DEAD_END_MASK_ROUTING_ENGINE_VERSION),
  speedProfileSha256: Sha256Schema,
});

export const ServingGraphProvenanceSchema = z.strictObject({
  format: z.literal(SERVING_GRAPH_PROVENANCE_FORMAT),
  formatVersion: z.literal(1),
  graphId: Sha256Schema,
  connectedTarBytes: z.number().int().positive(),
  servingConfigSha256: Sha256Schema,
  routingEngineVersion: z.literal(DEAD_END_MASK_ROUTING_ENGINE_VERSION),
  engineImage: z
    .string()
    .regex(/^ghcr\.io\/valhalla\/valhalla-scripted:3\.8\.2@sha256:[0-9a-f]{64}$/),
  builder: z.strictObject({
    dockerfileSha256: Sha256Schema,
    imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    scriptsSha256: z.record(z.string().min(1), Sha256Schema),
  }),
  input: z.strictObject({
    dataDate: z.iso.date(),
    osmTimestamp: z.iso.datetime(),
    pbf: z.string().regex(/^alberta-british-columbia-\d{6}\.osm\.pbf$/),
    pbfSha256: Sha256Schema,
    sha256sums: z.string().min(1),
  }),
});
export type ServingGraphProvenance = z.infer<typeof ServingGraphProvenanceSchema>;

export interface ServingGraph {
  dataDate: string;
  graphId: string;
  pbfSha256: string;
  provenanceSha256: string;
}

/** SHA-256 and size of a file, read in chunks (the archive is hundreds of megabytes). */
export function hashFileSync(path: string): { bytes: number; sha256: string } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const descriptor = openSync(path, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function readBytes(directory: string, name: string): Buffer {
  try {
    return readFileSync(join(directory, name));
  } catch {
    throw new DeadEndMaskError(`The serving graph has no readable ${name}.`);
  }
}

function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>, name: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DeadEndMaskError(`The serving graph's ${name} is not valid JSON.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DeadEndMaskError(`The serving graph's ${name} failed validation.`);
  return parsed.data;
}

const ServingConfigSchema = z.looseObject({
  mjolnir: z.looseObject({
    tile_dir: z.string().min(1),
    tile_extract: z.string().min(1),
    tile_url: z.string().optional(),
    traffic_extract: z.string().optional(),
  }),
});

/**
 * Verifies the graph directory that both Valhalla and the API mount, before anything is
 * published: the archive Valhalla's configuration names hashes to the configured graph id, the
 * configuration has no other tile source, and the provenance record (bound to that
 * configuration and archive) names the checksum-verified extract it was built from. Throws
 * `DeadEndMaskError`; messages carry no map content. `mountedAt` is where Valhalla's container
 * sees the directory (the directory itself inside the API's container; `/graph` when an operator
 * or the mask builder checks it on the host).
 */
export function verifyServingGraph(
  directory: string,
  graphId: string,
  mountedAt: string = directory,
): ServingGraph {
  const graph = parseJson(
    readBytes(directory, SERVING_GRAPH_FILES.graph),
    GraphJsonSchema,
    'graph.json',
  );
  if (graph.graphId !== graphId) {
    throw new DeadEndMaskError(
      `The serving graph is ${graph.graphId}, not the configured graph ${graphId}.`,
    );
  }
  const configBytes = readBytes(directory, SERVING_GRAPH_FILES.config);
  const config = parseJson(configBytes, ServingConfigSchema, SERVING_GRAPH_FILES.config);
  const tiles = join(directory, SERVING_GRAPH_FILES.tiles);
  const served = join(mountedAt, SERVING_GRAPH_FILES.tiles);
  if (config.mjolnir.tile_extract !== served) {
    throw new DeadEndMaskError(
      `Valhalla's configuration serves ${config.mjolnir.tile_extract}, not the verified ${served}.`,
    );
  }
  if (
    existsSync(config.mjolnir.tile_dir) ||
    (config.mjolnir.tile_url ?? '') !== '' ||
    (config.mjolnir.traffic_extract ?? '') !== ''
  ) {
    throw new DeadEndMaskError(
      "Valhalla's configuration has a tile source other than the verified archive.",
    );
  }
  const provenanceBytes = readBytes(directory, SERVING_GRAPH_FILES.provenance);
  const provenance = parseJson(
    provenanceBytes,
    ServingGraphProvenanceSchema,
    SERVING_GRAPH_FILES.provenance,
  );
  if (provenance.graphId !== graphId || provenance.input.dataDate !== graph.dataDate) {
    throw new DeadEndMaskError('The serving graph provenance is for another graph.');
  }
  if (provenance.servingConfigSha256 !== createHash('sha256').update(configBytes).digest('hex')) {
    throw new DeadEndMaskError(
      "Valhalla's configuration is not the one the serving graph was built with.",
    );
  }
  const sumsLine = `${provenance.input.pbfSha256}  ${provenance.input.pbf}`;
  if (!provenance.input.sha256sums.split('\n').includes(sumsLine)) {
    throw new DeadEndMaskError('The serving graph provenance disagrees with its input checksums.');
  }
  let actual: { bytes: number; sha256: string };
  try {
    actual = hashFileSync(tiles);
  } catch {
    throw new DeadEndMaskError(`The serving graph has no readable ${SERVING_GRAPH_FILES.tiles}.`);
  }
  if (actual.sha256 !== graphId || actual.bytes !== provenance.connectedTarBytes) {
    throw new DeadEndMaskError(
      `The tile archive Valhalla serves is not graph ${graphId}; refusing to publish.`,
    );
  }
  return {
    dataDate: graph.dataDate,
    graphId,
    pbfSha256: provenance.input.pbfSha256,
    provenanceSha256: createHash('sha256').update(provenanceBytes).digest('hex'),
  };
}
