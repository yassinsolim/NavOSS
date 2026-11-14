import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod/v4';

import type { Position } from './geo.js';

/**
 * The dead-end mask says, for every OpenStreetMap way the traffic pipeline could publish, which
 * parts lie on the main road network and which lie in a region with a single access (a dead-end
 * valley, peninsula or cul-de-sac) or within 400 m of a road end. It is built offline from the
 * same extract as the routing graph (`infra/offline/dead-end-mask.mts`) and bound to that graph's
 * identity. It contains map data only: way ids, statuses and, for ways whose status changes
 * along the way, the way's own node coordinates.
 */
export const DEAD_END_MASK_FORMAT = 'navoss-traffic-dead-end-mask';
/**
 * Version 2 binds the digest to every member, records the serving graph's provenance and
 * requires the corrected topology policy; version 1 masks (built with the policy, core and
 * duplicate-road errors fixed in version 2) are refused.
 */
export const DEAD_END_MASK_FORMAT_VERSION = 2;
/** `POLICY_VERSION` of `infra/offline/dead-end-extract.py` the mask must be built with. */
export const DEAD_END_MASK_POLICY_VERSION = 3;
/** The routing engine whose graph the mask describes (production serves Valhalla 3.8.2). */
export const DEAD_END_MASK_ROUTING_ENGINE_VERSION = '3.8.2';
/** The mask must exclude at least this much road from every true road end. */
export const DEAD_END_MASK_MINIMUM_TERMINAL_METERS = 400;

export type DeadEndMaskStatus = 'eligible' | 'excluded' | 'unknown';

const STATUS_CODES = { e: 'eligible', x: 'excluded', u: 'unknown' } as const;
// A Valhalla polyline6 vertex is the OSM node rounded to six decimals; two units absorb the
// double rounding of seven-decimal coordinates.
const VERTEX_TOLERANCE = 2;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const DeltaIdsSchema = z.array(z.number().int()).max(50_000_000);

export const DeadEndMaskFileSchema = z.strictObject({
  format: z.literal(DEAD_END_MASK_FORMAT),
  formatVersion: z.literal(DEAD_END_MASK_FORMAT_VERSION),
  graph: z.strictObject({
    dataDate: z.iso.date(),
    graphId: Sha256Schema,
    /** SHA-256 of the serving graph's `provenance.json` (`serving-graph.mts`). */
    provenanceSha256: Sha256Schema,
    routingEngineVersion: z.literal(DEAD_END_MASK_ROUTING_ENGINE_VERSION),
  }),
  inputs: z.strictObject({
    extractPolicyVersion: z.literal(DEAD_END_MASK_POLICY_VERSION),
    osmTimestamp: z.iso.datetime(),
    pbf: z.string().regex(/^alberta-british-columbia-\d{6}\.osm\.pbf$/),
    pbfSha256: Sha256Schema,
  }),
  rules: z.strictObject({
    core: z.string().min(1),
    publishableClasses: z.array(z.string().min(1)).min(1),
    terminalClasses: z.array(z.string().min(1)).min(1),
    terminalMeters: z.number().min(DEAD_END_MASK_MINIMUM_TERMINAL_METERS),
  }),
  summary: z.record(z.string(), z.number()),
  ways: z.strictObject({
    eligible: DeltaIdsSchema,
    excluded: DeltaIdsSchema,
    unknown: DeltaIdsSchema,
    /** `[way id, one status letter per node-to-node interval, delta-encoded 1e-6 lon/lat]`. */
    mixed: z.array(
      z.tuple([
        z.number().int().positive(),
        z.string().regex(/^[exu]+$/),
        z.array(z.number().int()),
      ]),
    ),
  }),
  /** SHA-256 of every other member (`deadEndMaskContentDigest`). */
  contentSha256: Sha256Schema,
});

export type DeadEndMaskFile = z.infer<typeof DeadEndMaskFileSchema>;
export type DeadEndMaskWays = DeadEndMaskFile['ways'];

export class DeadEndMaskError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DeadEndMaskError';
  }
}

export interface DeadEndMaskIdentity {
  dataDate: string;
  formatVersion: number;
  graphId: string;
  pbfSha256: string;
  policyVersion: number;
  provenanceSha256: string;
}

