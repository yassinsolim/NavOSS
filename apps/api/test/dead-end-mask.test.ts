import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TrafficProbeBatchRequest } from '@navoss/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEAD_END_MASK_FORMAT,
  DEAD_END_MASK_FORMAT_VERSION,
  DEAD_END_MASK_POLICY_VERSION,
  DeadEndMaskError,
  deadEndMaskContentDigest,
  encodeDeltas,
  parseDeadEndMask,
  type DeadEndMask,
  type DeadEndMaskFile,
  type DeadEndMaskWays,
} from '../src/traffic/dead-end-mask.js';
import type { Position } from '../src/traffic/geo.js';
import { createValhallaMapMatcher } from '../src/traffic/map-matcher.js';
import {
  SERVING_GRAPH_FILES,
  SERVING_GRAPH_PROVENANCE_FORMAT,
  type ServingGraphProvenance,
} from '../src/traffic/serving-graph.js';
import { trimBatchEnds } from '../src/traffic/probe-validation.js';
import { isAggregatedRoad } from '../src/traffic/segments.js';
import { loadConfiguredDeadEndMask } from '../src/traffic/settings.js';
import { requestUrl } from './traffic-fixture.js';

const GRAPH = 'a'.repeat(64);

function maskFile(
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

/** Re-labels a mask without recomputing its digest. */
function tampered(mask: DeadEndMaskFile, change: (copy: DeadEndMaskFile) => void): string {
  const copy = structuredClone(mask);
  change(copy);
  return JSON.stringify(copy);
}

/** Mixed-way entry from positions (degrees) and one status letter per interval. */
function mixedWay(wayId: number, positions: readonly Position[], letters: string) {
  const flat = positions.flatMap(([longitude, latitude]) => [
    Math.round(longitude * 1e6),
    Math.round(latitude * 1e6),
  ]);
  const deltas = flat.map((value, index) => (index < 2 ? value : value - (flat[index - 2] ?? 0)));
  return [wayId, letters, deltas] as [number, string, number[]];
}

const WAY: Position[] = [
  [-114.1, 51],
  [-114.099, 51],
  [-114.098, 51.0005],
  [-114.097, 51.0005],
  [-114.096, 51.001],
];

describe('dead-end mask', () => {
  it('answers uniform ways, and unknown for a way it does not list', () => {
    const mask = parseDeadEndMask(
      JSON.stringify(maskFile({ eligible: [5, 9], excluded: [7], unknown: [11] })),
      { graphId: GRAPH },
    );
    const line = WAY.slice(0, 2);
    expect(mask.status({ forward: true, wayId: 5 }, line)).toBe('eligible');
    expect(mask.status({ forward: false, wayId: 9 }, line)).toBe('eligible');
    expect(mask.status({ forward: true, wayId: 7 }, line)).toBe('excluded');
    expect(mask.status({ forward: true, wayId: 11 }, line)).toBe('unknown');
    expect(mask.status({ forward: true, wayId: 6 }, line)).toBe('unknown');
  });

  it('never publishes the excluded part of a way that crosses the boundary', () => {
    // Intervals 0-1 are on the main network; 2-3 lie past the single junction.
    const mask = parseDeadEndMask(
      JSON.stringify(maskFile({ mixed: [mixedWay(42, WAY, 'eexx')] })),
      { graphId: GRAPH },
    );
    const way = { forward: true, wayId: 42 };
    expect(mask.status(way, WAY.slice(0, 3))).toBe('eligible');
    expect(mask.status(way, WAY.slice(2))).toBe('excluded');
    // A graph edge spanning the boundary, in either direction, is refused.
    expect(mask.status(way, WAY.slice(1, 4))).toBe('excluded');
    expect(mask.status({ forward: false, wayId: 42 }, [...WAY].reverse())).toBe('excluded');
    expect(mask.status({ forward: false, wayId: 42 }, WAY.slice(0, 3).reverse())).toBe('eligible');
    // Valhalla rounds seven-decimal OSM nodes to six; one unit either way still matches.
    expect(
      mask.status(way, [
        [-114.100001, 51],
        [-114.098999, 51.000001],
      ]),
    ).toBe('eligible');
    // Geometry that is not this way's (another graph, a moved node) is unknown, not eligible.
    expect(
      mask.status(way, [
        [-114.1, 51],
        [-114.0995, 51],
      ]),
    ).toBe('unknown');
    // Driving direction matters for placing the edge: the forward line read backwards does not fit.
    expect(mask.status({ forward: false, wayId: 42 }, WAY.slice(0, 3))).toBe('unknown');
    expect(mask.status(way, WAY.slice(0, 1))).toBe('unknown');
  });

  it('takes the worst status where a way passes the same nodes twice', () => {
    const loop: Position[] = [...WAY.slice(0, 3), WAY[1] ?? [0, 0], WAY[0] ?? [0, 0]];
    const mask = parseDeadEndMask(
      JSON.stringify(maskFile({ mixed: [mixedWay(8, loop, 'eeex')] })),
      { graphId: GRAPH },
    );
    expect(mask.status({ forward: true, wayId: 8 }, [WAY[1] ?? [0, 0], WAY[0] ?? [0, 0]])).toBe(
      'excluded',
    );
  });

  it('refuses malformed, stale, other-version and other-graph masks', () => {
    const valid = maskFile({ eligible: [5] });
    const refuse = (text: string, message: RegExp, graphId = GRAPH) => {
      expect(() => parseDeadEndMask(text, { graphId })).toThrow(DeadEndMaskError);
      expect(() => parseDeadEndMask(text, { graphId })).toThrow(message);
    };
    refuse('{"format":', /not valid JSON/);
    refuse(JSON.stringify({ ...valid, format: 'something-else' }), /not a NavOSS/);
    refuse(JSON.stringify({ ...valid, formatVersion: 1 }), /format version 1/);
    refuse(JSON.stringify({ ...valid, formatVersion: 3 }), /format version 3/);
    // Masks built with the uncorrected topology policy, or none recorded, are refused.
    refuse(
      JSON.stringify(
        maskFile({ eligible: [5] }, { inputs: { ...valid.inputs, extractPolicyVersion: 2 as 3 } }),
      ),
      /topology policy 2; this API requires policy 3/,
    );
    refuse(
      tampered(valid, (copy) => {
        delete (copy.inputs as Partial<DeadEndMaskFile['inputs']>).extractPolicyVersion;
      }),
      /topology policy undefined/,
    );
    refuse(
      JSON.stringify(
        maskFile(
          { eligible: [5] },
          { graph: { ...valid.graph, routingEngineVersion: '3.9.1' as '3.8.2' } },
        ),
      ),
      /routing engine 3\.9\.1 graph/,
    );
    refuse(
      JSON.stringify(valid),
      /built for graph a+, not the configured graph c+/,
      'c'.repeat(64),
    );
    // Edited content no longer matches the digest it was built with.
    refuse(
      JSON.stringify({ ...valid, ways: { ...valid.ways, eligible: [5, 1] } }),
      /does not match its digest/,
    );
    // The digest covers the metadata too: re-labelling the extract, provenance, date, rules or
    // summary without rebuilding is detected.
    for (const change of [
      (copy: DeadEndMaskFile) => (copy.inputs.pbfSha256 = 'c'.repeat(64)),
      (copy: DeadEndMaskFile) => (copy.graph.provenanceSha256 = 'c'.repeat(64)),
      (copy: DeadEndMaskFile) => (copy.graph.dataDate = '2026-11-12'),
      (copy: DeadEndMaskFile) => (copy.rules.terminalMeters = 800),
      (copy: DeadEndMaskFile) => (copy.summary.eligibleMeters = 1),
    ]) {
      refuse(tampered(valid, change), /does not match its digest/);
    }
    refuse(
      JSON.stringify({ ...valid, rules: { ...valid.rules, terminalMeters: 399 } }),
      /failed validation/,
    );
    refuse(JSON.stringify({ ...valid, extra: true }), /failed validation/);
    refuse(JSON.stringify(maskFile({ eligible: [5], excluded: [5] })), /lists a way twice/);
    refuse(JSON.stringify(maskFile({ eligible: [9, 5] })), /strictly ascending/);
    refuse(JSON.stringify(maskFile({ eligible: [5], mixed: [mixedWay(5, WAY, 'eexx')] })), /twice/);
    refuse(JSON.stringify(maskFile({ mixed: [mixedWay(3, WAY, 'eex')] })), /interval count/);
  });
});

const PBF = 'alberta-british-columbia-261111.osm.pbf';
const PBF_SHA = 'b'.repeat(64);

/**
 * Writes a serving graph directory as `serving-graph.mts` does: a tile archive (here a few bytes
 * standing in for it), Valhalla's serving configuration, graph.json, provenance.json and the
 * mask built for them. Returns the graph id (the archive's SHA-256).
 */
function writeServingGraph(directory: string, archive: string, mounted = directory): string {
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
  const mask = maskFile(
    { eligible: [5] },
    {
      graph: {
        dataDate: '2026-11-11',
        graphId,
        provenanceSha256: createHash('sha256').update(provenanceText).digest('hex'),
        routingEngineVersion: '3.8.2',
      },
    },
  );
  writeFileSync(join(directory, SERVING_GRAPH_FILES.mask), JSON.stringify(mask));
  return graphId;
}

describe('dead-end mask configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'navoss-serving-graph-'));
  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });
  let count = 0;
  const graphDirectory = (archive = 'tiles of the 2026-11-11 graph') => {
    count += 1;
    const directory = join(root, String(count));
    mkdirSync(directory);
    return { directory, graphId: writeServingGraph(directory, archive) };
  };
  const environment = (directory: string, graphId: string) => ({
    COMMUNITY_TRAFFIC_GRAPH_DIR: directory,
    COMMUNITY_TRAFFIC_GRAPH_ID: graphId,
  });

  it('is not read while traffic is off, even when misconfigured', () => {
    expect(
      loadConfiguredDeadEndMask('off', { COMMUNITY_TRAFFIC_GRAPH_DIR: '/missing' }),
    ).toBeUndefined();
  });

  it('is optional for collection, which publishes nothing, but must verify when configured', () => {
    expect(loadConfiguredDeadEndMask('collect', {})).toBeUndefined();
    const { directory, graphId } = graphDirectory();
    expect(
      loadConfiguredDeadEndMask('collect', environment(directory, graphId))?.identity.graphId,
    ).toBe(graphId);
    expect(() =>
      loadConfiguredDeadEndMask('collect', { COMMUNITY_TRAFFIC_GRAPH_DIR: directory }),
    ).toThrow(/requires COMMUNITY_TRAFFIC_GRAPH_ID/);
  });

  it('is required for live, with no permissive fallback', () => {
    const { directory, graphId } = graphDirectory();
    expect(() => loadConfiguredDeadEndMask('live', {})).toThrow(/live requires/);
    expect(() =>
      loadConfiguredDeadEndMask('live', { COMMUNITY_TRAFFIC_GRAPH_DIR: directory }),
    ).toThrow(/live requires/);
    expect(() =>
      loadConfiguredDeadEndMask('live', { COMMUNITY_TRAFFIC_GRAPH_ID: graphId }),
    ).toThrow(/live requires/);
    expect(() =>
      loadConfiguredDeadEndMask('live', environment(join(root, 'missing'), graphId)),
    ).toThrow(DeadEndMaskError);
    expect(() => loadConfiguredDeadEndMask('live', environment(directory, 'graph-2026'))).toThrow(
      /64-hex/,
    );
    expect(() => loadConfiguredDeadEndMask('live', environment(directory, 'c'.repeat(64)))).toThrow(
      /not the configured graph c+/,
    );
    expect(
      loadConfiguredDeadEndMask('live', environment(directory, graphId))?.identity,
    ).toMatchObject({
      formatVersion: DEAD_END_MASK_FORMAT_VERSION,
      graphId,
      pbfSha256: PBF_SHA,
      policyVersion: DEAD_END_MASK_POLICY_VERSION,
    });
  });

  it('refuses an archive Valhalla would serve that is not the graph the manifests name', () => {
    // graph.json, the mask, the provenance and the configured id all agree; the bytes do not.
    const { directory, graphId } = graphDirectory();
    writeFileSync(join(directory, SERVING_GRAPH_FILES.tiles), 'tiles of another build');
    expect(() => loadConfiguredDeadEndMask('live', environment(directory, graphId))).toThrow(
      /tile archive Valhalla serves is not graph/,
    );
    rmSync(join(directory, SERVING_GRAPH_FILES.tiles));
    expect(() => loadConfiguredDeadEndMask('live', environment(directory, graphId))).toThrow(
      /no readable connected\.tar/,
    );
  });

  it('refuses a Valhalla configuration that could serve other tiles', () => {
    const serving = (change: (mjolnir: Record<string, string>) => void) => {
      const { directory, graphId } = graphDirectory();
      const path = join(directory, SERVING_GRAPH_FILES.config);
      const config = JSON.parse(readFileSync(path, 'utf8')) as { mjolnir: Record<string, string> };
      change(config.mjolnir);
      writeFileSync(path, JSON.stringify(config));
      return () => loadConfiguredDeadEndMask('live', environment(directory, graphId));
    };
    // The scripted image's own archive name beside the verified one.
    expect(
      serving((mjolnir) => (mjolnir.tile_extract = '/custom_files/valhalla_tiles.tar')),
    ).toThrow(/serves \/custom_files\/valhalla_tiles\.tar, not the verified/);
    // A tile directory that exists is a fallback when the archive fails to load.
    expect(serving((mjolnir) => (mjolnir.tile_dir = root))).toThrow(/tile source other/);
    expect(serving((mjolnir) => (mjolnir.tile_url = 'https://tiles.example/{tilePath}'))).toThrow(
      /tile source other/,
    );
    // Any other edit no longer matches the configuration the graph was built with.
    expect(serving((mjolnir) => (mjolnir.concurrency = '8'))).toThrow(
      /not the one the serving graph/,
    );
  });

  it('refuses missing or unsupported provenance, and a mask from another extract or build', () => {
    const { directory, graphId } = graphDirectory();
    const provenancePath = join(directory, SERVING_GRAPH_FILES.provenance);
    const provenanceText = readFileSync(provenancePath, 'utf8');
    const provenance = JSON.parse(provenanceText) as ServingGraphProvenance;
    const load = () => loadConfiguredDeadEndMask('live', environment(directory, graphId));
    rmSync(provenancePath);
    expect(load).toThrow(/no readable provenance\.json/);
    writeFileSync(provenancePath, JSON.stringify({ ...provenance, routingEngineVersion: '3.9.1' }));
    expect(load).toThrow(/provenance\.json failed validation/);
    writeFileSync(provenancePath, JSON.stringify({ ...provenance, formatVersion: 2 }));
    expect(load).toThrow(/provenance\.json failed validation/);
    // A provenance record whose checksum list does not contain the extract it names.
    writeFileSync(
      provenancePath,
      JSON.stringify({ ...provenance, input: { ...provenance.input, sha256sums: 'x' } }),
    );
    expect(load).toThrow(/disagrees with its input checksums/);
    // Another provenance record for the same archive (a different extract claimed afterwards):
    // the mask was bound to the original record and refuses it.
    const other = { ...provenance, input: { ...provenance.input, pbfSha256: 'e'.repeat(64) } };
    other.input.sha256sums = `${other.input.pbfSha256}  ${PBF}\n`;
    writeFileSync(provenancePath, JSON.stringify(other));
    expect(load).toThrow(/another extract or graph build/);
    // The same extract with a different provenance record (another builder claimed afterwards):
    // the mask is bound to the record it was built against.
    writeFileSync(
      provenancePath,
      JSON.stringify({
        ...provenance,
        builder: { ...provenance.builder, imageId: `sha256:${'9'.repeat(64)}` },
      }),
    );
    expect(load).toThrow(/another extract or graph build/);
    writeFileSync(provenancePath, provenanceText);
    expect(load()?.identity.graphId).toBe(graphId);
    // Missing and version-1 masks.
    const maskPath = join(directory, SERVING_GRAPH_FILES.mask);
    const maskText = readFileSync(maskPath, 'utf8');
    rmSync(maskPath);
    expect(load).toThrow(/could not be read/);
    writeFileSync(maskPath, JSON.stringify({ ...JSON.parse(maskText), formatVersion: 1 }));
    expect(load).toThrow(/format version 1/);
  });

  it('accepts a replaced graph only when the archive, manifests, mask and configured id all move together', () => {
    const before = graphDirectory('tiles of the 2026-11-11 graph');
    expect(
      loadConfiguredDeadEndMask('live', environment(before.directory, before.graphId)),
    ).toBeDefined();
    // The directory is replaced wholesale by a coherent new build; the operator has not yet
    // changed the configured id, so the stack refuses to publish.
    const after = writeServingGraph(before.directory, 'tiles of the 2026-12-02 graph');
    expect(after).not.toBe(before.graphId);
    expect(() =>
      loadConfiguredDeadEndMask('live', environment(before.directory, before.graphId)),
    ).toThrow(/not the configured graph/);
    expect(
      loadConfiguredDeadEndMask('live', environment(before.directory, after))?.identity.graphId,
    ).toBe(after);
    // The new archive with the old mask (a partial replacement) is refused.
    const old = graphDirectory('tiles of the 2026-11-11 graph');
    const oldMask = readFileSync(join(old.directory, SERVING_GRAPH_FILES.mask), 'utf8');
    writeFileSync(join(before.directory, SERVING_GRAPH_FILES.mask), oldMask);
    expect(() => loadConfiguredDeadEndMask('live', environment(before.directory, after))).toThrow(
      /built for graph/,
    );
  });
});

