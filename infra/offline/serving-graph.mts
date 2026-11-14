/**
 * Builds the Valhalla 3.8.2 graph the online stack serves when community traffic may publish,
 * from a checksum-verified dated extract, and records how it was built:
 *
 *   node --import tsx infra/offline/serving-graph.mts \
 *     --inputs artifacts/offline/inputs/261111 --output artifacts/serving-graph
 *
 * Output `<output>/<graph id>/` holds only what is served and checked:
 *
 * - `connected.tar`: the canonical tile archive (its SHA-256 is the graph id);
 * - `valhalla-serving.json`: the build's Valhalla configuration with `tile_extract` set to
 *   `/graph/connected.tar` and no other tile source;
 * - `graph.json`: graph id, engine version, data date, speed profile;
 * - `provenance.json`: the extract (name, SHA-256, the whole `SHA256SUMS`), the pinned engine
 *   image, the builder image and Dockerfile, the build scripts and the serving configuration's
 *   SHA-256.
 *
 * The provenance record is written by the build that produced the archive, after re-hashing the
 * extract, so it binds that extract to that graph id. It is integrity data, not a signature.
 * The steps are the offline pipeline's (`build.mts`) with the 3.8.2 engine the online stack runs.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { DEAD_END_MASK_ROUTING_ENGINE_VERSION } from '../../apps/api/src/traffic/dead-end-mask.js';
import {
  SERVING_GRAPH_FILES,
  SERVING_GRAPH_PROVENANCE_FORMAT,
  ServingGraphProvenanceSchema,
  verifyServingGraph,
  type ServingGraphProvenance,
} from '../../apps/api/src/traffic/serving-graph.js';
import { verifiedInputs } from './dead-end-mask.mjs';
import pin from './routing-engine.lock.json' with { type: 'json' };
import { sha256File } from './tools.mjs';

const exec = promisify(execFile);
const scripts = resolve(import.meta.dirname);
const repo = resolve(scripts, '../..');

export async function buildServingGraph(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      inputs: { type: 'string' },
      output: { type: 'string', default: 'artifacts/serving-graph' },
    },
    strict: true,
  });
  if (!values.inputs) {
    throw new Error('usage: serving-graph.mts --inputs <inputs/YYMMDD> [--output <dir>]');
  }
  const engineImage = pin.configurationImage;
  if (
    pin.configurationEngineVersion !== DEAD_END_MASK_ROUTING_ENGINE_VERSION ||
    !/^ghcr\.io\/valhalla\/valhalla-scripted:3\.8\.2@sha256:[0-9a-f]{64}$/.test(engineImage)
  ) {
    throw new Error('routing-engine.lock.json does not pin the Valhalla 3.8.2 serving engine');
  }
  const inputs = resolve(values.inputs);
  const output = resolve(values.output ?? 'artifacts/serving-graph');
  const input = await verifiedInputs(inputs);

  const dockerfileSha256 = await sha256File(join(scripts, 'Dockerfile'));
  const key = createHash('sha256')
    .update(JSON.stringify({ dockerfileSha256, engineImage }))
    .digest('hex');
  const image = `navoss-offline-builder:serving-${key.slice(0, 12)}`;
  const present = await exec('docker', ['image', 'inspect', image]).then(
    () => true,
    () => false,
  );
  if (!present) {
    await exec(
      'docker',
      [
        'build',
        '--build-arg',
        `VALHALLA_IMAGE=${engineImage}`,
        '-t',
        image,
        '-f',
        join(scripts, 'Dockerfile'),
        scripts,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  }
  const imageId = (
    await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
  ).stdout.trim();
  const engineVersion = (
    await exec('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      image,
      'valhalla_service',
      '--version',
    ])
  ).stdout.trim();
  if (engineVersion !== DEAD_END_MASK_ROUTING_ENGINE_VERSION) {
    throw new Error(`The serving builder runs Valhalla ${engineVersion}`);
  }

  await mkdir(join(output, '.work'), { recursive: true });
  const stage = await mkdtemp(join(output, '.work', 'graph-'));
  const sources = join(output, 'sources');
  await mkdir(sources, { recursive: true });
  const { uid, gid } = userInfo();
  const docker = (command: string[], network = false) =>
    exec(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        network ? 'bridge' : 'none',
        '--cpus',
        '2',
        '--memory',
        '3g',
        '--user',
        `${String(uid)}:${String(gid)}`,
        '--env',
        'HOME=/tmp',
        '--volume',
        `${inputs}:/inputs:ro`,
        '--volume',
        `${scripts}:/scripts:ro`,
        '--volume',
        `${sources}:/sources`,
        '--volume',
        `${stage}:/graph`,
        image,
        ...command,
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
  try {
    const pbf = `/inputs/${input.name}`;
    await docker(
      ['bash', '/scripts/prepare-sources.sh', '/scripts/sources.lock.json', '/sources'],
      true,
    );
    await exec(join(repo, 'infra/compose/prepare-valhalla-speeds.sh'), [stage]);
    await docker(['bash', '/scripts/build-graph.sh', 'prepare', '/graph', pbf, '/sources']);
    await exec(join(repo, 'infra/compose/repair-valhalla-admins.sh'), [stage], {
      env: { ...process.env, VALHALLA_IMAGE: engineImage },
    });
    await docker(['bash', '/scripts/build-graph.sh', 'build', '/graph', pbf, '/sources']);
    const epoch = Math.floor(Date.parse(input.data.osmTimestamp) / 1000);
    await docker([
      'python3',
      '/scripts/assemble-routing.py',
      '--canonicalize',
      '--epoch',
      String(epoch),
      '--output',
      '/graph/connected.tar',
      '/graph/valhalla_tiles.tar',
    ]);

    const config = JSON.parse(await readFile(join(stage, 'valhalla.json'), 'utf8')) as {
      mjolnir: Record<string, unknown>;
    };
    config.mjolnir.tile_dir = '/nonexistent';
    config.mjolnir.tile_extract = `/graph/${SERVING_GRAPH_FILES.tiles}`;
    config.mjolnir.traffic_extract = '';
    const configText = JSON.stringify(config, null, 2) + '\n';
    const final = await mkdtemp(join(output, '.work', 'serving-'));
    await rename(join(stage, 'connected.tar'), join(final, SERVING_GRAPH_FILES.tiles));
    await writeFile(join(final, SERVING_GRAPH_FILES.config), configText);
    const graphId = await sha256File(join(final, SERVING_GRAPH_FILES.tiles));
    const graph = {
      dataDate: input.data.dataDate,
      graphId,
      routingEngineVersion: DEAD_END_MASK_ROUTING_ENGINE_VERSION,
      speedProfileSha256: await sha256File(join(stage, 'default_speeds.json')),
    };
    const provenance: ServingGraphProvenance = ServingGraphProvenanceSchema.parse({
      format: SERVING_GRAPH_PROVENANCE_FORMAT,
      formatVersion: 1,
      graphId,
      connectedTarBytes: (await stat(join(final, SERVING_GRAPH_FILES.tiles))).size,
      servingConfigSha256: createHash('sha256').update(configText).digest('hex'),
      routingEngineVersion: DEAD_END_MASK_ROUTING_ENGINE_VERSION,
      engineImage,
      builder: {
        dockerfileSha256,
        imageId,
        scriptsSha256: Object.fromEntries(
          await Promise.all(
            [
              'infra/offline/build-graph.sh',
              'infra/offline/assemble-routing.py',
              'infra/offline/serving-graph.mts',
              'infra/offline/sources.lock.json',
              'infra/compose/prepare-valhalla-speeds.sh',
              'infra/compose/repair-valhalla-admins.sh',
            ].map(async (path) => [path, await sha256File(join(repo, path))] as const),
          ),
        ),
      },
      input: {
        dataDate: input.data.dataDate,
        osmTimestamp: input.data.osmTimestamp,
        pbf: input.name,
        pbfSha256: input.sha256,
        sha256sums: await readFile(join(inputs, 'SHA256SUMS'), 'utf8'),
      },
    });
    await writeFile(join(final, SERVING_GRAPH_FILES.graph), JSON.stringify(graph) + '\n');
    await writeFile(
      join(final, SERVING_GRAPH_FILES.provenance),
      JSON.stringify(provenance, null, 2) + '\n',
    );
    // The directory is checked exactly as the API checks it before it is published.
    verifyServingGraph(final, graphId, '/graph');
    const directory = join(output, graphId);
    await rm(directory, { recursive: true, force: true });
    await rename(final, directory);
    console.log(JSON.stringify({ directory, graphId, provenance }, null, 2));
    return { directory, graphId };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildServingGraph(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Serving graph build failed');
    process.exitCode = 1;
  });
}