export interface DeadEndMask {
  readonly identity: DeadEndMaskIdentity;
  /**
   * Status of one directed graph edge of a way, given the edge's whole geometry in the direction
   * of travel. A way the mask does not list, or an edge that cannot be placed exactly on its
   * way, is `unknown`. Only `eligible` may be published.
   */
  status(edge: { forward: boolean; wayId: number }, line: readonly Position[]): DeadEndMaskStatus;
}

/** JSON with object keys sorted at every level: one text for one value, whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Digest of every member of the mask except the digest itself (metadata, rules, summary and
 * ways), over canonical JSON. It detects a truncated, edited or re-labelled mask. It is an
 * integrity check, not authentication: anyone who can write the file can recompute it, so the
 * file's protection is the read-only install and the graph binding checked at start-up.
 */
export function deadEndMaskContentDigest(
  mask: Omit<DeadEndMaskFile, 'contentSha256'> & { contentSha256?: string },
): string {
  return createHash('sha256')
    .update(canonicalJson({ ...mask, contentSha256: undefined }))
    .digest('hex');
}

/** Encodes ascending ids as their first value followed by differences. */
export function encodeDeltas(values: readonly number[]): number[] {
  return values.map((value, index) => (index === 0 ? value : value - (values[index - 1] ?? 0)));
}

function decodeIds(deltas: readonly number[], into: Map<number, number>, code: number): void {
  let previous = 0;
  for (const [index, delta] of deltas.entries()) {
    const id = index === 0 ? delta : previous + delta;
    if (id <= 0 || (index > 0 && delta <= 0)) {
      throw new DeadEndMaskError('The dead-end mask way lists are not strictly ascending.');
    }
    if (into.has(id)) throw new DeadEndMaskError('The dead-end mask lists a way twice.');
    into.set(id, code);
    previous = id;
  }
}

interface MixedWay {
  coordinates: Int32Array;
  statuses: Uint8Array;
}

const UNIFORM_CODES: Record<DeadEndMaskStatus, number> = { eligible: 0, excluded: 1, unknown: 2 };
const CODE_STATUS: readonly DeadEndMaskStatus[] = ['eligible', 'excluded', 'unknown'];

function worse(left: number, right: number): number {
  // excluded (1) and unknown (2) both refuse publication; excluded is the definite reason.
  if (left === 1 || right === 1) return 1;
  return Math.max(left, right);
}

/**
 * Validates a mask and binds it to the graph the API serves. Throws `DeadEndMaskError` for a
 * malformed mask, another format version, a payload that does not match its digest, or a mask
 * built for any other graph. Messages carry no map content.
 */