describe('dead-end mask in the matcher', () => {
  // A batch recorded from Valhalla 3.8.2 on the Alberta/BC graph (whole and partly matched edges).
  const crawl = JSON.parse(
    readFileSync(new URL('./fixtures/valhalla-crawl-calgary.json', import.meta.url), 'utf8'),
  ) as {
    locateResponse: unknown;
    points: TrafficProbeBatchRequest['points'];
    traceResponse: unknown;
  };
  const points = trimBatchEnds(crawl.points, 100);
  const locateBodies: string[] = [];
  const matcher = (deadEndMask?: DeadEndMask) =>
    createValhallaMapMatcher({
      ...(deadEndMask === undefined ? {} : { deadEndMask }),
      endpoint: 'http://valhalla.test/trace_attributes',
      fetchImplementation: (input, init) => {
        if (requestUrl(input).endsWith('/locate'))
          locateBodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          Response.json(
            requestUrl(input).endsWith('/locate') ? crawl.locateResponse : crawl.traceResponse,
          ),
        );
      },
    });

  it('publishes an edge only when the mask places its whole map geometry on the main network', async () => {
    const plain = await matcher().matchTrace(points);
    const open = (plain?.edges ?? []).filter((edge) => edge.openThroughRoad === true);
    const whole = open.find((edge) => edge.segmentKey !== undefined);
    const partial = open.find((edge) => edge.wholeEdge !== undefined);
    expect(whole).toBeDefined();
    expect(partial).toBeDefined();
    if (whole === undefined || partial === undefined) return;
    const otherWays = [...new Set(open.map((edge) => edge.wayId))].filter(
      (wayId) => wayId !== whole.wayId && wayId !== partial.wayId,
    );
    const statuses = async (ways: Partial<DeadEndMaskWays>) => {
      const mask = parseDeadEndMask(JSON.stringify(maskFile(ways)), { graphId: GRAPH });
      const matched = await matcher(mask).matchTrace(points);
      return (matched?.edges ?? []).filter((edge) => isAggregatedRoad(edge));
    };
    const sorted = (values: number[]) => [...values].sort((left, right) => left - right);
    // Everything on the main network: the mask changes nothing.
    const allEligible = await statuses({
      eligible: sorted([whole.wayId, partial.wayId, ...otherWays]),
    });
    expect(allEligible.filter((edge) => edge.openThroughRoad === true)).toHaveLength(open.length);

    // The whole edge's way excluded; the partly matched edge's way crosses the boundary just
    // after its whole edge, so its whole geometry decides.
    const partialLine = partial.wholeEdge?.line ?? partial.line;
    const forwardLine = partial.forward ? partialLine : [...partialLine].reverse();
    const extended: Position[] = [...forwardLine, [forwardLine.at(-1)?.[0] ?? 0, 51.5]];
    const crossing = await statuses({
      eligible: sorted(otherWays),
      excluded: [whole.wayId],
      mixed: [mixedWay(partial.wayId, extended, `${'e'.repeat(forwardLine.length - 1)}x`)],
    });
    for (const edge of crossing) {
      if (edge.wayId === whole.wayId) expect(edge.openThroughRoad).toBe(false);
      if (edge.wayId === partial.wayId && edge.wholeEdge !== undefined) {
        expect(edge.openThroughRoad).toBe(true);
      }
    }
    const inside = await statuses({
      eligible: sorted(otherWays),
      excluded: [whole.wayId],
      mixed: [mixedWay(partial.wayId, extended, `x${'e'.repeat(forwardLine.length - 1)}`)],
    });
    expect(
      inside.find((edge) => edge.wayId === partial.wayId && edge.wholeEdge)?.openThroughRoad,
    ).toBe(false);
    // Unknown continuation (a region that leaves the extract, as BC 37A does into Yukon and
    // Hyder) is refused exactly like a proven dead end.
    const unknown = await statuses({
      eligible: sorted([partial.wayId, ...otherWays]),
      unknown: [whole.wayId],
    });
    expect(unknown.filter((edge) => edge.wayId === whole.wayId).length).toBeGreaterThan(0);
    for (const edge of unknown) {
      expect(edge.openThroughRoad).toBe(edge.wayId !== whole.wayId);
    }
    // A way the mask does not list is never published.
    const unlisted = await statuses({ eligible: sorted(otherWays) });
    expect(
      unlisted.filter((edge) => edge.openThroughRoad === true).map((edge) => edge.wayId),
    ).not.toContain(whole.wayId);
    // The mask adds no request content: `/locate` carries the same map midpoints with or without it.
    expect(new Set(locateBodies).size).toBe(1);
  });
});