export function parseDeadEndMask(text: string, expected: { graphId: string }): DeadEndMask {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DeadEndMaskError('The dead-end mask is not valid JSON.');
  }
  const header = z
    .object({
      format: z.unknown(),
      formatVersion: z.unknown(),
      graph: z
        .looseObject({ routingEngineVersion: z.unknown() })
        .catch({ routingEngineVersion: undefined }),
      inputs: z
        .looseObject({ extractPolicyVersion: z.unknown() })
        .catch({ extractPolicyVersion: undefined }),
    })
    .safeParse(raw);
  if (!header.success || header.data.format !== DEAD_END_MASK_FORMAT) {
    throw new DeadEndMaskError('The file is not a NavOSS traffic dead-end mask.');
  }
  if (header.data.formatVersion !== DEAD_END_MASK_FORMAT_VERSION) {
    throw new DeadEndMaskError(
      `The dead-end mask has format version ${String(header.data.formatVersion)}; this API reads version ${String(DEAD_END_MASK_FORMAT_VERSION)}.`,
    );
  }
  if (header.data.inputs.extractPolicyVersion !== DEAD_END_MASK_POLICY_VERSION) {
    throw new DeadEndMaskError(
      `The dead-end mask was built with topology policy ${String(header.data.inputs.extractPolicyVersion)}; this API requires policy ${String(DEAD_END_MASK_POLICY_VERSION)}.`,
    );
  }
  if (header.data.graph.routingEngineVersion !== DEAD_END_MASK_ROUTING_ENGINE_VERSION) {
    throw new DeadEndMaskError(
      `The dead-end mask describes a routing engine ${String(header.data.graph.routingEngineVersion)} graph; this API serves ${DEAD_END_MASK_ROUTING_ENGINE_VERSION}.`,
    );
  }
  const parsed = DeadEndMaskFileSchema.safeParse(raw);
  if (!parsed.success) throw new DeadEndMaskError('The dead-end mask failed validation.');
  const mask = parsed.data;
  if (deadEndMaskContentDigest(mask) !== mask.contentSha256) {
    throw new DeadEndMaskError('The dead-end mask content does not match its digest.');
  }
  if (mask.graph.graphId !== expected.graphId) {
    throw new DeadEndMaskError(
      `The dead-end mask was built for graph ${mask.graph.graphId}, not the configured graph ${expected.graphId}.`,
    );
  }
  const uniform = new Map<number, number>();
  decodeIds(mask.ways.eligible, uniform, UNIFORM_CODES.eligible);
  decodeIds(mask.ways.excluded, uniform, UNIFORM_CODES.excluded);
  decodeIds(mask.ways.unknown, uniform, UNIFORM_CODES.unknown);
  const mixed = new Map<number, MixedWay>();
  for (const [wayId, letters, deltas] of mask.ways.mixed) {
    if (uniform.has(wayId) || mixed.has(wayId)) {
      throw new DeadEndMaskError('The dead-end mask lists a way twice.');
    }
    if (deltas.length !== 2 * (letters.length + 1)) {
      throw new DeadEndMaskError('A dead-end mask way has coordinates for another interval count.');
    }
    const coordinates = new Int32Array(deltas.length);
    let longitude = 0;
    let latitude = 0;
    for (let index = 0; index < deltas.length; index += 2) {
      longitude += deltas[index] ?? 0;
      latitude += deltas[index + 1] ?? 0;
      if (Math.abs(longitude) > 180_000_000 || Math.abs(latitude) > 90_000_000) {
        throw new DeadEndMaskError('A dead-end mask way has a coordinate out of range.');
      }
      coordinates[index] = longitude;
      coordinates[index + 1] = latitude;
    }
    const statuses = Uint8Array.from(
      letters,
      (letter) => UNIFORM_CODES[STATUS_CODES[letter as keyof typeof STATUS_CODES]],
    );
    mixed.set(wayId, { coordinates, statuses });
  }

  return {
    identity: {
      dataDate: mask.graph.dataDate,
      formatVersion: mask.formatVersion,
      graphId: mask.graph.graphId,
      pbfSha256: mask.inputs.pbfSha256,
      policyVersion: mask.inputs.extractPolicyVersion,
      provenanceSha256: mask.graph.provenanceSha256,
    },
    status(edge, line) {
      const code = uniform.get(edge.wayId);
      if (code !== undefined) return CODE_STATUS[code] ?? 'unknown';
      const way = mixed.get(edge.wayId);
      if (way === undefined || line.length < 2) return 'unknown';
      const ordered = edge.forward ? line : [...line].reverse();
      const vertices = ordered.map(([longitude, latitude]) => [
        Math.round(longitude * 1e6),
        Math.round(latitude * 1e6),
      ]);
      const wayVertices = way.coordinates.length / 2;
      let result = -1;
      for (let start = 0; start + vertices.length <= wayVertices; start += 1) {
        const matches = vertices.every(
          ([longitude = 0, latitude = 0], offset) =>
            Math.abs((way.coordinates[2 * (start + offset)] ?? 0) - longitude) <=
              VERTEX_TOLERANCE &&
            Math.abs((way.coordinates[2 * (start + offset) + 1] ?? 0) - latitude) <=
              VERTEX_TOLERANCE,
        );
        if (!matches) continue;
        for (let interval = start; interval < start + vertices.length - 1; interval += 1) {
          const status = way.statuses[interval] ?? UNIFORM_CODES.unknown;
          result = result === -1 ? status : worse(result, status);
        }
      }
      return result === -1 ? 'unknown' : (CODE_STATUS[result] ?? 'unknown');
    },
  };
}

/** Reads and validates a mask file; see `parseDeadEndMask`. */
export function loadDeadEndMask(path: string, expected: { graphId: string }): DeadEndMask {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new DeadEndMaskError('The dead-end mask file could not be read.');
  }
  return parseDeadEndMask(text, expected);
}
